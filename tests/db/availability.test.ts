import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { localDay, offsetMinutes } from '@/shared/lib/time';

import { actAs, asPostgres, asUser, count, createPool, failure, one, withRollback, type Db } from './helpers/db';
import { createWorld, localInstant, type World } from './helpers/fixtures';

/**
 * Module 5 — services and availability (migration 0021):
 * save_doctor_schedule (atomic schedule + windows), list_doctor_booking_conflicts (BR-B-12),
 * and the slot generator across time changes (BR-TZ-02, BR-TZ-03).
 */
// Morocco has had no time change since it moved to UTC+0 for good on 2026-09-20 (tzdata 2026c,
// SC-AUD-24), so the generator is exercised on a zone that still changes twice a year. A clinic's
// time zone may be any IANA zone; Spain's rules are the same in every tzdata release in use.
const TZ = 'Europe/Madrid';

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

interface Window {
  weekday: number;
  start: string;
  end: string;
}

const SAVE = 'select public.save_doctor_schedule($1, $2, $3, $4, $5::date, $6::date, $7::jsonb) as id';

async function save(db: Db, doctor: string, schedule: string | null, kind: 'regular' | 'override', name: string,
  from: string, until: string | null, windows: Window[]): Promise<string> {
  return (await one<{ id: string }>(db, SAVE, [doctor, schedule, kind, name, from, until, JSON.stringify(windows)])).id;
}

function saveFails(db: Db, doctor: string, schedule: string | null, kind: string, name: string,
  from: string, until: string | null, windows: unknown): Promise<{ message: string }> {
  return failure(db, SAVE, [doctor, schedule, kind, name, from, until, JSON.stringify(windows)]);
}

async function regularScheduleOf(db: Db, doctor: string): Promise<string> {
  await actAs(db, asPostgres);
  return (await one<{ id: string }>(db, "select id from public.doctor_schedules where doctor_id = $1 and kind = 'regular'", [doctor])).id;
}

async function windowsOf(db: Db, schedule: string): Promise<string[]> {
  await actAs(db, asPostgres);
  return (await db.query<{ w: string }>(
    `select weekday || ' ' || to_char(start_time, 'HH24:MI') || '-' || to_char(end_time, 'HH24:MI') as w
     from public.doctor_availability where schedule_id = $1 order by weekday, start_time`, [schedule])).rows.map((r) => r.w);
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

describe('save_doctor_schedule', () => {
  it('replaces the windows of a schedule in one transaction, and rolls back entirely on an invalid window', async () => {
    await scenario(async (db, w) => {
      const regular = await regularScheduleOf(db, w.doctorA1);
      await actAs(db, asUser(w.users.ownerA));
      const id = await save(db, w.doctorA1, regular, 'regular', 'Horaires habituels', '2020-01-01', null, [
        { weekday: 1, start: '09:00', end: '12:00' },
        { weekday: 1, start: '14:00', end: '17:30' },
        { weekday: 2, start: '09:00', end: '12:00' },
      ]);
      expect(id).toBe(regular);
      expect(await windowsOf(db, regular)).toEqual(['1 09:00-12:00', '1 14:00-17:30', '2 09:00-12:00']);

      await actAs(db, asUser(w.users.ownerA));
      for (const bad of [
        [{ weekday: 1, start: '09:00', end: '12:00' }, { weekday: 1, start: '11:00', end: '13:00' }], // overlap
        [{ weekday: 8, start: '09:00', end: '12:00' }], // weekday
        [{ weekday: 1, start: '09:03', end: '12:00' }], // off the 5-minute grid
        [{ weekday: 1, start: '12:00', end: '09:00' }], // order
        [{ weekday: 1, start: '9h', end: '12:00' }], // format
        { weekday: 1 }, // not an array
      ]) {
        expect((await saveFails(db, w.doctorA1, regular, 'regular', 'Horaires habituels', '2020-01-01', null, bad)).message)
          .toBe('VALIDATION_FAILED');
      }
      expect(await windowsOf(db, regular)).toEqual(['1 09:00-12:00', '1 14:00-17:30', '2 09:00-12:00']);
    });
  });

  it('creates dated overrides that beat the regular hours, and refuses overlapping or open-ended ones', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.ownerA));
      const until = addDays(w.day, 6);
      const ramadan = await save(db, w.doctorA1, null, 'override', 'Ramadan', w.day, until, [{ weekday: 1, start: '10:00', end: '14:00' }]);
      const first = await one<{ s: string }>(db,
        'select min(slot_starts_at)::text as s from public.get_available_slots($1, $2, $3::date, $3::date)', [w.doctorA1, w.serviceA, w.day]);
      expect(first.s).toBe(await localInstant(db, w.day, '10:00').then((t) => new Date(t).toISOString().replace('T', ' ').replace('.000Z', '+00')));

      expect((await saveFails(db, w.doctorA1, null, 'override', 'Aïd', addDays(w.day, 3), addDays(w.day, 10), [])).message).toBe('SCHEDULE_OVERLAP');
      expect((await saveFails(db, w.doctorA1, null, 'override', 'Sans fin', addDays(w.day, 30), null, [])).message).toBe('VALIDATION_FAILED');
      expect((await saveFails(db, w.doctorA1, ramadan, 'regular', 'Ramadan', w.day, until, [])).message).toBe('VALIDATION_FAILED');
      expect((await saveFails(db, w.doctorA1, null, 'weekly', 'Autre', w.day, until, [])).message).toBe('VALIDATION_FAILED');
    });
  });

  it('enforces schedules.manage, the doctor scope and the clinic boundary', async () => {
    await scenario(async (db, w) => {
      const regularA1 = await regularScheduleOf(db, w.doctorA1);
      const regularA2 = await regularScheduleOf(db, w.doctorA2);
      const windows = [{ weekday: 1, start: '08:00', end: '12:00' }];

      await actAs(db, asUser(w.users.receptionA));
      expect((await saveFails(db, w.doctorA1, regularA1, 'regular', 'Regular', '2020-01-01', null, windows)).message).toBe('FORBIDDEN');
      await actAs(db, asUser(w.users.doctorA)); // practitioner-only, linked to doctorA2
      expect((await saveFails(db, w.doctorA1, regularA1, 'regular', 'Regular', '2020-01-01', null, windows)).message).toBe('NOT_FOUND');
      expect(await save(db, w.doctorA2, regularA2, 'regular', 'Regular', '2020-01-01', null, windows)).toBe(regularA2);
      // A schedule id must belong to the doctor named in the call.
      expect((await saveFails(db, w.doctorA2, regularA1, 'regular', 'Regular', '2020-01-01', null, windows)).message).toBe('NOT_FOUND');
      for (const user of [w.users.ownerB, w.users.outsider]) {
        await actAs(db, asUser(user));
        expect((await saveFails(db, w.doctorA1, regularA1, 'regular', 'Regular', '2020-01-01', null, windows)).message).toBe('NOT_FOUND');
      }
      await actAs(db, asUser(w.users.suspendedA));
      expect((await saveFails(db, w.doctorA1, regularA1, 'regular', 'Regular', '2020-01-01', null, windows)).message).toBe('NOT_FOUND');
    });
  });

  it('keeps windows and time off inside their clinic (composite foreign keys)', async () => {
    await scenario(async (db, w) => {
      const regularA1 = await regularScheduleOf(db, w.doctorA1);
      await actAs(db, asUser(w.users.ownerB));
      // Clinic B's own id with clinic A's schedule: the composite FK has no matching row.
      // (Sunday: no existing window, so the overlap constraint does not fire first.)
      expect((await failure(db,
        `insert into public.doctor_availability (clinic_id, schedule_id, doctor_id, weekday, start_time, end_time)
         values ($1, $2, $3, 7, '08:00', '09:00')`, [w.clinicB, regularA1, w.doctorB1])).code).toBe('23503');
      expect((await failure(db,
        `insert into public.doctor_time_off (clinic_id, doctor_id, period, reason_category)
         values ($1, $2, tstzrange(now() + interval '1 day', now() + interval '2 days'), 'leave')`, [w.clinicB, w.doctorA1])).code).toBe('23503');
      // Clinic A's id: refused by RLS before any key check.
      expect((await failure(db,
        `insert into public.doctor_time_off (clinic_id, doctor_id, period, reason_category)
         values ($1, $2, tstzrange(now() + interval '1 day', now() + interval '2 days'), 'leave')`, [w.clinicA, w.doctorA1])).code).toBe('42501');
    });
  });
});

describe('booking conflicts after availability changes (BR-B-12)', () => {
  interface Conflict {
    appointment_id: string;
    reason: string;
  }
  const CONFLICTS = 'select * from public.list_doctor_booking_conflicts($1) order by starts_at';

  it('lists future appointments that no longer fit, and never moves or cancels them', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const nextMonday = addDays(w.day, 7);
      const saturday = addDays(w.day, 12);
      const inTimeOff = await one<{ id: string }>(db, 'select id from public.book_appointment($1, $2, $3, $4)',
        [w.patientA1, w.doctorA1, w.serviceA, await localInstant(db, nextMonday, '10:00')]);
      const onClosure = await one<{ id: string }>(db, 'select id from public.book_appointment($1, $2, $3, $4)',
        [w.patientA1, w.doctorA1, w.serviceA, await localInstant(db, saturday, '10:00')]);
      expect((await db.query(CONFLICTS, [w.doctorA1])).rows).toEqual([]);

      // Hours now start at 10:00: the fixture's 09:00 appointment (apptA2) no longer fits.
      const regular = await regularScheduleOf(db, w.doctorA1);
      await actAs(db, asUser(w.users.ownerA));
      await save(db, w.doctorA1, regular, 'regular', 'Regular', '2020-01-01', null,
        [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '10:00', end: '18:00' })));
      await db.query(
        `insert into public.doctor_time_off (clinic_id, doctor_id, period, reason_category)
         values ($1, $2, tstzrange($3::timestamptz, $4::timestamptz), 'training')`,
        [w.clinicA, w.doctorA1, await localInstant(db, nextMonday, '09:30'), await localInstant(db, nextMonday, '12:00')]);
      await db.query(`insert into public.clinic_closures (clinic_id, dates, reason) values ($1, daterange($2::date, $2::date, '[]'), 'Fête')`,
        [w.clinicA, saturday]);

      await actAs(db, asUser(w.users.receptionA));
      const conflicts = (await db.query<Conflict>(CONFLICTS, [w.doctorA1])).rows.map((c) => [c.appointment_id, c.reason]);
      expect(conflicts).toEqual([[w.apptA2, 'outside_availability'], [inTimeOff.id, 'doctor_time_off'], [onClosure.id, 'clinic_closed']]);
      // BR-B-12: nothing was moved or cancelled.
      expect(await count(db, "select 1 from public.appointments where id = any($1::uuid[]) and status = 'confirmed'",
        [[w.apptA2, inTimeOff.id, onClosure.id]])).toBe(3);
    });
  });

  it('returns no patient data, and follows the schedule scope', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const result = await db.query(CONFLICTS, [w.doctorA1]);
      expect(result.fields.map((f) => f.name)).toEqual(['appointment_id', 'starts_at', 'ends_at', 'reason']);
      await actAs(db, asUser(w.users.doctorA));
      expect((await failure(db, CONFLICTS, [w.doctorA1])).message).toBe('NOT_FOUND');
      await actAs(db, asUser(w.users.ownerB));
      expect((await failure(db, CONFLICTS, [w.doctorA1])).message).toBe('NOT_FOUND');
      await actAs(db, asUser(w.users.accountantA));
      expect((await failure(db, CONFLICTS, [w.doctorA1])).message).toBe('FORBIDDEN');
    });
  });
});

describe('slot generator across time changes (BR-TZ-02, BR-TZ-03)', () => {
  interface Slot {
    slot_starts_at: Date;
    slot_ends_at: Date;
  }
  const hhmm = (d: Date): string => {
    const local = new Date(d.getTime() + offsetMinutes(d, TZ) * 60_000);
    return local.toISOString().slice(11, 16);
  };
  const minutesOf = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

  it('offers only real, exact, distinct slots inside their window on and around every time change', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      await db.query('update public.clinics set timezone = $2 where id = $1', [w.clinicA, TZ]);
      // Days whose UTC offset at noon differs from the previous day's: the time changes.
      const switches = (await db.query<{ d: string }>(
        `with days as (
           select (current_date + i) as d,
                  extract(epoch from ((current_date + i) + time '12:00')
                    - ((((current_date + i) + time '12:00') at time zone $1) at time zone 'UTC')) as off
           from generate_series(14, 730) as i)
         select d::text as d from (select d, off, lag(off) over (order by d) as prev from days) x
         where prev is not null and off <> prev order by d`, [TZ])).rows.map((r) => r.d);
      expect(switches.length, 'tzdata must know the spring and autumn time changes').toBeGreaterThanOrEqual(2);

      for (const day of switches) {
        // An override covering the change, every weekday: a night window around the switch hour,
        // and normal opening hours (written as postgres: this test isolates the slot generator).
        await db.query(
          `with s as (insert into public.doctor_schedules (clinic_id, doctor_id, name, kind, valid_from, valid_until)
                      values ($1, $2, 'Switch ' || $3, 'override', $3::date - 3, $3::date + 3) returning id)
           insert into public.doctor_availability (clinic_id, schedule_id, doctor_id, weekday, start_time, end_time)
           select $1, s.id, $2, wd, t.s, t.e from s, generate_series(1, 7) wd,
                  (values (time '01:00', time '04:00'), (time '08:00', time '18:00')) as t(s, e)`,
          [w.clinicA, w.doctorA1, day]);
      }

      await actAs(db, asUser(w.users.receptionA));
      for (const day of switches) {
        const slots = (await db.query<Slot>('select * from public.get_available_slots($1, $2, $3::date - 3, $3::date + 3)',
          [w.doctorA1, w.serviceA, day])).rows;
        const perDayWindow = new Map<string, number>();
        let previousEnd = 0;
        for (const s of slots) {
          const start = new Date(s.slot_starts_at);
          const end = new Date(s.slot_ends_at);
          const label = `${day}: slot ${start.toISOString()}`;
          expect(end.getTime() - start.getTime(), `${label} lasts exactly 20 minutes`).toBe(20 * 60_000);
          expect(start.getTime(), `${label} is distinct and does not overlap the previous one`).toBeGreaterThanOrEqual(previousEnd);
          previousEnd = end.getTime();

          const localStart = hhmm(start);
          const night = minutesOf(localStart) < 8 * 60;
          const [winStart, winEnd] = night ? [60, 240] : [480, 1080];
          expect((minutesOf(localStart) - winStart) % 20, `${label} (${localStart} local) is on the 20-minute grid`).toBe(0);
          expect(minutesOf(localStart), `${label} starts inside its window`).toBeGreaterThanOrEqual(winStart);
          const localEndDay = localDay(end, TZ);
          expect(localEndDay, `${label} ends on its own local day`).toBe(localDay(start, TZ));
          expect(minutesOf(hhmm(end)), `${label} (ends ${hhmm(end)} local) stays inside its window`).toBeLessThanOrEqual(winEnd);
          // The local wall-clock start round-trips: no non-existent local time was offered.
          const key = `${localDay(start, TZ)} ${night ? 'night' : 'day'}`;
          perDayWindow.set(key, (perDayWindow.get(key) ?? 0) + 1);
        }
        // Normal opening hours are unaffected by the switch: 30 slots of 20 minutes every day.
        for (let i = -3; i <= 3; i++) expect(perDayWindow.get(`${addDays(day, i)} day`), `${addDays(day, i)} day slots`).toBe(30);

        // Every slot offered on the switch day is bookable (generator and booking rules agree).
        const switchDaySlots = slots.filter((s) => localDay(new Date(s.slot_starts_at), TZ) === day);
        for (const s of switchDaySlots) {
          await db.query('select public.book_appointment($1, $2, $3, $4)', [w.patientA1, w.doctorA1, w.serviceA, s.slot_starts_at]);
        }
        expect((await db.query('select 1 from public.get_available_slots($1, $2, $3::date, $3::date)',
          [w.doctorA1, w.serviceA, day])).rowCount).toBe(0);
      }
    });
  });
});
