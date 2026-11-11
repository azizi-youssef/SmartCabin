import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { APPOINTMENT_STATUSES } from '@/modules/appointments/domain/status';

import { actAs, asPostgres, asUser, createPool, failure, one, withRollback, type Db } from './helpers/db';
import { createWorld, localInstant, type World } from './helpers/fixtures';

/**
 * Module 6 — staff appointments (migration 0022): every staff transition against every status,
 * the appointment file (visit reason gated by appointments.view_reason), its history with staff
 * names, and command locking after authorization (audit SC-AUD-18).
 */
let pool: pg.Pool;
beforeAll(() => {
  pool = createPool(4);
});
afterAll(async () => {
  await pool.end();
});

async function scenario(fn: (db: Db, w: World) => Promise<void>): Promise<void> {
  await withRollback(pool, async (db) => fn(db, await createWorld(db)));
}

type Status = (typeof APPOINTMENT_STATUSES)[number];

/** Timestamps each status requires by the coherence constraints. */
const STATUS_FIELDS: Record<Status, string> = {
  pending: '',
  confirmed: ', confirmed_at',
  checked_in: ', confirmed_at, checked_in_at',
  in_progress: ', confirmed_at, checked_in_at, started_at',
  completed: ', confirmed_at, checked_in_at, started_at, completed_at',
  cancelled: ', cancelled_at',
  no_show: ', confirmed_at, no_show_at',
};

/** Inserts an appointment directly in a given status (fixture only: triggers bypassed as postgres). */
async function inStatus(db: Db, w: World, status: Status, startsAt: string, endsAt: string): Promise<{ id: string; version: number }> {
  await actAs(db, asPostgres);
  await db.query("set local session_replication_role = 'replica'");
  const extra = STATUS_FIELDS[status];
  const values = extra.split(',').filter(Boolean).map(() => 'now()').join(', ');
  const row = await one<{ id: string; version: number }>(db,
    `insert into public.appointments (clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, source, price_mad
       ${extra}${status === 'cancelled' ? ', cancellation_reason, cancellation_actor' : ''})
     values ($1, $2, $3, $4, $5, $6, $7, 'staff', 200 ${values ? `, ${values}` : ''}${status === 'cancelled' ? ", 'other', 'clinic'" : ''})
     returning id, version`,
    [w.clinicA, w.patientA1, w.doctorA1, w.serviceA, startsAt, endsAt, status]);
  await db.query("set local session_replication_role = 'origin'");
  return row;
}

describe('every staff transition against every status (BUSINESS_RULES §2.1)', () => {
  // Allowed source statuses per command; every other status must be refused.
  const ALLOWED: Record<string, readonly Status[]> = {
    confirm: ['pending'],
    cancel: ['pending', 'confirmed'],
    reschedule: ['pending', 'confirmed'],
    no_show: ['confirmed'],
  };

  it('succeeds exactly where the transition table allows, and leaves refused appointments unchanged', async () => {
    await scenario(async (db, w) => {
      const future = [await localInstant(db, w.day, '12:00'), await localInstant(db, w.day, '12:20')] as const;
      const target = await localInstant(db, w.day, '14:00');
      const pastStart = (await one<{ s: string; e: string }>(db,
        "select date_trunc('hour', now()) - interval '3 hours' as s, date_trunc('hour', now()) - interval '160 minutes' as e")) as { s: string; e: string };
      const outcomes: string[] = [];

      for (const command of Object.keys(ALLOWED)) {
        for (const status of APPOINTMENT_STATUSES) {
          await db.query('savepoint matrix');
          const [s, e] = command === 'no_show' ? [pastStart.s, pastStart.e] : future;
          const appt = await inStatus(db, w, status, s, e);
          await actAs(db, asUser(w.users.receptionA));
          const sql = {
            confirm: 'select status from public.confirm_appointment($1)',
            cancel: "select status from public.cancel_appointment($1, 'patient_request')",
            reschedule: 'select status from public.reschedule_appointment($1, $2)',
            no_show: 'select status from public.mark_no_show($1)',
          }[command] ?? '';
          const params = command === 'reschedule' ? [appt.id, target] : [appt.id];
          let result: string;
          try {
            await db.query('savepoint attempt');
            result = `ok:${(await one<{ status: string }>(db, sql, params)).status}`;
            await db.query('release savepoint attempt');
          } catch (error) {
            await db.query('rollback to savepoint attempt');
            result = (error as Error).message;
            await actAs(db, asPostgres);
            const after = await one<{ status: string; version: number }>(db, 'select status, version from public.appointments where id = $1', [appt.id]);
            expect(after, `${command} from ${status} must leave it unchanged`).toEqual({ status, version: appt.version });
          }
          const expected = ALLOWED[command]?.includes(status)
            ? `ok:${{ confirm: 'confirmed', cancel: 'cancelled', reschedule: status, no_show: 'no_show' }[command]}`
            : 'APPT_INVALID_TRANSITION';
          if (result !== expected) outcomes.push(`${command} from ${status}: expected ${expected}, got ${result}`);
          await db.query('rollback to savepoint matrix');
        }
      }
      expect(outcomes).toEqual([]);
    });
  });
});

describe('appointment file (get_appointment)', () => {
  const GET = 'select * from public.get_appointment($1)';

  it('returns the appointment with the visit reason only for appointments.view_reason', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const booked = await one<{ id: string }>(db, 'select id from public.book_appointment($1, $2, $3, $4, $5, false, null, $6)',
        [w.patientA1, w.doctorA1, w.serviceA, await localInstant(db, w.day, '11:00'), null, '  Contrôle annuel  ']);
      const full = await one<{ id: string; status: string; patient_reason: string | null; booked_by_name: string | null; price_mad: string }>(db, GET, [booked.id]);
      expect(full).toMatchObject({ id: booked.id, status: 'confirmed', patient_reason: 'Contrôle annuel', price_mad: '200.00' });
      expect(full.booked_by_name).toBeTruthy();

      // Without the permission (removed for this test), the reason is withheld, nothing else.
      await actAs(db, asPostgres);
      await db.query("delete from public.role_permissions where role = 'receptionist' and permission_key = 'appointments.view_reason'");
      await actAs(db, asUser(w.users.receptionA));
      const masked = await one<{ id: string; patient_reason: string | null }>(db, GET, [booked.id]);
      expect(masked).toMatchObject({ id: booked.id, patient_reason: null });
    });
  });

  it('never lets the table itself reveal the visit reason, and follows the appointment scope', async () => {
    await scenario(async (db, w) => {
      for (const user of [w.users.ownerA, w.users.receptionA, w.users.doctorA]) {
        await actAs(db, asUser(user));
        expect((await failure(db, 'select patient_reason from public.appointments limit 1')).code).toBe('42501');
      }
      await actAs(db, asUser(w.users.doctorA)); // practitioner-only, linked to doctorA2
      expect((await failure(db, GET, [w.apptA2])).message).toBe('NOT_FOUND');
      expect((await one<{ id: string }>(db, GET, [w.apptA1])).id).toBe(w.apptA1);
      await actAs(db, asUser(w.users.ownerB));
      expect((await failure(db, GET, [w.apptA1])).message).toBe('NOT_FOUND');
      await actAs(db, asUser(w.users.accountantA));
      expect((await failure(db, GET, [w.apptA1])).message).toBe('FORBIDDEN');
    });
  });

  it('keeps command results safe: every role that can write appointments may also see the reason', async () => {
    // Commands return the full appointment row (including patient_reason) to their caller.
    await scenario(async (db) => {
      await actAs(db, asPostgres);
      const leaks = (await db.query<{ role: string; permission_key: string }>(
        `select rp.role::text, rp.permission_key from public.role_permissions rp
         where rp.permission_key in ('appointments.book', 'appointments.confirm', 'appointments.reschedule', 'appointments.cancel',
                                 'appointments.overbook', 'appointments.mark_no_show', 'appointments.correct_status')
           and not exists (select 1 from public.role_permissions v
                           where v.role = rp.role and v.permission_key = 'appointments.view_reason')`)).rows;
      expect(leaks).toEqual([]);
    });
  });
});

describe('appointment history (list_appointment_history)', () => {
  interface Event {
    event_type: string;
    from_status: string | null;
    to_status: string | null;
    previous_starts_at: string | null;
    new_starts_at: string | null;
    actor_type: string;
    actor_name: string | null;
    reason: string | null;
  }
  const HISTORY = 'select * from public.list_appointment_history($1)';

  it('lists events in order, with old and new times and the names of clinic staff', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      await db.query("update public.user_profiles set full_name = 'Rania Accueil' where id = $1", [w.users.receptionA]);
      await db.query("update public.user_profiles set full_name = 'Adam Admin' where id = $1", [w.users.adminA]);
      const nine = await localInstant(db, w.day, '10:00');
      const eleven = await localInstant(db, w.day, '11:00');

      await actAs(db, asUser(w.users.receptionA));
      const appt = await one<{ id: string }>(db, 'select id from public.book_appointment($1, $2, $3, $4)', [w.patientA1, w.doctorA1, w.serviceA, nine]);
      await actAs(db, asUser(w.users.adminA));
      await db.query('select public.reschedule_appointment($1, $2)', [appt.id, eleven]);
      await db.query("select public.cancel_appointment($1, 'patient_request', 'Appel du patient')", [appt.id]);

      await actAs(db, asUser(w.users.receptionA));
      const events = (await db.query<Event>(HISTORY, [appt.id])).rows;
      expect(events.map((e) => [e.event_type, e.actor_type, e.actor_name])).toEqual([
        ['created', 'user', 'Rania Accueil'],
        ['rescheduled', 'user', 'Adam Admin'],
        ['status_changed', 'user', 'Adam Admin'],
      ]);
      expect(events[1]).toMatchObject({ previous_starts_at: nine, new_starts_at: eleven });
      expect(events[2]).toMatchObject({ from_status: 'confirmed', to_status: 'cancelled', reason: 'Appel du patient' });
    });
  });

  it('follows the appointment scope', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.doctorA));
      expect((await failure(db, HISTORY, [w.apptA2])).message).toBe('NOT_FOUND');
      await actAs(db, asUser(w.users.ownerB));
      expect((await failure(db, HISTORY, [w.apptA1])).message).toBe('NOT_FOUND');
      await actAs(db, asUser(w.users.accountantA));
      expect((await failure(db, HISTORY, [w.apptA1])).message).toBe('FORBIDDEN');
    });
  });
});

describe('command locking after authorization (audit SC-AUD-18)', () => {
  it('answers a caller from another clinic at once, even while the appointment is locked', async () => {
    const setup = await pool.connect();
    let w: World;
    try {
      await setup.query('begin');
      w = await createWorld(setup);
      await setup.query('commit');
    } finally {
      setup.release();
    }
    const holder = await pool.connect();
    const outsider = await pool.connect();
    try {
      // A legitimate command holds the row lock in an open transaction.
      await holder.query('begin');
      await actAs(holder, asUser(w.users.receptionA));
      await holder.query('select public.reschedule_appointment($1, $2)', [w.apptA2, await localInstant(holder, w.day, '15:00')]);

      // A user of clinic B must not wait on (or hold) that lock: NOT_FOUND immediately.
      await outsider.query('begin');
      await actAs(outsider, asUser(w.users.ownerB));
      await outsider.query("set local lock_timeout = '500ms'");
      const outcome = await outsider.query('select public.confirm_appointment($1)', [w.apptA2]).then(
        () => 'ok',
        (error: { message: string }) => error.message,
      );
      expect(outcome).toBe('NOT_FOUND');
    } finally {
      await outsider.query('rollback').catch(() => undefined);
      await holder.query('rollback').catch(() => undefined);
      outsider.release();
      holder.release();
    }
  });
});
