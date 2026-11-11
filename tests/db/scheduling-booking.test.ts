import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { actAs, asPostgres, asUser, count, createPool, failure, one, withRollback, type Db } from './helpers/db';
import { createWorld, localInstant, type World } from './helpers/fixtures';

/** Slots, booking rules (BR-B-*), state machine (BR-A) and history/audit side effects. */
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

interface Slot {
  slot_starts_at: string;
  slot_ends_at: string;
}

async function slots(db: Db, doctor: string, service: string, from: string, to = from): Promise<Slot[]> {
  return (await db.query<Slot>('select * from public.get_available_slots($1, $2, $3::date, $4::date)', [doctor, service, from, to])).rows;
}

interface Appointment {
  id: string;
  status: string;
  starts_at: string;
  ends_at: string;
  price_mad: string;
  version: number;
}

async function book(db: Db, w: World, opts: { doctor?: string; patient?: string; service?: string; at: string; key?: string; overbook?: string }): Promise<Appointment> {
  return one<Appointment>(db,
    'select * from public.book_appointment($1, $2, $3, $4, $5, $6, $7)',
    [opts.patient ?? w.patientA1, opts.doctor ?? w.doctorA1, opts.service ?? w.serviceA, opts.at,
     opts.key ?? null, opts.overbook !== undefined, opts.overbook ?? null]);
}

describe('available slots', () => {
  it('computes 20-minute slots from local wall-clock windows, minus appointments and time off', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const result = await slots(db, w.doctorA1, w.serviceA, w.day);
      // 08:00–18:00 = 30 slots; minus 09:00 (apptA2) and 16:00–18:00 time off (6 slots) = 23.
      expect(result).toHaveLength(23);
      expect(result[0]?.slot_starts_at).toBe(await localInstant(db, w.day, '08:00'));
      const starts = result.map((s) => s.slot_starts_at);
      expect(starts).not.toContain(await localInstant(db, w.day, '09:00'));
      expect(starts).not.toContain(await localInstant(db, w.day, '16:00'));
      expect(starts).toContain(await localInstant(db, w.day, '09:20'));
    });
  });

  it('returns nothing on a clinic closure or a Sunday', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const saturday = (await one<{ d: string }>(db, 'select ($1::date + 5)::text as d', [w.day])).d;
      const sunday = (await one<{ d: string }>(db, 'select ($1::date + 6)::text as d', [w.day])).d;
      expect(await slots(db, w.doctorA1, w.serviceA, saturday)).toHaveLength(0);
      expect(await slots(db, w.doctorA1, w.serviceA, sunday)).toHaveLength(0);
    });
  });

  it('applies an override schedule (e.g. Ramadan hours) instead of the regular one', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      const schedule = await one<{ id: string }>(db,
        "insert into public.doctor_schedules (clinic_id, doctor_id, name, kind, valid_from, valid_until) values ($1, $2, 'Ramadan', 'override', $3, $3) returning id",
        [w.clinicA, w.doctorA1, w.day]);
      await db.query(
        "insert into public.doctor_availability (clinic_id, schedule_id, doctor_id, weekday, start_time, end_time) values ($1, $2, $3, 1, '10:00', '11:00')",
        [w.clinicA, schedule.id, w.doctorA1]);
      await actAs(db, asUser(w.users.receptionA));
      const result = await slots(db, w.doctorA1, w.serviceA, w.day);
      expect(result.map((s) => s.slot_starts_at)).toEqual([
        await localInstant(db, w.day, '10:00'), await localInstant(db, w.day, '10:20'), await localInstant(db, w.day, '10:40'),
      ]);
    });
  });

  it('follows the time-zone database per date (Morocco switches to UTC+0 during Ramadan)', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      // Find, within two years, a future Monday with UTC+0 and one with UTC+1 in Africa/Casablanca.
      // local wall clock (date + time) minus the UTC wall clock of the same instant = UTC offset.
      const offsets = (await db.query<{ d: string; offset_hours: number }>(
        `select (current_date + i)::text as d,
                (extract(epoch from ((current_date + i) + time '12:00')
                   - ((((current_date + i) + time '12:00') at time zone 'Africa/Casablanca') at time zone 'UTC')) / 3600)::int
                  as offset_hours
         from generate_series(14, 730) as i
         where extract(isodow from current_date + i) = 1`)).rows;
      const utc0 = offsets.find((o) => o.offset_hours === 0);
      const utc1 = offsets.find((o) => o.offset_hours === 1);
      expect(utc1, 'tzdata must know Morocco UTC+1').toBeDefined();
      if (!utc0 || !utc1) {
        // tzdata without a Ramadan rule in the next two years: nothing more to check.
        return;
      }
      await actAs(db, asUser(w.users.receptionA));
      const s0 = await slots(db, w.doctorA1, w.serviceA, utc0.d);
      const s1 = await slots(db, w.doctorA1, w.serviceA, utc1.d);
      // 08:00 local is 08:00Z during Ramadan and 07:00Z otherwise.
      expect(new Date(s0[0]?.slot_starts_at ?? '').getUTCHours()).toBe(8);
      expect(new Date(s1[0]?.slot_starts_at ?? '').getUTCHours()).toBe(7);
    });
  });
});

describe('book_appointment', () => {
  it('books a confirmed appointment with server-side duration and price snapshot', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const at = await localInstant(db, w.day, '10:00');
      const appt = await book(db, w, { at });
      expect(appt.status).toBe('confirmed');
      expect(appt.starts_at).toBe(at);
      expect(appt.ends_at).toBe(await localInstant(db, w.day, '10:20'));
      expect(appt.price_mad).toBe('200.00');
      await actAs(db, asPostgres);
      const history = (await db.query<{ event_type: string; to_status: string; actor_user_id: string }>(
        'select event_type, to_status, actor_user_id from public.appointment_history where appointment_id = $1', [appt.id])).rows;
      expect(history).toEqual([{ event_type: 'created', to_status: 'confirmed', actor_user_id: w.users.receptionA }]);
      expect(await count(db, "select 1 from public.domain_events where aggregate_id = $1 and event_type = 'appointment.confirmed' and payload = '{}'::jsonb", [appt.id])).toBe(1);
    });
  });

  it('applies doctor-specific duration and price overrides', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      await db.query('update public.doctor_services set duration_minutes = 40, price_mad = 350 where doctor_id = $1 and service_id = $2', [w.doctorA1, w.serviceA]);
      await actAs(db, asUser(w.users.receptionA));
      const appt = await book(db, w, { at: await localInstant(db, w.day, '10:00') });
      expect(appt.ends_at).toBe(await localInstant(db, w.day, '10:40'));
      expect(appt.price_mad).toBe('350.00');
    });
  });

  it.each([
    ['an occupied slot', '09:00', 'SLOT_UNAVAILABLE', ''],
    ['a partially overlapping slot', '08:50', 'SLOT_UNAVAILABLE', ''],
    ['before opening hours', '07:40', 'SLOT_UNAVAILABLE', 'outside_availability'],
    ['across closing time', '17:50', 'SLOT_UNAVAILABLE', ''],
    ['during time off', '16:20', 'SLOT_UNAVAILABLE', 'doctor_time_off'],
  ])('rejects %s', async (_label, time, message, detail) => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const err = await failure(db, 'select public.book_appointment($1, $2, $3, $4)', [w.patientA1, w.doctorA1, w.serviceA, await localInstant(db, w.day, time)]);
      expect(err.message).toBe(message);
      if (detail) expect(err.detail).toBe(detail);
    });
  });

  it('rejects a clinic closure, a past start, an unoffered service and an off-grid start', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const closed = await failure(db, 'select public.book_appointment($1, $2, $3, $4)', [w.patientA1, w.doctorA1, w.serviceA, await localInstant(db, w.day, '10:00', 5)]);
      expect([closed.message, closed.detail]).toEqual(['SLOT_UNAVAILABLE', 'clinic_closed']);
      const past = await failure(db, "select public.book_appointment($1, $2, $3, now() - interval '1 day')", [w.patientA1, w.doctorA1, w.serviceA]);
      expect(past.message).toBe('BOOKING_IN_PAST');
      const notOffered = await failure(db, 'select public.book_appointment($1, $2, $3, $4)', [w.patientA1, w.doctorA1, w.serviceA2, await localInstant(db, w.day, '10:00')]);
      expect(notOffered.message).toBe('SERVICE_NOT_OFFERED');
      const offGrid = await failure(db, 'select public.book_appointment($1, $2, $3, $4)', [w.patientA1, w.doctorA1, w.serviceA, await localInstant(db, w.day, '10:03')]);
      expect(offGrid.code).toBe('23514');
    });
  });

  it('allows an explicit, audited overbooking only with permission and a reason', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const at = await localInstant(db, w.day, '09:00');
      const appt = await book(db, w, { at, overbook: 'Urgence administrative' });
      expect(appt.status).toBe('confirmed');
      const noReason = await failure(db, 'select public.book_appointment($1, $2, $3, $4, null, true, null)', [w.patientA1, w.doctorA1, w.serviceA, at]);
      expect(noReason.code).toBe('23514');
      await actAs(db, asUser(w.users.accountantA));
      expect((await failure(db, 'select public.book_appointment($1, $2, $3, $4)', [w.patientA1, w.doctorA1, w.serviceA, await localInstant(db, w.day, '11:00')])).message).toBe('FORBIDDEN');
    });
  });

  it('is idempotent per key, and refuses a key reused for a different booking', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const at = await localInstant(db, w.day, '10:00');
      const first = await book(db, w, { at, key: 'booking-key-0001' });
      const replay = await book(db, w, { at, key: 'booking-key-0001' });
      expect(replay.id).toBe(first.id);
      const reused = await failure(db, 'select public.book_appointment($1, $2, $3, $4, $5)',
        [w.patientA2, w.doctorA1, w.serviceA, await localInstant(db, w.day, '11:00'), 'booking-key-0001']);
      expect(reused.message).toBe('IDEMPOTENCY_KEY_REUSED');
    });
  });

  it('limits a practitioner-only doctor to their own agenda', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.doctorA));
      const own = await book(db, w, { doctor: w.doctorA2, at: await localInstant(db, w.day, '10:00') });
      expect(own.status).toBe('confirmed');
      const other = await failure(db, 'select public.book_appointment($1, $2, $3, $4)', [w.patientA1, w.doctorA1, w.serviceA, await localInstant(db, w.day, '11:00')]);
      expect(other.message).toBe('NOT_FOUND');
    });
  });
});

describe('appointment lifecycle', () => {
  it('confirms a pending appointment, with optimistic concurrency', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      const pending = await one<{ id: string; version: number }>(db,
        `insert into public.appointments (clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, source, price_mad)
         values ($1, $2, $3, $4, $5, $6, 'pending', 'online', 200) returning id, version`,
        [w.clinicA, w.patientA1, w.doctorA1, w.serviceA, await localInstant(db, w.day, '12:00'), await localInstant(db, w.day, '12:20')]);
      await actAs(db, asUser(w.users.receptionA));
      expect((await failure(db, 'select public.confirm_appointment($1, $2)', [pending.id, pending.version + 1])).message).toBe('STALE_STATE');
      const confirmed = await one<{ status: string; version: number }>(db, 'select * from public.confirm_appointment($1, $2)', [pending.id, pending.version]);
      expect(confirmed).toMatchObject({ status: 'confirmed', version: pending.version + 1 });
      expect((await failure(db, 'select public.confirm_appointment($1)', [pending.id])).message).toBe('APPT_INVALID_TRANSITION');
    });
  });

  it('cancels with a reason, records history, and frees the slot', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const cancelled = await one<{ status: string; cancellation_actor: string }>(db,
        "select * from public.cancel_appointment($1, 'patient_request', 'Appel du patient')", [w.apptA2]);
      expect(cancelled).toMatchObject({ status: 'cancelled', cancellation_actor: 'clinic' });
      const rebooked = await book(db, w, { patient: w.patientA1, at: await localInstant(db, w.day, '09:00') });
      expect(rebooked.status).toBe('confirmed');
      expect((await failure(db, "select public.cancel_appointment($1, 'left_before_consultation')", [w.apptA1])).message).toBe('VALIDATION_FAILED');
      await actAs(db, asPostgres);
      const history = await one<{ from_status: string; to_status: string; reason: string }>(db,
        "select from_status, to_status, reason from public.appointment_history where appointment_id = $1 and event_type = 'status_changed'", [w.apptA2]);
      expect(history).toEqual({ from_status: 'confirmed', to_status: 'cancelled', reason: 'Appel du patient' });
    });
  });

  it('reschedules in place, keeping the previous time in history', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const newStart = await localInstant(db, w.day, '14:00');
      const moved = await one<{ id: string; starts_at: string; ends_at: string }>(db, 'select * from public.reschedule_appointment($1, $2)', [w.apptA2, newStart]);
      expect(moved.id).toBe(w.apptA2);
      expect(moved.starts_at).toBe(newStart);
      expect(moved.ends_at).toBe(await localInstant(db, w.day, '14:20'));
      await book(db, w, { patient: w.patientA2, at: await localInstant(db, w.day, '15:00') });
      expect((await failure(db, 'select public.reschedule_appointment($1, $2)', [w.apptA2, await localInstant(db, w.day, '15:00')])).message).toBe('SLOT_UNAVAILABLE');
      await actAs(db, asPostgres);
      const history = await one<{ previous_starts_at: string; new_starts_at: string }>(db,
        "select previous_starts_at, new_starts_at from public.appointment_history where appointment_id = $1 and event_type = 'rescheduled'", [w.apptA2]);
      expect(history).toEqual({ previous_starts_at: await localInstant(db, w.day, '09:00'), new_starts_at: newStart });
    });
  });

  it('marks a no-show only after the grace period', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      expect((await failure(db, 'select public.mark_no_show($1)', [w.apptA1])).message).toBe('NO_SHOW_TOO_EARLY');
      await actAs(db, asPostgres);
      const past = await one<{ id: string }>(db,
        `insert into public.appointments (clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, source, price_mad, confirmed_at)
         values ($1, $2, $3, $4, date_trunc('hour', now()) - interval '2 hours', date_trunc('hour', now()) - interval '100 minutes', 'confirmed', 'staff', 200, now())
         returning id`, [w.clinicA, w.patientA1, w.doctorA1, w.serviceA]);
      await actAs(db, asUser(w.users.receptionA));
      const marked = await one<{ status: string }>(db, 'select * from public.mark_no_show($1)', [past.id]);
      expect(marked.status).toBe('no_show');
    });
  });

  it('enforces the transition table and immutable fields, even for privileged writers', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      expect((await failure(db, "update public.appointments set status = 'completed', completed_at = now(), started_at = now(), checked_in_at = now() where id = $1", [w.apptA1])).message).toBe('APPT_INVALID_TRANSITION');
      expect((await failure(db, 'update public.appointments set patient_id = $2 where id = $1', [w.apptA1, w.patientA2])).message).toBe('APPOINTMENT_FIELD_IMMUTABLE');
      expect((await failure(db,
        `insert into public.appointments (clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, source, price_mad, completed_at, started_at, checked_in_at)
         values ($1, $2, $3, $4, $5, $6, 'completed', 'staff', 0, now(), now(), now())`,
        [w.clinicA, w.patientA1, w.doctorA1, w.serviceA, await localInstant(db, w.day, '12:00'), await localInstant(db, w.day, '12:20')])).message).toBe('APPT_INVALID_TRANSITION');
      // A valid path still works: confirmed -> checked_in -> in_progress -> completed.
      await db.query("update public.appointments set status = 'checked_in', checked_in_at = now() where id = $1", [w.apptA1]);
      await db.query("update public.appointments set status = 'in_progress', started_at = now() where id = $1", [w.apptA1]);
      await db.query("update public.appointments set status = 'completed', completed_at = now() where id = $1", [w.apptA1]);
      expect((await failure(db, "update public.appointments set status = 'cancelled', cancelled_at = now(), cancellation_actor = 'clinic', cancellation_reason = 'other' where id = $1", [w.apptA1])).message).toBe('APPT_INVALID_TRANSITION');
    });
  });

  it('keeps history and audit append-only', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      expect((await failure(db, 'delete from public.appointment_history where appointment_id = $1', [w.apptA1])).message).toBe('APPEND_ONLY');
      expect((await failure(db, 'update public.audit_logs set action = $1 where clinic_id = $2', ['x.y', w.clinicA])).message).toBe('APPEND_ONLY');
      expect((await failure(db, 'delete from public.patient_consents where clinic_id = $1', [w.clinicA])).message).toBe('APPEND_ONLY');
    });
  });

  it('audits field names only, never values', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      await db.query("update public.patients set phone_e164 = '+99933333333' where id = $1", [w.patientA1]);
      await actAs(db, asPostgres);
      const audit = await one<{ actor_user_id: string; changed_fields: string[]; metadata: object; row: string }>(db,
        "select actor_user_id, changed_fields, metadata, to_jsonb(a)::text as row from public.audit_logs a where entity_id = $1 and action = 'patients.update'", [w.patientA1]);
      expect(audit.actor_user_id).toBe(w.users.receptionA);
      expect(audit.changed_fields).toEqual(['phone_e164']);
      expect(audit.metadata).toEqual({});
      expect(audit.row).not.toContain('33333333');
      expect(audit.row).not.toContain('Alice');
    });
  });
});

describe('scheduling constraints', () => {
  it('rejects overlapping schedules, windows and closures', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      expect((await failure(db, "insert into public.doctor_schedules (clinic_id, doctor_id, name, kind, valid_from) values ($1, $2, 'Second regular', 'regular', current_date + 100)", [w.clinicA, w.doctorA1])).code).toBe('23P01');
      const schedule = await one<{ id: string }>(db, 'select id from public.doctor_schedules where doctor_id = $1', [w.doctorA1]);
      expect((await failure(db, "insert into public.doctor_availability (clinic_id, schedule_id, doctor_id, weekday, start_time, end_time) values ($1, $2, $3, 1, '17:00', '19:00')", [w.clinicA, schedule.id, w.doctorA1])).code).toBe('23P01');
      expect((await failure(db, "insert into public.doctor_availability (clinic_id, schedule_id, doctor_id, weekday, start_time, end_time) values ($1, $2, $3, 7, '09:00', '10:00')", [w.clinicA, schedule.id, w.doctorA2])).code).toBe('23503');
      expect((await failure(db, "insert into public.clinic_closures (clinic_id, dates, reason) values ($1, daterange($2::date + 4, $2::date + 6), 'Overlap')", [w.clinicA, w.day])).code).toBe('23P01');
    });
  });
});
