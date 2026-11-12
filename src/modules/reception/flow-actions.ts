'use server';

import { z } from 'zod';

import { toErrorCode } from '@/shared/lib/errors';
import type { ActionResult } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

import { PRIORITY_REASONS } from './queue';

/*
 * SmartFlow commands (module 8a). Every rule (permission, doctor scope, one patient at a time,
 * queue order, correction windows) is decided by the database with the caller's session.
 */

const uuid = z.uuid();
const reason = z.string().trim().min(3).max(300);

async function rpc(fn: string, args: Record<string, unknown>): Promise<ActionResult<unknown>> {
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { data, error } = await supabase.rpc(fn, args);
  return error ? { ok: false, code: toErrorCode(error) } : { ok: true, data };
}

function done(result: ActionResult<unknown>): ActionResult {
  return result.ok ? { ok: true, data: undefined } : result;
}

/** Calls the next patient; `ticket` is null when nobody is waiting. */
export async function callNext(sessionId: string): Promise<ActionResult<{ ticket: number | null }>> {
  if (!uuid.safeParse(sessionId).success) return { ok: false, code: 'VALIDATION_FAILED' };
  const result = await rpc('call_next', { p_session_id: sessionId });
  if (!result.ok) return result;
  const row = z.array(z.object({ ticket_number: z.number().int() })).safeParse(result.data);
  return { ok: true, data: { ticket: row.success ? (row.data[0]?.ticket_number ?? null) : null } };
}

export async function recallEntry(entryId: string): Promise<ActionResult> {
  if (!uuid.safeParse(entryId).success) return { ok: false, code: 'VALIDATION_FAILED' };
  return done(await rpc('recall_entry', { p_queue_entry_id: entryId }));
}

export async function startConsultation(entryId: string): Promise<ActionResult> {
  if (!uuid.safeParse(entryId).success) return { ok: false, code: 'VALIDATION_FAILED' };
  return done(await rpc('start_consultation', { p_queue_entry_id: entryId }));
}

export async function completeConsultation(entryId: string): Promise<ActionResult> {
  if (!uuid.safeParse(entryId).success) return { ok: false, code: 'VALIDATION_FAILED' };
  return done(await rpc('complete_consultation', { p_queue_entry_id: entryId }));
}

export async function setPriority(input: { entryId: string; priority: boolean; reason?: string }): Promise<ActionResult> {
  const parsed = z.object({ entryId: uuid, priority: z.boolean(), reason: z.enum(PRIORITY_REASONS).optional() })
    .refine((v) => !v.priority || v.reason, 'reason').safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  return done(await rpc('set_queue_priority', {
    p_queue_entry_id: parsed.data.entryId,
    p_level: parsed.data.priority ? 1 : 0,
    p_reason: parsed.data.priority ? parsed.data.reason : null,
  }));
}

export async function moveBefore(input: { entryId: string; beforeEntryId: string; reason: string }): Promise<ActionResult> {
  const parsed = z.object({ entryId: uuid, beforeEntryId: uuid, reason }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  return done(await rpc('move_queue_entry_before', {
    p_queue_entry_id: parsed.data.entryId,
    p_before_entry_id: parsed.data.beforeEntryId,
    p_reason: parsed.data.reason,
  }));
}

/** A13 (started by mistake) or A14 (late arrival after a no-show): back to checked in. */
export async function correctToCheckedIn(input: { appointmentId: string; reason: string }): Promise<ActionResult> {
  const parsed = z.object({ appointmentId: uuid, reason }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  return done(await rpc('correct_appointment_status', {
    p_appointment_id: parsed.data.appointmentId,
    p_target: 'checked_in',
    p_reason: parsed.data.reason,
  }));
}

export async function openDay(doctorId: string): Promise<ActionResult> {
  if (!uuid.safeParse(doctorId).success) return { ok: false, code: 'VALIDATION_FAILED' };
  return done(await rpc('open_doctor_day', { p_doctor_id: doctorId }));
}

export async function pauseDay(sessionId: string): Promise<ActionResult> {
  if (!uuid.safeParse(sessionId).success) return { ok: false, code: 'VALIDATION_FAILED' };
  return done(await rpc('pause_doctor_session', { p_session_id: sessionId }));
}

export async function resumeDay(sessionId: string): Promise<ActionResult> {
  if (!uuid.safeParse(sessionId).success) return { ok: false, code: 'VALIDATION_FAILED' };
  return done(await rpc('resume_doctor_session', { p_session_id: sessionId }));
}

/** Closes the day; returns how many patients were still waiting (staff resolve them). */
export async function closeDay(sessionId: string): Promise<ActionResult<{ stillWaiting: number }>> {
  if (!uuid.safeParse(sessionId).success) return { ok: false, code: 'VALIDATION_FAILED' };
  const result = await rpc('close_doctor_session', { p_session_id: sessionId });
  if (!result.ok) return result;
  const n = z.number().int().safeParse(result.data);
  return { ok: true, data: { stillWaiting: n.success ? n.data : 0 } };
}

export async function reportDelay(input: { doctorId: string; minutes: number }): Promise<ActionResult> {
  const parsed = z.object({ doctorId: uuid, minutes: z.number().int().min(0).max(600) }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  return done(await rpc('report_doctor_delay', { p_doctor_id: parsed.data.doctorId, p_minutes: parsed.data.minutes }));
}
