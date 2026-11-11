'use server';

import { z } from 'zod';

import { loadWorkspace } from '@/modules/tenancy/workspace';
import { toErrorCode } from '@/shared/lib/errors';
import type { ActionResult } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';
import { zonedInstant } from '@/shared/lib/time';

import { scheduleSchema, splitLocalDateTime, timeOffSchema, type ScheduleInput, type TimeOffInput } from './schemas';

/*
 * Availability commands (module 5).
 * - A schedule and its windows are saved atomically by save_doctor_schedule (schedules.manage,
 *   doctors limited to their own agenda, checked by the database).
 * - Deleting a schedule and time off are managed-table writes under RLS.
 * None of them moves or cancels appointments (BR-B-12): the page lists the conflicts afterwards.
 */

function fieldErrors(issues: z.ZodError['issues']): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of issues) fields[String(issue.path[0])] ??= issue.message;
  return fields;
}

async function context(clinicSlug: string) {
  const workspace = await loadWorkspace(clinicSlug);
  const supabase = await getSupabase();
  if (workspace.status !== 'ok' || !supabase) return null;
  return { clinicId: workspace.workspace.clinic.id, timeZone: workspace.workspace.clinic.timezone, supabase };
}

/** RLS hides rows silently: a write that touched no row means no permission (or not found). */
function oneRow(data: unknown): boolean {
  return Array.isArray(data) && data.length === 1;
}

export async function saveSchedule(
  clinicSlug: string,
  doctorId: string,
  scheduleId: string | null,
  input: ScheduleInput,
): Promise<ActionResult<{ id: string }>> {
  const parsed = scheduleSchema.safeParse(input);
  const doctor = z.uuid().safeParse(doctorId);
  const schedule = z.uuid().nullable().safeParse(scheduleId);
  if (!parsed.success || !doctor.success || !schedule.success) {
    return { ok: false, code: 'VALIDATION_FAILED', fields: parsed.success ? {} : fieldErrors(parsed.error.issues) };
  }
  const ctx = await context(clinicSlug);
  if (!ctx) return { ok: false, code: 'UNAVAILABLE' };
  const v = parsed.data;
  const { data, error } = await ctx.supabase.rpc('save_doctor_schedule', {
    p_doctor_id: doctor.data,
    p_schedule_id: schedule.data,
    p_kind: v.kind,
    p_name: v.name,
    p_valid_from: v.validFrom,
    p_valid_until: v.validUntil || null,
    p_windows: v.windows,
  });
  if (error) return { ok: false, code: toErrorCode(error) };
  const id = z.uuid().safeParse(data);
  return id.success ? { ok: true, data: { id: id.data } } : { ok: false, code: 'INTERNAL' };
}

/** Deletes a schedule and its windows (FK cascade). Appointments are never touched. */
export async function deleteSchedule(clinicSlug: string, scheduleId: string): Promise<ActionResult> {
  const id = z.uuid().safeParse(scheduleId);
  if (!id.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const ctx = await context(clinicSlug);
  if (!ctx) return { ok: false, code: 'UNAVAILABLE' };
  const { data, error } = await ctx.supabase.from('doctor_schedules').delete().eq('id', id.data).eq('clinic_id', ctx.clinicId).select('id');
  if (error) return { ok: false, code: toErrorCode(error) };
  return oneRow(data) ? { ok: true, data: undefined } : { ok: false, code: 'FORBIDDEN' };
}

/** Records time off. Local date-times are converted with the clinic's time zone, per date (BR-TZ-02). */
export async function addTimeOff(clinicSlug: string, doctorId: string, input: TimeOffInput): Promise<ActionResult> {
  const parsed = timeOffSchema.safeParse(input);
  const doctor = z.uuid().safeParse(doctorId);
  if (!parsed.success || !doctor.success) {
    return { ok: false, code: 'VALIDATION_FAILED', fields: parsed.success ? {} : fieldErrors(parsed.error.issues) };
  }
  const ctx = await context(clinicSlug);
  if (!ctx) return { ok: false, code: 'UNAVAILABLE' };
  const from = splitLocalDateTime(parsed.data.startsAt);
  const to = splitLocalDateTime(parsed.data.endsAt);
  const start = zonedInstant(from.day, from.time, ctx.timeZone);
  const end = zonedInstant(to.day, to.time, ctx.timeZone);
  if (end <= start) return { ok: false, code: 'VALIDATION_FAILED', fields: { endsAt: 'endBeforeStart' } };
  const { data, error } = await ctx.supabase
    .from('doctor_time_off')
    .insert({
      clinic_id: ctx.clinicId,
      doctor_id: doctor.data,
      period: `[${start.toISOString()},${end.toISOString()})`,
      reason_category: parsed.data.reason,
      note: parsed.data.note || null,
    })
    .select('id');
  if (error) return { ok: false, code: toErrorCode(error) };
  return oneRow(data) ? { ok: true, data: undefined } : { ok: false, code: 'FORBIDDEN' };
}

export async function deleteTimeOff(clinicSlug: string, timeOffId: string): Promise<ActionResult> {
  const id = z.uuid().safeParse(timeOffId);
  if (!id.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const ctx = await context(clinicSlug);
  if (!ctx) return { ok: false, code: 'UNAVAILABLE' };
  const { data, error } = await ctx.supabase.from('doctor_time_off').delete().eq('id', id.data).eq('clinic_id', ctx.clinicId).select('id');
  if (error) return { ok: false, code: toErrorCode(error) };
  return oneRow(data) ? { ok: true, data: undefined } : { ok: false, code: 'FORBIDDEN' };
}
