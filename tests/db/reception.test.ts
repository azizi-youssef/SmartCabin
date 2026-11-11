import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { actAs, asPostgres, asUser, count, createPool, failure, one, withRollback, type Db } from './helpers/db';
import { createWorld, type World } from './helpers/fixtures';

/**
 * Module 7 — reception (migration 0023): check-in (A8), walk-ins (A3), left before consultation
 * (A11), gapless tickets, queue order BR-Q-04, queue/appointment consistency, queue visibility.
 * "Today" is the clinic's local day (Africa/Casablanca), computed by the database like the commands.
 */
const PARALLEL = 8;
let pool: pg.Pool;
beforeAll(() => {
  pool = createPool(PARALLEL + 2);
});
afterAll(async () => {
  await pool.end();
});

async function scenario(fn: (db: Db, w: World) => Promise<void>): Promise<void> {
  await withRollback(pool, async (db) => fn(db, await createWorld(db)));
}

interface Clock {
  /** now() floored to the 5-minute grid. */
  now5: string;
  /** Epoch of now() (constant within the transaction, like in the commands). */
  nowEpoch: string;
}

async function clock(db: Db): Promise<Clock> {
  return one<Clock>(db, `select to_timestamp(floor(extract(epoch from now()) / 300) * 300)::text as now5,
                                extract(epoch from now())::text as "nowEpoch"`);
}

/** Whether an instant falls on the clinic's local today. */
async function isToday(db: Db, instant: string): Promise<boolean> {
  return (await one<{ ok: boolean }>(db,
    `select ($1::timestamptz at time zone 'Africa/Casablanca')::date = (now() at time zone 'Africa/Casablanca')::date as ok`, [instant])).ok;
}

/** A confirmed staff appointment written directly (fixture). */
async function confirmedAt(db: Db, w: World, startsAt: string, opts: { doctor?: string; status?: string } = {}): Promise<string> {
  await actAs(db, asPostgres);
  return (await one<{ id: string }>(db,
    `insert into public.appointments (clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, source, price_mad, confirmed_at)
     values ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz + interval '20 minutes', $6::public.appointment_status, 'staff', 200,
             case when $6::text = 'confirmed' then now() end) returning id`,
    [w.clinicA, w.patientA1, opts.doctor ?? w.doctorA1, opts.doctor === w.doctorA2 ? w.serviceA2 : w.serviceA, startsAt, opts.status ?? 'confirmed'])).id;
}

const CHECK_IN = 'select * from public.check_in_appointment($1)';
const WALK_IN = 'select * from public.register_walk_in($1, $2, $3, $4)';

describe('check_in_appointment (A8)', () => {
  it('checks in a confirmed appointment of today: ticket, queue entry, history and queue version', async () => {
    await scenario(async (db, w) => {
      const c = await clock(db);
      const appt = await confirmedAt(db, w, c.now5);
      await actAs(db, asUser(w.users.receptionA));
      const ticket = await one<{ queue_entry_id: string; ticket_number: number }>(db, CHECK_IN, [appt]);
      expect(ticket.ticket_number).toBe(1);

      await actAs(db, asPostgres);
      const entry = await one<{ state: string; sort_key: string; appointment_id: string }>(db,
        'select state, sort_key::text, appointment_id from public.queue_entries where id = $1', [ticket.queue_entry_id]);
      // On time (within the grace period): queued by appointment time (BR-Q-04).
      const anchor = await one<{ e: string }>(db, 'select extract(epoch from $1::timestamptz)::text as e', [c.now5]);
      expect(entry).toEqual({ state: 'waiting', sort_key: anchor.e, appointment_id: appt });
      expect(await one(db, 'select status, checked_in_at is not null as stamped from public.appointments where id = $1', [appt]))
        .toEqual({ status: 'checked_in', stamped: true });
      expect(await one(db,
        `select status::text, next_ticket_number, queue_version::int from public.doctor_sessions
         where doctor_id = $1 and service_date = (now() at time zone 'Africa/Casablanca')::date`, [w.doctorA1]))
        .toEqual({ status: 'planned', next_ticket_number: 2, queue_version: 1 });
      expect(await count(db, "select 1 from public.queue_events where queue_entry_id = $1 and event_type = 'checked_in'", [ticket.queue_entry_id])).toBe(1);
      expect(await count(db,
        "select 1 from public.appointment_history where appointment_id = $1 and from_status = 'confirmed' and to_status = 'checked_in'", [appt])).toBe(1);

      await actAs(db, asUser(w.users.receptionA));
      expect((await failure(db, CHECK_IN, [appt])).message).toBe('APPT_INVALID_TRANSITION');
    });
  });

  it('queues a late patient by arrival time, and refuses other days and other statuses', async () => {
    await scenario(async (db, w) => {
      const c = await clock(db);
      const lateStart = (await one<{ s: string }>(db, "select ($1::timestamptz - interval '60 minutes')::text as s", [c.now5])).s;
      const late = await confirmedAt(db, w, lateStart);
      await actAs(db, asUser(w.users.receptionA));
      if (await isToday(db, lateStart)) {
        const ticket = await one<{ queue_entry_id: string }>(db, CHECK_IN, [late]);
        await actAs(db, asPostgres);
        const entry = await one<{ sort_key: string }>(db, 'select sort_key::text from public.queue_entries where id = $1', [ticket.queue_entry_id]);
        expect(entry.sort_key).toBe(c.nowEpoch);
      } else {
        // Just after midnight, an hour ago was yesterday.
        expect((await failure(db, CHECK_IN, [late])).message).toBe('CHECK_IN_NOT_TODAY');
      }
      await actAs(db, asUser(w.users.receptionA));
      expect((await failure(db, CHECK_IN, [w.apptA2])).message).toBe('CHECK_IN_NOT_TODAY'); // fixture day: two weeks ahead
      const pending = await confirmedAt(db, w, c.now5, { status: 'pending' });
      await actAs(db, asUser(w.users.receptionA));
      expect((await failure(db, CHECK_IN, [pending])).message).toBe('APPT_INVALID_TRANSITION');
    });
  });

  it('requires queue.check_in, stays inside the clinic, and refuses a closed day', async () => {
    await scenario(async (db, w) => {
      const c = await clock(db);
      const own = await confirmedAt(db, w, c.now5, { doctor: w.doctorA2 });
      await actAs(db, asUser(w.users.doctorA)); // doctors do not check patients in
      expect((await failure(db, CHECK_IN, [own])).message).toBe('FORBIDDEN');
      await actAs(db, asUser(w.users.accountantA));
      expect((await failure(db, CHECK_IN, [own])).message).toBe('FORBIDDEN');
      await actAs(db, asUser(w.users.ownerB));
      expect((await failure(db, CHECK_IN, [own])).message).toBe('NOT_FOUND');

      await actAs(db, asPostgres);
      await db.query(
        `insert into public.doctor_sessions (clinic_id, doctor_id, service_date, status, closed_at)
         values ($1, $2, (now() at time zone 'Africa/Casablanca')::date, 'closed', now())`, [w.clinicA, w.doctorA2]);
      await actAs(db, asUser(w.users.adminA));
      expect((await failure(db, CHECK_IN, [own])).message).toBe('SESSION_CLOSED');
    });
  });
});

describe('register_walk_in (A3)', () => {
  it('creates a checked-in walk-in and its ticket without colliding with the agenda, idempotently', async () => {
    await scenario(async (db, w) => {
      const c = await clock(db);
      const booked = await confirmedAt(db, w, c.now5); // the doctor's agenda is taken right now
      await actAs(db, asUser(w.users.receptionA));
      const key = `walkin-${w.clinicA}`;
      const first = await one<{ appointment_id: string; queue_entry_id: string; ticket_number: number }>(db, WALK_IN,
        [w.patientA2, w.doctorA1, w.serviceA, key]);
      expect(first.ticket_number).toBe(1);
      const replay = await one<{ appointment_id: string; ticket_number: number }>(db, WALK_IN, [w.patientA2, w.doctorA1, w.serviceA, key]);
      expect(replay).toMatchObject({ appointment_id: first.appointment_id, ticket_number: 1 });
      expect((await failure(db, WALK_IN, [w.patientA1, w.doctorA1, w.serviceA, key])).message).toBe('IDEMPOTENCY_KEY_REUSED');

      await actAs(db, asPostgres);
      expect(await one(db,
        `select source::text, status::text, starts_at = $2::timestamptz as on_grid, price_mad::text, booked_by_user_id = $3 as by_reception
         from public.appointments where id = $1`, [first.appointment_id, c.now5, w.users.receptionA]))
        .toEqual({ source: 'walk_in', status: 'checked_in', on_grid: true, price_mad: '200.00', by_reception: true });
      const entry = await one<{ sort_key: string }>(db, 'select sort_key::text from public.queue_entries where id = $1', [first.queue_entry_id]);
      expect(entry.sort_key).toBe(c.nowEpoch); // walk-ins are queued by arrival time (BR-Q-04)

      // The scheduled patient checked in afterwards gets the next ticket.
      await actAs(db, asUser(w.users.receptionA));
      expect((await one<{ ticket_number: number }>(db, CHECK_IN, [booked])).ticket_number).toBe(2);
    });
  });

  it('refuses walk-ins to doctors and other clinics, and for patients of another clinic', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.doctorA));
      expect((await failure(db, WALK_IN, [w.patientA1, w.doctorA2, w.serviceA2, null])).message).toBe('FORBIDDEN');
      await actAs(db, asUser(w.users.ownerB));
      expect((await failure(db, WALK_IN, [w.patientA1, w.doctorA1, w.serviceA, null])).message).toBe('NOT_FOUND');
      await actAs(db, asUser(w.users.receptionA));
      expect((await failure(db, WALK_IN, [w.patientB1, w.doctorA1, w.serviceA, null])).message).toBe('NOT_FOUND');
      expect((await failure(db, WALK_IN, [w.patientA1, w.doctorA1, w.serviceA2, null])).message).toBe('SERVICE_NOT_OFFERED');
    });
  });

  it(`hands out gapless, unique tickets to ${PARALLEL} simultaneous arrivals`, async () => {
    const setup = await pool.connect();
    let w: World;
    try {
      await setup.query('begin');
      w = await createWorld(setup);
      await setup.query('commit');
    } finally {
      setup.release();
    }
    let open = (): void => undefined;
    const barrier = new Promise<void>((resolve) => {
      open = resolve;
    });
    const runs = Array.from({ length: PARALLEL }, async (_, i) => {
      const db = await pool.connect();
      try {
        await db.query('begin');
        await actAs(db, asUser(w.users.receptionA));
        await barrier;
        const row = await one<{ ticket_number: number }>(db, WALK_IN,
          [i % 2 === 0 ? w.patientA1 : w.patientA2, w.doctorA1, w.serviceA, `parallel-${i}-${w.clinicA}`]);
        await db.query('commit');
        return row.ticket_number;
      } catch (error) {
        await db.query('rollback');
        throw error;
      } finally {
        db.release();
      }
    });
    open();
    const tickets = (await Promise.all(runs)).sort((a, b) => a - b);
    expect(tickets).toEqual(Array.from({ length: PARALLEL }, (_, i) => i + 1));
  });
});

describe('mark_left (A11)', () => {
  it('closes the entry and cancels the appointment as left before consultation', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const walkIn = await one<{ appointment_id: string; queue_entry_id: string }>(db, WALK_IN, [w.patientA1, w.doctorA1, w.serviceA, null]);
      await actAs(db, asUser(w.users.doctorA)); // doctors may not close entries as left (queue.mark_left)
      expect((await failure(db, 'select public.mark_left($1)', [walkIn.queue_entry_id])).message).toBe('FORBIDDEN');
      await actAs(db, asUser(w.users.receptionA));
      await db.query('select public.mark_left($1, $2)', [walkIn.queue_entry_id, 'Parti sans attendre']);
      expect((await failure(db, 'select public.mark_left($1)', [walkIn.queue_entry_id])).message).toBe('APPT_INVALID_TRANSITION');

      await actAs(db, asPostgres);
      expect(await one(db, 'select status::text, cancellation_reason::text, cancellation_actor::text from public.appointments where id = $1', [walkIn.appointment_id]))
        .toEqual({ status: 'cancelled', cancellation_reason: 'left_before_consultation', cancellation_actor: 'clinic' });
      expect(await one(db, 'select state::text, outcome::text from public.queue_entries where id = $1', [walkIn.queue_entry_id]))
        .toEqual({ state: 'closed', outcome: 'left' });
      expect(await one(db, "select reason from public.queue_events where queue_entry_id = $1 and event_type = 'left'", [walkIn.queue_entry_id]))
        .toEqual({ reason: 'Parti sans attendre' });
    });
  });
});

describe('queue integrity and visibility', () => {
  it('rejects a queue state that does not match the appointment, and protects the trail', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const walkIn = await one<{ queue_entry_id: string }>(db, WALK_IN, [w.patientA1, w.doctorA1, w.serviceA, null]);
      await actAs(db, asPostgres);
      await db.query('set constraints all immediate');
      expect((await failure(db,
        "update public.queue_entries set state = 'in_consultation', consultation_started_at = now() where id = $1", [walkIn.queue_entry_id])).message)
        .toBe('QUEUE_STATUS_MISMATCH');
      expect((await failure(db, 'update public.queue_entries set ticket_number = 99 where id = $1', [walkIn.queue_entry_id])).message)
        .toBe('QUEUE_FIELD_IMMUTABLE');
      expect((await failure(db, 'delete from public.queue_events where queue_entry_id = $1', [walkIn.queue_entry_id])).message)
        .toBe('APPEND_ONLY');
    });
  });

  it('shows the queue to reception and to the doctor concerned only', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const walkIn = await one<{ queue_entry_id: string }>(db, WALK_IN, [w.patientA1, w.doctorA1, w.serviceA, null]);
      const visible = 'select 1 from public.queue_entries where id = $1';
      expect(await count(db, visible, [walkIn.queue_entry_id])).toBe(1);
      await actAs(db, asUser(w.users.ownerA)); // also the practitioner of doctorA1
      expect(await count(db, visible, [walkIn.queue_entry_id])).toBe(1);
      for (const user of [w.users.doctorA, w.users.accountantA, w.users.ownerB, w.users.patientAccount]) {
        await actAs(db, asUser(user));
        expect(await count(db, visible, [walkIn.queue_entry_id]), user).toBe(0);
      }
    });
  });
});
