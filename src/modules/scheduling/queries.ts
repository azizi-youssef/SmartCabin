import 'server-only';

import { z } from 'zod';

import { toErrorCode } from '@/shared/lib/errors';
import type { Loaded } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

import { parseInstantRange, sortWindows, TIME_OFF_REASONS, type DoctorSchedule, type TimeOffReason } from './schemas';

/*
 * Availability reads (module 5), all under RLS with the caller's session (schedules.view).
 * Conflicts come from list_doctor_booking_conflicts, which applies the booking rules themselves.
 */

export interface TimeOff {
  id: string;
  startsAt: string;
  endsAt: string;
  reason: TimeOffReason;
  note: string | null;
}

export const CONFLICT_REASONS = ['outside_availability', 'doctor_time_off', 'clinic_closed'] as const;
export type ConflictReason = (typeof CONFLICT_REASONS)[number];

export interface BookingConflict {
  appointmentId: string;
  startsAt: string;
  endsAt: string;
  reason: ConflictReason;
}

export interface DoctorAvailability {
  schedules: DoctorSchedule[];
  timeOff: TimeOff[];
  conflicts: BookingConflict[];
}

const scheduleRows = z.array(z.object({
  id: z.uuid(),
  kind: z.enum(['regular', 'override']),
  name: z.string(),
  valid_from: z.string(),
  valid_until: z.string().nullable(),
}));
const windowRows = z.array(z.object({
  schedule_id: z.uuid(),
  weekday: z.number().int(),
  start_time: z.string(),
  end_time: z.string(),
}));
const timeOffRows = z.array(z.object({
  id: z.uuid(),
  period: z.string(),
  reason_category: z.enum(TIME_OFF_REASONS),
  note: z.string().nullable(),
}));
const conflictRows = z.array(z.object({
  appointment_id: z.uuid(),
  starts_at: z.string(),
  ends_at: z.string(),
  reason: z.string(),
}));

/** Time off shown: everything not finished more than this many days ago. */
const TIME_OFF_HISTORY_DAYS = 30;

export async function loadDoctorAvailability(clinicId: string, doctorId: string, now: Date): Promise<Loaded<DoctorAvailability>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const [schedules, windows, timeOff, conflicts] = await Promise.all([
    supabase.from('doctor_schedules').select('id, kind, name, valid_from, valid_until')
      .eq('clinic_id', clinicId).eq('doctor_id', doctorId).order('valid_from'),
    supabase.from('doctor_availability').select('schedule_id, weekday, start_time, end_time')
      .eq('clinic_id', clinicId).eq('doctor_id', doctorId).order('weekday').order('start_time'),
    supabase.from('doctor_time_off').select('id, period, reason_category, note')
      .eq('clinic_id', clinicId).eq('doctor_id', doctorId).order('period').limit(500),
    supabase.rpc('list_doctor_booking_conflicts', { p_doctor_id: doctorId }),
  ]);
  const failed = schedules.error ?? windows.error ?? timeOff.error ?? conflicts.error;
  if (failed) {
    const code = toErrorCode(failed);
    return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
  }
  const s = scheduleRows.safeParse(schedules.data);
  const w = windowRows.safeParse(windows.data);
  const o = timeOffRows.safeParse(timeOff.data);
  const c = conflictRows.safeParse(conflicts.data);
  if (!s.success || !w.success || !o.success || !c.success) return { status: 'error', code: 'INTERNAL' };

  const cutoff = now.getTime() - TIME_OFF_HISTORY_DAYS * 86_400_000;
  return {
    status: 'ok',
    data: {
      schedules: s.data.map((row) => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        windows: sortWindows(
          w.data
            .filter((x) => x.schedule_id === row.id)
            .map((x) => ({ weekday: x.weekday, start: x.start_time.slice(0, 5), end: x.end_time.slice(0, 5) })),
        ),
      })),
      timeOff: o.data.flatMap((row) => {
        const range = parseInstantRange(row.period);
        if (!range || new Date(range.end).getTime() < cutoff) return [];
        return [{ id: row.id, startsAt: range.start, endsAt: range.end, reason: row.reason_category, note: row.note }];
      }),
      conflicts: c.data.map((row) => ({
        appointmentId: row.appointment_id,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        reason: (CONFLICT_REASONS as readonly string[]).includes(row.reason) ? (row.reason as ConflictReason) : 'outside_availability',
      })),
    },
  };
}
