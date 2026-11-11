import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { actAs, asPostgres, asUser, createPool, withRollback, type Db } from './helpers/db';
import { createWorld, type World } from './helpers/fixtures';

/**
 * Query performance probe on synthetic volume (quality audit, 2026-11-11).
 *
 * Inside one rolled-back transaction: 30 000 patients and ~17 500 appointments per clinic
 * (two clinics, so tenant filtering is exercised), then EXPLAIN ANALYZE of the queries the
 * screens run, as the clinic A receptionist with RLS active. Budgets are deliberately loose:
 * they catch plan regressions (e.g. a per-row RLS function call), not machine speed.
 */
const PATIENTS_PER_CLINIC = 30_000;
const DAYS = 365;
const BUDGET_MS = 1_000;

let pool: pg.Pool;
beforeAll(() => {
  pool = createPool(2);
});
afterAll(async () => {
  await pool.end();
});

interface Plan {
  ms: number;
  text: string;
}

async function explain(db: Db, sql: string, params: unknown[]): Promise<Plan> {
  const rows = (await db.query<{ 'QUERY PLAN': string }>(`explain (analyze, buffers off, costs off) ${sql}`, params)).rows;
  const text = rows.map((r) => r['QUERY PLAN']).join('\n');
  const ms = Number(/Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? Number.NaN);
  return { ms, text };
}

async function seedVolume(db: Db, w: World): Promise<void> {
  await actAs(db, asPostgres);
  await db.query("set local session_replication_role = 'replica'"); // bulk load: skip audit/history triggers
  for (const clinic of [w.clinicA, w.clinicB]) {
    await db.query(
      `insert into public.patients (clinic_id, file_number, first_name, last_name, phone_e164, date_of_birth)
       select $1, 'V-' || i, 'Prenom' || (i % 997), 'Nom' || i, '+9997' || lpad(i::text, 8, '0'),
              date '1950-01-01' + (i % 25000)
       from generate_series(1, $2::int) as i`,
      [clinic, PATIENTS_PER_CLINIC]);
  }
  // One appointment every 20 minutes, 08:00-16:00, for a year ending on the test day.
  for (const [clinic, doctor, service] of [[w.clinicA, w.doctorA1, w.serviceA], [w.clinicB, w.doctorB1, w.serviceB]] as const) {
    await db.query(
      `insert into public.appointments (clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, source, price_mad)
       select $1, p.id, $2, $3, s, s + interval '20 minutes', 'pending', 'staff', 200
       from (select (($4::date - d) + time '08:00' + make_interval(mins => 20 * k)) at time zone 'Africa/Casablanca' as s,
                    row_number() over () as n
             from generate_series(1, $5::int) as d, generate_series(0, 23) as k) slots
       join (select id, row_number() over () as n from public.patients where clinic_id = $1 and file_number like 'V-%') p
         on p.n = slots.n`,
      [clinic, doctor, service, w.day, DAYS]);
  }
  await db.query("set local session_replication_role = 'origin'");
  await db.query('analyze public.patients');
  await db.query('analyze public.appointments');
}

describe('query plans on synthetic volume', () => {
  it('keeps the screen queries within budget with RLS active', async () => {
    await withRollback(pool, async (db) => {
      const w = await createWorld(db);
      await seedVolume(db, w);

      await actAs(db, asUser(w.users.receptionA));
      const term = '%nom1234%';
      const search = await explain(db,
        `select id, file_number, first_name, last_name from public.patients
         where clinic_id = $1 and status <> 'merged'
           and (first_name ilike $2 or last_name ilike $2 or first_name_ar ilike $2 or last_name_ar ilike $2 or file_number ilike $2)
         order by last_name, first_name limit 51`, [w.clinicA, term]);

      const dayStart = `${w.day}T00:00:00Z`;
      const agenda = await explain(db,
        `select a.id, a.starts_at, a.status, p.first_name, p.last_name
         from public.appointments a left join public.patients p on p.clinic_id = a.clinic_id and p.id = a.patient_id
         where a.clinic_id = $1 and a.starts_at >= $2::timestamptz - interval '30 days' and a.starts_at < $2::timestamptz - interval '29 days'
         order by a.starts_at limit 500`, [w.clinicA, dayStart]);

      const patientHistory = await explain(db,
        `select id, starts_at, status from public.appointments
         where clinic_id = $1 and patient_id = (select id from public.patients where clinic_id = $1 and file_number = 'V-77')
         order by starts_at desc limit 50`, [w.clinicA]);

      for (const [name, plan] of Object.entries({ search, agenda, patientHistory })) {
        expect(plan.ms, `${name}: ${plan.ms} ms`).toBeLessThan(BUDGET_MS);
      }
      // The agenda must use the (clinic_id, starts_at) index, not scan every appointment.
      expect(agenda.text).toMatch(/Index (Only )?Scan.*appointments_clinic_start_idx/);
      // RLS helpers run once per statement (hashed InitPlan/SubPlan), never once per row.
      expect(search.text).toMatch(/hashed SubPlan/);
    });
  });

  /**
   * AUDIT FINDING SC-AUD-02 (HIGH), fixed by migration 0021: the overlap search in
   * get_available_slots used to re-read ALL of the doctor's appointments for every candidate slot
   * (seconds for one year of history). It is now bounded to `starts_at in (slot_start - 480 min,
   * slot_end)`, 480 minutes being the maximum duration enforced by appointments_duration.
   */
  it('lists one week of free slots within budget when the doctor has a year of history', async () => {
    await withRollback(pool, async (db) => {
      const w = await createWorld(db);
      await seedVolume(db, w);
      await actAs(db, asUser(w.users.receptionA));
      const slots = await explain(db,
        'select * from public.get_available_slots($1, $2, $3::date, $3::date + 6)', [w.doctorA1, w.serviceA, w.day]);
      expect(slots.ms, `slots: ${slots.ms} ms`).toBeLessThan(BUDGET_MS);
    });
  });
});
