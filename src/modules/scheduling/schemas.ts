import { z } from 'zod';

import { isLocalDay } from '@/shared/lib/time';

/*
 * Availability inputs (module 5). Times are local wall-clock times of the clinic (BR-TZ-01);
 * the database converts them per date (BR-TZ-02). Messages are i18n keys under `forms.errors`.
 * The database re-checks everything (grid, order, overlaps) in save_doctor_schedule.
 */

/** ISO weekdays: Monday = 1 … Sunday = 7 (same numbering as doctor_availability.weekday). */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const WORKING_DAYS = [1, 2, 3, 4, 5, 6] as const;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d$/;

export function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export interface ScheduleWindow {
  weekday: number;
  start: string;
  end: string;
}

export const windowSchema = z
  .object({
    weekday: z.number().int().min(1).max(7),
    start: z.string().regex(TIME, 'invalidTime'),
    end: z.string().regex(TIME, 'invalidTime'),
  })
  .superRefine((w, ctx) => {
    if (!TIME.test(w.start) || !TIME.test(w.end)) return;
    if (toMinutes(w.start) % 5 !== 0 || toMinutes(w.end) % 5 !== 0) {
      ctx.addIssue({ code: 'custom', path: ['start'], message: 'timeStep' });
    } else if (toMinutes(w.end) <= toMinutes(w.start)) {
      ctx.addIssue({ code: 'custom', path: ['end'], message: 'endBeforeStart' });
    }
  });

/** Windows of one schedule: no two windows of the same weekday may overlap. */
export const windowsSchema = z
  .array(windowSchema)
  .max(100, 'outOfRange')
  .superRefine((windows, ctx) => {
    windows.forEach((w, i) => {
      if (!TIME.test(w.start) || !TIME.test(w.end)) return;
      const clash = windows.some(
        (o, j) => j < i && o.weekday === w.weekday && TIME.test(o.start) && TIME.test(o.end)
          && toMinutes(o.start) < toMinutes(w.end) && toMinutes(w.start) < toMinutes(o.end),
      );
      if (clash) ctx.addIssue({ code: 'custom', path: [i, 'start'], message: 'windowOverlap' });
    });
  });

export const SCHEDULE_KINDS = ['regular', 'override'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export const scheduleSchema = z
  .object({
    kind: z.enum(SCHEDULE_KINDS),
    name: z.string().trim().min(2, 'required').max(80, 'tooLong'),
    validFrom: z.string().refine(isLocalDay, 'invalidDate'),
    validUntil: z.string().refine((v) => v === '' || isLocalDay(v), 'invalidDate').optional(),
    windows: windowsSchema,
  })
  .superRefine((v, ctx) => {
    // An override is always dated: an open-ended one would replace the regular hours forever.
    if (v.kind === 'override' && !v.validUntil) ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'required' });
    if (v.validUntil && isLocalDay(v.validUntil) && isLocalDay(v.validFrom) && v.validUntil < v.validFrom) {
      ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'endBeforeStart' });
    }
  });
export type ScheduleInput = z.input<typeof scheduleSchema>;

export const TIME_OFF_REASONS = ['leave', 'training', 'sick', 'personal', 'other'] as const;
export type TimeOffReason = (typeof TIME_OFF_REASONS)[number];

const localDateTime = z
  .string()
  .refine((v) => {
    const m = LOCAL_DATE_TIME.exec(v);
    return Boolean(m && isLocalDay(m[1]));
  }, 'invalidDate');

/** Time off in clinic-local date-times ("YYYY-MM-DDTHH:MM", as from <input type="datetime-local">). */
export const timeOffSchema = z
  .object({
    startsAt: localDateTime,
    endsAt: localDateTime,
    reason: z.enum(TIME_OFF_REASONS),
    note: z.string().trim().max(200, 'tooLong').optional().or(z.literal('')),
  })
  .refine((v) => v.endsAt > v.startsAt, { path: ['endsAt'], message: 'endBeforeStart' });
export type TimeOffInput = z.input<typeof timeOffSchema>;

/** Splits "YYYY-MM-DDTHH:MM" into its local day and time. */
export function splitLocalDateTime(value: string): { day: string; time: string } {
  return { day: value.slice(0, 10), time: value.slice(11, 16) };
}

/** Parses a PostgreSQL tstzrange such as ["2027-01-04 09:30:00+00","2027-01-04 12:00:00+00"). */
export function parseInstantRange(value: string): { start: string; end: string } | null {
  const m = /^[[(]"?([^",]+)"?,"?([^",)\]]+)"?[)\]]$/.exec(value.trim());
  if (!m?.[1] || !m[2]) return null;
  const start = new Date(m[1].replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  const end = new Date(m[2].replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Total opening minutes per week of a set of windows. */
export function weeklyMinutes(windows: readonly ScheduleWindow[]): number {
  return windows.reduce((sum, w) => sum + Math.max(0, toMinutes(w.end) - toMinutes(w.start)), 0);
}

export interface DoctorSchedule {
  id: string;
  kind: ScheduleKind;
  name: string;
  validFrom: string;
  validUntil: string | null;
  windows: ScheduleWindow[];
}

/**
 * The regular schedule shown for editing: the one in force on `today`, else the next one to
 * start, else the most recent one. Other regular versions are listed read-only.
 */
export function currentRegular(schedules: readonly DoctorSchedule[], today: string): DoctorSchedule | null {
  const regular = schedules.filter((s) => s.kind === 'regular');
  return (
    regular.find((s) => s.validFrom <= today && (s.validUntil === null || s.validUntil >= today))
    ?? [...regular].filter((s) => s.validFrom > today).sort((a, b) => a.validFrom.localeCompare(b.validFrom))[0]
    ?? [...regular].sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0]
    ?? null
  );
}

export function fromMinutes(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** First validation message per window index (i18n key under forms.errors). */
export function windowIssues(windows: readonly ScheduleWindow[]): Map<number, string> {
  const issues = new Map<number, string>();
  const result = windowsSchema.safeParse(windows);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const index = issue.path[0];
      if (typeof index === 'number' && !issues.has(index)) issues.set(index, issue.message);
    }
  }
  return issues;
}

/** A sensible new window for a day: 08:00–12:00, or one hour after the day's last window. */
export function suggestWindow(weekday: number, windows: readonly ScheduleWindow[]): ScheduleWindow {
  const ends = windows.filter((w) => w.weekday === weekday && TIME.test(w.end)).map((w) => toMinutes(w.end));
  if (ends.length === 0) return { weekday, start: '08:00', end: '12:00' };
  const start = Math.min(Math.max(...ends) + 60, 22 * 60);
  return { weekday, start: fromMinutes(start), end: fromMinutes(Math.min(start + 240, 23 * 60 + 55)) };
}

/** Replaces the windows of `targets` with copies of the windows of `source`. */
export function copyDay(windows: readonly ScheduleWindow[], source: number, targets: readonly number[]): ScheduleWindow[] {
  const model = windows.filter((w) => w.weekday === source);
  return sortWindows([
    ...windows.filter((w) => !targets.includes(w.weekday) || w.weekday === source),
    ...targets.filter((d) => d !== source).flatMap((weekday) => model.map((w) => ({ weekday, start: w.start, end: w.end }))),
  ]);
}

/** Windows sorted by weekday then start, the order used for display and comparison. */
export function sortWindows(windows: readonly ScheduleWindow[]): ScheduleWindow[] {
  return [...windows].sort((a, b) => a.weekday - b.weekday || toMinutes(a.start) - toMinutes(b.start));
}
