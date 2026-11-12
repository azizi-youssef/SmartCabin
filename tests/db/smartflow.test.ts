import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { actAs, asPostgres, asUser, count, createPool, failure, one, withRollback, type Db } from './helpers/db';
import { createWorld, type World } from './helpers/fixtures';

/**
 * Module 8a — SmartFlow (migration 0024): calling, consultations, priority and reorder,
 * corrections A13/A14, the doctor's day, wait-time estimates v1, duration statistics.
 * Sessions are the clinic's local today; walk-ins provide checked-in patients.
 */
const TZ = 'Africa/Casablanca';
let pool: pg.Pool;
beforeAll(() => {
  pool = createPool(2);
});
afterAll(async () => {
  await pool.end();
});

async function scenario(fn: (db: Db, w: World) => Promise<void>): Promise<void> {
  await withRollback(pool, async (db) => fn(db, await createWorld(db)));
}

interface Ticket {
  appointment_id: string;
  queue_entry_id: string;
  ticket_number: number;
}

async function walkIn(db: Db, w: World, patient: string, doctor: string = w.doctorA1): Promise<Ticket> {
  await actAs(db, asUser(w.users.receptionA));
  return one<Ticket>(db, 'select * from public.register_walk_in($1, $2, $3)', [patient, doctor, doctor === w.doctorA2 ? w.serviceA2 : w.serviceA]);
}

async function sessionOf(db: Db, entry: string): Promise<string> {
  await actAs(db, asPostgres);
  return (await one<{ s: string }>(db, 'select session_id as s from public.queue_entries where id = $1', [entry])).s;
}

async function entry(db: Db, id: string): Promise<{ state: string; call_count: number; sort_key: string; priority_level: number; estimated_start_at: string | null }> {
  await actAs(db, asPostgres);
  return one(db, 'select state::text, call_count, sort_key::text, priority_level, estimated_start_at::text from public.queue_entries where id = $1', [id]);
}

async function appointmentStatus(db: Db, id: string): Promise<string> {
  await actAs(db, asPostgres);
  return (await one<{ status: string }>(db, 'select status::text from public.appointments where id = $1', [id])).status;
}

/** Same instant formatting as the database's timestamptz text output. */
async function at(db: Db, sql: string, params: unknown[] = []): Promise<string> {
  return (await one<{ t: string }>(db, `select (${sql})::text as t`, params)).t;
}

const CALL = 'select * from public.call_next($1)';

describe('calling and consultations (BR-Q-03, BR-Q-07, A10, A12)', () => {
  it('calls, starts and completes in queue order, one patient at a time', async () => {
    await scenario(async (db, w) => {
      const first = await walkIn(db, w, w.patientA1);
      const second = await walkIn(db, w, w.patientA2);
      const session = await sessionOf(db, first.queue_entry_id);

      await actAs(db, asUser(w.users.doctorA)); // the other doctor's agenda only
      expect((await failure(db, CALL, [session])).message).toBe('NOT_FOUND');
      await actAs(db, asUser(w.users.accountantA));
      expect((await failure(db, CALL, [session])).message).toBe('FORBIDDEN');

      await actAs(db, asUser(w.users.ownerA)); // practitioner of doctorA1
      expect(await one(db, CALL, [session])).toEqual({ queue_entry_id: first.queue_entry_id, ticket_number: 1 });
      expect(await entry(db, first.queue_entry_id)).toMatchObject({ state: 'called', call_count: 1 });

      await actAs(db, asUser(w.users.ownerA));
      await db.query('select public.start_consultation($1)', [first.queue_entry_id]);
      expect((await failure(db, 'select public.start_consultation($1)', [second.queue_entry_id])).message).toBe('DOCTOR_BUSY');
      expect(await appointmentStatus(db, first.appointment_id)).toBe('in_progress');
      expect(await one(db, 'select status::text, opened_at is not null as opened from public.doctor_sessions where id = $1', [session]))
        .toEqual({ status: 'open', opened: true });

      await actAs(db, asUser(w.users.ownerA));
      await db.query('select public.complete_consultation($1)', [first.queue_entry_id]);
      expect((await failure(db, 'select public.complete_consultation($1)', [first.queue_entry_id])).message).toBe('APPT_INVALID_TRANSITION');
      expect(await appointmentStatus(db, first.appointment_id)).toBe('completed');
      expect(await entry(db, first.queue_entry_id)).toMatchObject({ state: 'closed' });
      expect(await count(db, "select 1 from public.domain_events where aggregate_id = $1 and event_type = 'consultation.completed'", [first.appointment_id])).toBe(1);

      await actAs(db, asUser(w.users.ownerA));
      expect((await one<{ ticket_number: number }>(db, CALL, [session])).ticket_number).toBe(2);
      expect((await db.query(CALL, [session])).rowCount).toBe(0); // nobody left waiting
    });
  });

  it('puts a called patient who is not there back in their place, and serves priority first', async () => {
    await scenario(async (db, w) => {
      const a = await walkIn(db, w, w.patientA1);
      await walkIn(db, w, w.patientA2);
      const c = await walkIn(db, w, w.patientA1);
      const session = await sessionOf(db, a.queue_entry_id);

      await actAs(db, asUser(w.users.receptionA));
      expect((await one<{ queue_entry_id: string }>(db, CALL, [session])).queue_entry_id).toBe(a.queue_entry_id);
      await db.query('select public.recall_entry($1)', [a.queue_entry_id]);
      expect((await failure(db, 'select public.recall_entry($1)', [a.queue_entry_id])).message).toBe('APPT_INVALID_TRANSITION');
      await actAs(db, asUser(w.users.receptionA));
      expect((await one<{ queue_entry_id: string }>(db, CALL, [session])).queue_entry_id).toBe(a.queue_entry_id); // kept its place
      expect((await entry(db, a.queue_entry_id)).call_count).toBe(2);
      await actAs(db, asUser(w.users.receptionA));
      await db.query('select public.recall_entry($1)', [a.queue_entry_id]);

      // BR-Q-05: a person sets priority, with a reason; the system never does.
      expect((await failure(db, 'select public.set_queue_priority($1, 1::smallint, null)', [c.queue_entry_id])).message).toBe('VALIDATION_FAILED');
      await actAs(db, asUser(w.users.accountantA));
      expect((await failure(db, "select public.set_queue_priority($1, 1::smallint, 'elderly')", [c.queue_entry_id])).message).toBe('FORBIDDEN');
      await actAs(db, asUser(w.users.receptionA));
      await db.query("select public.set_queue_priority($1, 1::smallint, 'elderly')", [c.queue_entry_id]);
      expect((await one<{ queue_entry_id: string }>(db, CALL, [session])).queue_entry_id).toBe(c.queue_entry_id);
      await actAs(db, asPostgres);
      expect(await one(db, 'select priority_reason::text, priority_set_by = $2 as by_reception from public.queue_entries where id = $1',
        [c.queue_entry_id, w.users.receptionA])).toEqual({ priority_reason: 'elderly', by_reception: true });
      expect(await one(db, "select reason from public.queue_events where queue_entry_id = $1 and event_type = 'priority_changed'", [c.queue_entry_id]))
        .toEqual({ reason: 'elderly' });
    });
  });

  it('moves an entry before another one of the same level, with a reason (BR-Q-06)', async () => {
    await scenario(async (db, w) => {
      const [e1, e2, e3] = [await walkIn(db, w, w.patientA1), await walkIn(db, w, w.patientA2), await walkIn(db, w, w.patientA1)];
      const session = await sessionOf(db, e1.queue_entry_id);
      await actAs(db, asPostgres);
      for (const [id, key] of [[e1.queue_entry_id, 100], [e2.queue_entry_id, 200], [e3.queue_entry_id, 300]] as const) {
        await db.query('update public.queue_entries set sort_key = $2 where id = $1', [id, key]);
      }
      const order = async () => {
        await actAs(db, asPostgres);
        return (await db.query<{ ticket_number: number }>(
          `select ticket_number from public.queue_entries where session_id = $1 and state in ('waiting', 'called')
           order by priority_level desc, sort_key, ticket_number`, [session])).rows.map((r) => r.ticket_number);
      };
      const MOVE = 'select public.move_queue_entry_before($1, $2, $3)';

      await actAs(db, asUser(w.users.receptionA));
      expect((await failure(db, MOVE, [e3.queue_entry_id, e2.queue_entry_id, ''])).message).toBe('VALIDATION_FAILED');
      await db.query(MOVE, [e3.queue_entry_id, e2.queue_entry_id, 'Ordonnance à renouveler']);
      expect(await order()).toEqual([1, 3, 2]);
      expect(Number((await entry(db, e3.queue_entry_id)).sort_key)).toBe(150);
      await actAs(db, asUser(w.users.receptionA));
      await db.query(MOVE, [e3.queue_entry_id, e1.queue_entry_id, 'Ordonnance à renouveler']);
      expect(await order()).toEqual([3, 1, 2]);

      await actAs(db, asUser(w.users.receptionA));
      await db.query("select public.set_queue_priority($1, 1::smallint, 'pregnancy')", [e2.queue_entry_id]);
      expect((await failure(db, MOVE, [e1.queue_entry_id, e2.queue_entry_id, 'Mauvais niveau'])).message).toBe('VALIDATION_FAILED');
      await actAs(db, asUser(w.users.doctorA)); // another doctor's queue
      expect((await failure(db, MOVE, [e1.queue_entry_id, e3.queue_entry_id, 'Pas mon agenda'])).message).toBe('NOT_FOUND');
    });
  });
});

describe('audited corrections (A13, A14)', () => {
  const CORRECT = "select * from public.correct_appointment_status($1, 'checked_in', $2)";

  it('puts a consultation started by mistake back in the queue within 15 minutes (A13)', async () => {
    await scenario(async (db, w) => {
      const e = await walkIn(db, w, w.patientA1);
      const before = await entry(db, e.queue_entry_id);
      await actAs(db, asUser(w.users.ownerA));
      await db.query('select public.start_consultation($1)', [e.queue_entry_id]);

      await actAs(db, asUser(w.users.receptionA)); // owner and admin only
      expect((await failure(db, CORRECT, [e.appointment_id, 'Mauvais patient'])).message).toBe('FORBIDDEN');
      await actAs(db, asUser(w.users.adminA));
      expect((await failure(db, CORRECT, [e.appointment_id, 'x'])).message).toBe('VALIDATION_FAILED');
      expect((await one<{ queue_entry_id: string }>(db, CORRECT, [e.appointment_id, 'Mauvais patient appelé'])).queue_entry_id).toBe(e.queue_entry_id);
      expect(await appointmentStatus(db, e.appointment_id)).toBe('checked_in');
      expect(await entry(db, e.queue_entry_id)).toMatchObject({ state: 'waiting', sort_key: before.sort_key });
      expect(await one(db,
        "select reason from public.appointment_history where appointment_id = $1 and from_status = 'in_progress' and to_status = 'checked_in'",
        [e.appointment_id])).toEqual({ reason: 'Mauvais patient appelé' });

      await actAs(db, asUser(w.users.ownerA));
      await db.query('select public.start_consultation($1)', [e.queue_entry_id]);
      await actAs(db, asPostgres);
      await db.query("update public.appointments set started_at = now() - interval '20 minutes' where id = $1", [e.appointment_id]);
      await actAs(db, asUser(w.users.adminA));
      expect((await failure(db, CORRECT, [e.appointment_id, 'Trop tard'])).message).toBe('CORRECTION_WINDOW_PASSED');
    });
  });

  it('lets a late patient back in after a no-show the same day, with a new ticket (A14)', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      await db.query("set local session_replication_role = 'replica'");
      const absent = await one<{ id: string }>(db,
        `insert into public.appointments (clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, source, price_mad, confirmed_at, no_show_at)
         values ($1, $2, $3, $4, to_timestamp(floor(extract(epoch from now()) / 300) * 300),
                 to_timestamp(floor(extract(epoch from now()) / 300) * 300) + interval '20 minutes', 'no_show', 'staff', 200, now(), now())
         returning id`, [w.clinicA, w.patientA1, w.doctorA1, w.serviceA]);
      const otherDay = await one<{ id: string }>(db,
        `insert into public.appointments (clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, source, price_mad, confirmed_at, no_show_at)
         values ($1, $2, $3, $4, $5::date + time '12:00', $5::date + time '12:20', 'no_show', 'staff', 200, now(), now()) returning id`,
        [w.clinicA, w.patientA2, w.doctorA1, w.serviceA, w.day]);
      await db.query("set local session_replication_role = 'origin'");
      await walkIn(db, w, w.patientA2); // ticket 1 already taken today

      await actAs(db, asUser(w.users.adminA));
      expect((await failure(db, "select * from public.correct_appointment_status($1, 'completed', 'Erreur')", [absent.id])).message).toBe('APPT_INVALID_TRANSITION');
      expect((await failure(db, CORRECT, [otherDay.id, 'Arrivé en retard'])).message).toBe('CHECK_IN_NOT_TODAY');
      const back = await one<{ queue_entry_id: string; ticket_number: number }>(db, CORRECT, [absent.id, 'Arrivé en retard']);
      expect(back.ticket_number).toBe(2);
      await actAs(db, asPostgres);
      expect(await one(db, 'select status::text, no_show_at is null as cleared, checked_in_at is not null as arrived from public.appointments where id = $1', [absent.id]))
        .toEqual({ status: 'checked_in', cleared: true, arrived: true });
      const nowEpoch = await at(db, 'extract(epoch from now())');
      expect((await entry(db, back.queue_entry_id)).sort_key).toBe(nowEpoch); // queued at arrival time
    });
  });
});

describe("the doctor's day (§3.3)", () => {
  it('opens, pauses, resumes, reports a delay and closes, with the right guards', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.accountantA));
      expect((await failure(db, 'select public.open_doctor_day($1)', [w.doctorA2])).message).toBe('FORBIDDEN');
      await actAs(db, asUser(w.users.doctorA));
      expect((await failure(db, 'select public.open_doctor_day($1)', [w.doctorA1])).message).toBe('NOT_FOUND');
      const session = (await one<{ id: string }>(db, 'select public.open_doctor_day($1) as id', [w.doctorA2])).id;
      expect((await one<{ id: string }>(db, 'select public.open_doctor_day($1) as id', [w.doctorA2])).id).toBe(session); // idempotent

      await db.query('select public.pause_doctor_session($1)', [session]);
      expect((await failure(db, 'select public.pause_doctor_session($1)', [session])).message).toBe('SESSION_INVALID_TRANSITION');
      expect((await failure(db, CALL, [session])).message).toBe('SESSION_PAUSED');
      await db.query('select public.resume_doctor_session($1)', [session]);

      expect((await failure(db, 'select public.report_doctor_delay($1, 700)', [w.doctorA2])).message).toBe('VALIDATION_FAILED');
      await db.query('select public.report_doctor_delay($1, 30)', [w.doctorA2]);
      await actAs(db, asPostgres);
      expect(await one(db, 'select announced_delay_minutes, delay_reported_by = $2 as by_doctor from public.doctor_sessions where id = $1', [session, w.users.doctorA]))
        .toEqual({ announced_delay_minutes: 30, by_doctor: true });
      expect(await count(db, "select 1 from public.domain_events where aggregate_id = $1 and event_type = 'session.delay_reported'", [session])).toBe(1);

      const seen = await walkIn(db, w, w.patientA1, w.doctorA2);
      await walkIn(db, w, w.patientA2, w.doctorA2);
      await actAs(db, asUser(w.users.doctorA));
      await db.query('select public.start_consultation($1)', [seen.queue_entry_id]);
      expect((await failure(db, 'select public.close_doctor_session($1)', [session])).message).toBe('DOCTOR_BUSY');
      await db.query('select public.complete_consultation($1)', [seen.queue_entry_id]);
      expect((await one<{ open: number }>(db, 'select public.close_doctor_session($1) as open', [session])).open).toBe(1);
      expect((await failure(db, 'select public.close_doctor_session($1)', [session])).message).toBe('SESSION_INVALID_TRANSITION');
      await actAs(db, asUser(w.users.receptionA));
      expect((await failure(db, 'select * from public.register_walk_in($1, $2, $3)', [w.patientA1, w.doctorA2, w.serviceA2])).message).toBe('SESSION_CLOSED');
    });
  });
});

describe('wait-time estimates v1 (§3.2)', () => {
  it('recomputes estimates at commit from the doctor availability and the expected durations', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.ownerA));
      const session = (await one<{ id: string }>(db, 'select public.open_doctor_day($1) as id', [w.doctorA1])).id;
      const e1 = await walkIn(db, w, w.patientA1);
      const e2 = await walkIn(db, w, w.patientA2);
      // Deferred until commit in production; fired now for the test (only this trigger: the
      // queue/appointment consistency check must stay deferred inside commands).
      await db.query('set constraints public.doctor_sessions_recompute_estimates immediate');
      await db.query('set constraints public.doctor_sessions_recompute_estimates deferred');
      await actAs(db, asPostgres);
      // Open and idle: the first patient now, the next one 20 minutes (booked duration) later.
      expect((await entry(db, e1.queue_entry_id)).estimated_start_at).toBe(await at(db, 'now()'));
      expect((await entry(db, e2.queue_entry_id)).estimated_start_at).toBe(await at(db, "now() + interval '20 minutes'"));

      // In consultation for 15 minutes out of an expected 20: the next one in 5 minutes.
      await actAs(db, asUser(w.users.ownerA));
      await db.query('select public.start_consultation($1)', [e1.queue_entry_id]);
      await actAs(db, asPostgres);
      await db.query("update public.queue_entries set consultation_started_at = now() - interval '15 minutes' where id = $1", [e1.queue_entry_id]);
      await db.query('select private.recompute_session_estimates($1)', [session]);
      expect((await entry(db, e2.queue_entry_id)).estimated_start_at).toBe(await at(db, "now() + interval '5 minutes'"));

      // With 20+ measured consultations (median 12 min), the current one is already over its expected end.
      await db.query(`insert into public.consultation_duration_stats (clinic_id, doctor_id, service_id, sample_size, median_minutes, p80_minutes)
                      values ($1, $2, $3, 25, 12, 15)`, [w.clinicA, w.doctorA1, w.serviceA]);
      await db.query('select private.recompute_session_estimates($1)', [session]);
      expect((await entry(db, e2.queue_entry_id)).estimated_start_at).toBe(await at(db, 'now()'));
      // Fewer than 20 measures: the booked duration is used again.
      await db.query('update public.consultation_duration_stats set sample_size = 10 where clinic_id = $1', [w.clinicA]);
      await db.query('select private.recompute_session_estimates($1)', [session]);
      expect((await entry(db, e2.queue_entry_id)).estimated_start_at).toBe(await at(db, "now() + interval '5 minutes'"));
    });
  });

  it('uses the first window plus the announced delay before the day starts, and the delay while paused', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      // Today the doctor works from 00:00 (local), whatever today is.
      await db.query(
        `with s as (insert into public.doctor_schedules (clinic_id, doctor_id, name, kind, valid_from, valid_until)
                    values ($1, $2, 'All day', 'override', (now() at time zone $3)::date, (now() at time zone $3)::date) returning id)
         insert into public.doctor_availability (clinic_id, schedule_id, doctor_id, weekday, start_time, end_time)
         select $1, s.id, $2, wd, time '00:00', time '23:55' from s, generate_series(1, 7) wd`, [w.clinicA, w.doctorA1, TZ]);
      const e = await walkIn(db, w, w.patientA1);
      const session = await sessionOf(db, e.queue_entry_id);
      await actAs(db, asUser(w.users.ownerA));
      await db.query('select public.report_doctor_delay($1, 600)', [w.doctorA1]);
      await actAs(db, asPostgres);
      await db.query('select private.recompute_session_estimates($1)', [session]);
      // Planned: max(now, first window 00:00 local + 600 min).
      expect((await entry(db, e.queue_entry_id)).estimated_start_at).toBe(await at(db,
        "greatest(now(), (((now() at time zone $1)::date + time '00:00') at time zone $1) + interval '600 minutes')", [TZ]));

      await actAs(db, asUser(w.users.ownerA));
      await db.query('select public.open_doctor_day($1)', [w.doctorA1]);
      await db.query('select public.pause_doctor_session($1)', [session]);
      await actAs(db, asPostgres);
      await db.query('select private.recompute_session_estimates($1)', [session]);
      // Paused: now + announced delay.
      expect((await entry(db, e.queue_entry_id)).estimated_start_at).toBe(await at(db, "now() + interval '600 minutes'"));
    });
  });

  it('rebuilds duration statistics from completed consultations, visible to the clinic only', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      const session = (await one<{ id: string }>(db,
        'select id from public.doctor_sessions where doctor_id = $1 and service_date = $2::date', [w.doctorA1, w.day])).id;
      await db.query("set local session_replication_role = 'replica'");
      // 21 completed consultations of 10 to 30 minutes, closed yesterday.
      await db.query(
        `with a as (
           insert into public.appointments (clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, source, price_mad,
                                            confirmed_at, checked_in_at, started_at, completed_at)
           select $1, $2, $3, $4, to_timestamp(floor(extract(epoch from now()) / 300) * 300) - interval '2 days',
                  to_timestamp(floor(extract(epoch from now()) / 300) * 300) - interval '2 days' + interval '20 minutes', 'completed', 'staff', 200,
                  now(), now(), now(), now()
           from generate_series(1, 21) returning id),
         n as (select id, row_number() over () as i from a)
         insert into public.queue_entries (clinic_id, session_id, appointment_id, doctor_id, ticket_number, state, outcome, sort_key,
                                           checked_in_at, consultation_started_at, closed_at)
         select $1, $5, n.id, $3, 100 + n.i, 'closed', 'completed', n.i, now() - interval '1 day',
                now() - interval '1 day' - make_interval(mins => (9 + n.i)::int), now() - interval '1 day'
         from n`, [w.clinicA, w.patientA1, w.doctorA1, w.serviceA, session]);
      await db.query("set local session_replication_role = 'origin'");
      expect((await one<{ n: number }>(db, 'select private.rebuild_consultation_duration_stats($1) as n', [w.clinicA])).n).toBe(1);
      expect(await one(db, 'select sample_size, median_minutes::text, p80_minutes::text from public.consultation_duration_stats where doctor_id = $1', [w.doctorA1]))
        .toEqual({ sample_size: 21, median_minutes: '20', p80_minutes: '26' });

      const visible = 'select 1 from public.consultation_duration_stats where clinic_id = $1';
      await actAs(db, asUser(w.users.receptionA));
      expect(await count(db, visible, [w.clinicA])).toBe(1);
      await actAs(db, asUser(w.users.ownerB));
      expect(await count(db, visible, [w.clinicA])).toBe(0);
    });
  });
});
