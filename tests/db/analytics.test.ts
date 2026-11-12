import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { actAs, asPostgres, asUser, createPool, failure, one, withRollback, type Db } from './helpers/db';
import { createWorld, localInstant, type World } from './helpers/fixtures';

/**
 * Module 11 — analytics (migration 0028): K1–K6 and K8 (BUSINESS_RULES §8) matched to a fixture
 * computed by hand, local days in the clinic's time zone, and the scope of each role
 * (RBAC §3.7: owner and admin everything, a doctor their own agendas, others nothing).
 */
let pool: pg.Pool;
beforeAll(() => {
  pool = createPool(2);
});
afterAll(async () => {
  await pool.end();
});

type Outcome = 'confirmed' | 'completed' | 'no_show' | 'cancelled' | 'left';

interface Visit {
  doctor: string;
  service: string;
  at: string;
  minutes: number;
  outcome: Outcome;
  source?: 'staff' | 'online' | 'walk_in';
  checkedIn?: string;
  started?: string;
  completed?: string;
  actor?: 'patient' | 'clinic' | 'system';
  reason?: string;
  day?: string;
}

/** Inserts an appointment and walks it through allowed transitions to its final state (as postgres). */
async function visit(db: Db, w: World, v: Visit): Promise<void> {
  await actAs(db, asPostgres);
  const day = v.day ?? w.day;
  const at = (time?: string) => (time ? localInstant(db, day, time) : Promise.resolve(null));
  const start = await localInstant(db, day, v.at);
  const arrivesFirst = v.outcome === 'completed' || v.outcome === 'left';
  const { id } = await one<{ id: string }>(db,
    `insert into public.appointments (clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, source, price_mad, confirmed_at, checked_in_at)
     values ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz + make_interval(mins => $6), $7, $8, 200, now(), $9)
     returning id`,
    [w.clinicA, w.patientA1, v.doctor, v.service, start, v.minutes, arrivesFirst ? 'checked_in' : 'confirmed', v.source ?? 'staff', arrivesFirst ? await at(v.checkedIn) : null]);
  if (v.outcome === 'completed') {
    await db.query("update public.appointments set status = 'in_progress', started_at = $2 where id = $1", [id, await at(v.started)]);
    await db.query("update public.appointments set status = 'completed', completed_at = $2 where id = $1", [id, await at(v.completed)]);
  } else if (v.outcome === 'no_show') {
    await db.query("update public.appointments set status = 'no_show', no_show_at = now() where id = $1", [id]);
  } else if (v.outcome === 'cancelled' || v.outcome === 'left') {
    await db.query(
      "update public.appointments set status = 'cancelled', cancelled_at = now(), cancellation_actor = $2, cancellation_reason = $3 where id = $1",
      [id, v.actor ?? 'patient', v.outcome === 'left' ? 'left_before_consultation' : (v.reason ?? 'patient_request')]);
  }
}

/**
 * The fixture day (a Monday, 08:00–18:00 for every doctor; doctor A1 off 16:00–18:00), on top of
 * the world's two confirmed 09:00 appointments (A1 and A2, 20 minutes each). Expected values:
 *   doctor A1 — 8 appointments; completed 3 (2 scheduled + 1 walk-in); no-show 1; cancelled 2
 *     (patient 1, clinic 1); left 1; K4 1/4; waits 5, 10, 12; booked 100; actual 55; available 480.
 *   doctor A2 — 2 appointments; completed 1 (wait 0: started on time, arrived early); booked 50;
 *     actual 30; available 600.
 */
async function fixtureDay(db: Db, w: World): Promise<void> {
  const a1 = { doctor: w.doctorA1, service: w.serviceA, minutes: 20 };
  await visit(db, w, { ...a1, at: '10:00', outcome: 'completed', checkedIn: '09:50', started: '10:05', completed: '10:25' });
  await visit(db, w, { ...a1, at: '10:20', outcome: 'completed', source: 'online', checkedIn: '10:30', started: '10:40', completed: '10:55' });
  await visit(db, w, { ...a1, at: '10:40', outcome: 'no_show' });
  await visit(db, w, { ...a1, at: '11:00', outcome: 'cancelled', actor: 'patient' });
  await visit(db, w, { ...a1, at: '11:20', outcome: 'left', checkedIn: '11:15' });
  await visit(db, w, { ...a1, at: '11:40', outcome: 'completed', source: 'walk_in', checkedIn: '11:38', started: '11:50', completed: '12:10' });
  await visit(db, w, { ...a1, at: '12:20', outcome: 'cancelled', actor: 'clinic', reason: 'clinic_request' });
  await visit(db, w, { doctor: w.doctorA2, service: w.serviceA2, minutes: 30, at: '14:00', outcome: 'completed', checkedIn: '13:55', started: '14:00', completed: '14:30' });
}

interface Kpi {
  group_key: string;
  appointments: number;
  by_status: Record<string, number>;
  by_source: Record<string, number>;
  completed: number;
  cancelled: number;
  cancelled_by_patient: number;
  cancelled_by_clinic: number;
  cancelled_by_system: number;
  left_before_consultation: number;
  no_show: number;
  no_show_denominator: number;
  wait_count: number;
  wait_mean_minutes: string | null;
  wait_median_minutes: string | null;
  booked_minutes: number;
  available_minutes: number | null;
  actual_minutes: number;
}

async function kpi(db: Db, who: string, w: World, from: string, to: string, group = 'total', doctor: string | null = null): Promise<Kpi[]> {
  await actAs(db, asUser(who));
  return (await db.query<Kpi>(
    `select group_key, appointments, by_status, by_source, completed, cancelled, cancelled_by_patient, cancelled_by_clinic,
            cancelled_by_system, left_before_consultation, no_show, no_show_denominator, wait_count,
            wait_mean_minutes::text, wait_median_minutes::text, booked_minutes, available_minutes, actual_minutes
     from public.kpi_operational($1, $2::date, $3::date, $4, $5)`, [w.clinicA, from, to, group, doctor])).rows;
}

async function addDays(db: Db, day: string, n: number): Promise<string> {
  return (await one<{ d: string }>(db, 'select ($1::date + $2::int)::text as d', [day, n])).d;
}

describe('operational KPIs (K1–K6, K8)', () => {
  it('computes every KPI of the period from the records, as computed by hand', async () => {
    await withRollback(pool, async (db) => {
      const w = await createWorld(db);
      await fixtureDay(db, w);
      const [total] = await kpi(db, w.users.ownerA, w, w.day, w.day);
      expect(total).toEqual({
        group_key: 'total',
        appointments: 10,
        by_status: { pending: 0, confirmed: 2, checked_in: 0, in_progress: 0, completed: 4, cancelled: 3, no_show: 1 },
        by_source: { staff: 8, online: 1, walk_in: 1 },
        completed: 4,
        cancelled: 2,
        cancelled_by_patient: 1,
        cancelled_by_clinic: 1,
        cancelled_by_system: 0,
        left_before_consultation: 1,
        no_show: 1,
        no_show_denominator: 5, // A1: 2 completed + 1 no-show + 1 left; A2: 1 completed (walk-ins excluded)
        wait_count: 4,
        wait_mean_minutes: '6.8', // (5 + 10 + 12 + 0) / 4 = 6.75
        wait_median_minutes: '7.5',
        booked_minutes: 150,
        available_minutes: 1080, // A1 600 − 120 time off, A2 600
        actual_minutes: 85,
      });
    });
  });

  it('groups by doctor, by service (K8, no availability) and by local day, skipping closed days', async () => {
    await withRollback(pool, async (db) => {
      const w = await createWorld(db);
      await fixtureDay(db, w);
      // 00:00 local on the next day: on the next local date (Casablanca is ahead of UTC).
      const next = await addDays(db, w.day, 1);
      await visit(db, w, { doctor: w.doctorA2, service: w.serviceA, minutes: 20, at: '00:00', outcome: 'confirmed', day: next });

      const doctors = await kpi(db, w.users.adminA, w, w.day, w.day, 'doctor');
      const byDoctor = Object.fromEntries(doctors.map((d) => [d.group_key, d]));
      expect(byDoctor[w.doctorA1]).toMatchObject({ appointments: 8, completed: 3, no_show: 1, no_show_denominator: 4, wait_count: 3,
        wait_mean_minutes: '9.0', wait_median_minutes: '10.0', booked_minutes: 100, available_minutes: 480, actual_minutes: 55 });
      expect(byDoctor[w.doctorA2]).toMatchObject({ appointments: 2, completed: 1, wait_median_minutes: '0.0', booked_minutes: 50, available_minutes: 600, actual_minutes: 30 });

      const services = await kpi(db, w.users.ownerA, w, w.day, w.day, 'service');
      expect(services.map((s) => [s.group_key, s.appointments, s.completed, s.available_minutes]).sort())
        .toEqual([[w.serviceA, 9, 3, null], [w.serviceA2, 1, 1, null]].sort());

      // Monday to Saturday: the Saturday (day + 5) is a clinic closure, so it has no availability.
      const saturday = await addDays(db, w.day, 5);
      const days = await kpi(db, w.users.ownerA, w, w.day, saturday, 'day');
      expect(days.map((d) => [d.group_key, d.appointments, d.available_minutes])).toEqual([
        [w.day, 10, 1080],
        [next, 1, 1200],
        [await addDays(db, w.day, 2), 0, 1200],
        [await addDays(db, w.day, 3), 0, 1200],
        [await addDays(db, w.day, 4), 0, 1200],
      ]);
    });
  });

  it("limits a doctor to their own agendas, and refuses everyone without analytics.operational", async () => {
    await withRollback(pool, async (db) => {
      const w = await createWorld(db);
      await fixtureDay(db, w);
      const sql = 'select * from public.kpi_operational($1, $2::date, $2::date, $3, $4)';

      // users.doctorA (DOCTOR role) is linked to doctor A2 only.
      const [own] = await kpi(db, w.users.doctorA, w, w.day, w.day);
      expect(own).toMatchObject({ appointments: 2, completed: 1, booked_minutes: 50, available_minutes: 600 });
      expect((await kpi(db, w.users.doctorA, w, w.day, w.day, 'doctor')).map((d) => d.group_key)).toEqual([w.doctorA2]);
      expect((await failure(db, sql, [w.clinicA, w.day, 'total', w.doctorA1])).message).toBe('NOT_FOUND');

      // The owner (also practitioner of A1) sees the whole clinic.
      expect((await kpi(db, w.users.ownerA, w, w.day, w.day, 'total', w.doctorA1))[0]).toMatchObject({ appointments: 8 });

      for (const who of [w.users.receptionA, w.users.accountantA]) {
        await actAs(db, asUser(who));
        expect((await failure(db, sql, [w.clinicA, w.day, 'total', null])).message).toBe('FORBIDDEN');
      }
      await actAs(db, asUser(w.users.ownerA, 'aal1'));
      expect((await failure(db, sql, [w.clinicA, w.day, 'total', null])).message).toBe('MFA_REQUIRED');
      for (const who of [w.users.ownerB, w.users.outsider, w.users.suspendedA, w.users.patientAccount]) {
        await actAs(db, asUser(who));
        expect((await failure(db, sql, [w.clinicA, w.day, 'total', null])).message, who).toBe('NOT_FOUND');
      }

      await actAs(db, asUser(w.users.ownerA));
      for (const [from, to, group] of [[w.day, '2000-01-01', 'total'], ['2000-01-01', '2001-06-01', 'total'], [w.day, w.day, 'patient']]) {
        expect((await failure(db, 'select * from public.kpi_operational($1, $2::date, $3::date, $4)', [w.clinicA, from, to, group])).message)
          .toBe('VALIDATION_FAILED');
      }
    });
  });

  it('answers zeros and no rate (not invented numbers) for a period without records', async () => {
    await withRollback(pool, async (db) => {
      const w = await createWorld(db);
      const sunday = await addDays(db, w.day, 6);
      const [total] = await kpi(db, w.users.ownerA, w, sunday, sunday);
      expect(total).toMatchObject({ appointments: 0, no_show_denominator: 0, wait_count: 0, wait_mean_minutes: null, available_minutes: 0 });
    });
  });
});
