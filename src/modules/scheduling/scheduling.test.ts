import { describe, expect, it } from 'vitest';

import {
  copyDay,
  currentRegular,
  parseInstantRange,
  scheduleSchema,
  suggestWindow,
  timeOffSchema,
  weeklyMinutes,
  windowIssues,
  type DoctorSchedule,
} from './schemas';

describe('weekly windows validation (mirrors save_doctor_schedule)', () => {
  it('accepts several non-overlapping windows on one day', () => {
    expect(windowIssues([
      { weekday: 1, start: '08:00', end: '12:00' },
      { weekday: 1, start: '14:00', end: '18:00' },
      { weekday: 2, start: '08:00', end: '12:00' },
    ]).size).toBe(0);
  });

  it('reports overlap, order, grid and format per window', () => {
    const issues = windowIssues([
      { weekday: 1, start: '08:00', end: '12:00' },
      { weekday: 1, start: '11:30', end: '13:00' }, // overlaps the first
      { weekday: 2, start: '12:00', end: '09:00' }, // end before start
      { weekday: 3, start: '08:03', end: '12:00' }, // off the 5-minute grid
      { weekday: 4, start: '8h', end: '12:00' }, // format
      { weekday: 1, start: '13:00', end: '14:00' }, // touches the second window, does not overlap
    ]);
    expect(Object.fromEntries(issues)).toEqual({ 1: 'windowOverlap', 2: 'endBeforeStart', 3: 'timeStep', 4: 'invalidTime' });
  });
});

describe('schedule schema', () => {
  const base = { kind: 'regular' as const, name: 'Horaires habituels', validFrom: '2027-01-04', windows: [] };

  it('lets a regular schedule be open-ended but requires dates for an override', () => {
    expect(scheduleSchema.safeParse(base).success).toBe(true);
    const override = scheduleSchema.safeParse({ ...base, kind: 'override', name: 'Ramadan' });
    expect(override.success).toBe(false);
    expect(override.error?.issues[0]).toMatchObject({ path: ['validUntil'], message: 'required' });
  });

  it('refuses an end date before the start date and invalid calendar dates', () => {
    expect(scheduleSchema.safeParse({ ...base, validUntil: '2027-01-03' }).error?.issues[0]?.message).toBe('endBeforeStart');
    expect(scheduleSchema.safeParse({ ...base, validFrom: '2027-02-30' }).success).toBe(false);
  });
});

describe('time off schema', () => {
  const base = { startsAt: '2027-02-08T08:00', endsAt: '2027-02-12T18:00', reason: 'leave' as const };

  it('accepts local date-times and requires the end after the start', () => {
    expect(timeOffSchema.safeParse(base).success).toBe(true);
    expect(timeOffSchema.safeParse({ ...base, endsAt: '2027-02-08T08:00' }).error?.issues[0]?.message).toBe('endBeforeStart');
    expect(timeOffSchema.safeParse({ ...base, startsAt: '2027-02-30T08:00' }).success).toBe(false);
    expect(timeOffSchema.safeParse({ ...base, reason: 'holiday' }).success).toBe(false);
  });
});

describe('editing helpers', () => {
  it('suggests 08:00–12:00 on an empty day, then a window one hour after the last one', () => {
    expect(suggestWindow(3, [])).toEqual({ weekday: 3, start: '08:00', end: '12:00' });
    expect(suggestWindow(1, [{ weekday: 1, start: '08:00', end: '12:00' }])).toEqual({ weekday: 1, start: '13:00', end: '17:00' });
    expect(suggestWindow(1, [{ weekday: 1, start: '18:00', end: '22:30' }])).toEqual({ weekday: 1, start: '22:00', end: '23:55' });
  });

  it('copies Monday to the other working days and leaves Sunday alone', () => {
    const copied = copyDay(
      [
        { weekday: 1, start: '08:00', end: '12:00' },
        { weekday: 1, start: '14:00', end: '18:00' },
        { weekday: 3, start: '09:00', end: '10:00' },
        { weekday: 7, start: '10:00', end: '12:00' },
      ],
      1,
      [1, 2, 3, 4, 5, 6],
    );
    expect(copied.filter((w) => w.weekday === 3)).toEqual([
      { weekday: 3, start: '08:00', end: '12:00' },
      { weekday: 3, start: '14:00', end: '18:00' },
    ]);
    expect(copied.filter((w) => w.weekday === 7)).toHaveLength(1);
    expect(weeklyMinutes(copied)).toBe(6 * 8 * 60 + 120);
  });
});

describe('current regular schedule', () => {
  const s = (id: string, validFrom: string, validUntil: string | null, kind: 'regular' | 'override' = 'regular'): DoctorSchedule =>
    ({ id, kind, name: id, validFrom, validUntil, windows: [] });

  it('prefers the version in force today, then the next one, then the latest', () => {
    const all = [s('old', '2026-01-01', '2026-12-31'), s('now', '2027-01-01', null), s('ramadan', '2027-02-01', '2027-03-01', 'override')];
    expect(currentRegular(all, '2027-02-10')?.id).toBe('now');
    expect(currentRegular([s('future', '2027-06-01', null)], '2027-02-10')?.id).toBe('future');
    expect(currentRegular([s('old', '2026-01-01', '2026-12-31')], '2027-02-10')?.id).toBe('old');
    expect(currentRegular([], '2027-02-10')).toBeNull();
  });
});

describe('time-off period parsing', () => {
  it('reads PostgreSQL tstzrange text as ISO instants', () => {
    expect(parseInstantRange('["2027-02-08 07:00:00+00","2027-02-12 17:00:00+00")')).toEqual({
      start: '2027-02-08T07:00:00.000Z',
      end: '2027-02-12T17:00:00.000Z',
    });
    expect(parseInstantRange('["2027-02-08 08:30:00+01","2027-02-08 12:00:00+01")')?.start).toBe('2027-02-08T07:30:00.000Z');
    expect(parseInstantRange('empty')).toBeNull();
  });
});
