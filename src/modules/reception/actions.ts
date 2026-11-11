'use server';

import { z } from 'zod';

import { loadWorkspace } from '@/modules/tenancy/workspace';
import { toErrorCode } from '@/shared/lib/errors';
import type { ActionResult } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

/*
 * Reception commands (module 7). Each calls a guarded database function with the caller's
 * session: permission (queue.check_in, queue.mark_left), "today" in the clinic's time zone,
 * gapless tickets and queue order are decided by PostgreSQL.
 */

const uuid = z.uuid();
const ticketRow = z.object({ queue_entry_id: uuid, ticket_number: z.number().int() });
const walkInRow = ticketRow.extend({ appointment_id: uuid });

function first(data: unknown): unknown {
  return Array.isArray(data) ? data[0] : data;
}

export async function checkIn(input: { id: string; version: number }): Promise<ActionResult<{ ticket: number }>> {
  const parsed = z.object({ id: uuid, version: z.number().int().positive() }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { data, error } = await supabase.rpc('check_in_appointment', { p_appointment_id: parsed.data.id, p_expected_version: parsed.data.version });
  if (error) return { ok: false, code: toErrorCode(error) };
  const row = ticketRow.safeParse(first(data));
  return row.success ? { ok: true, data: { ticket: row.data.ticket_number } } : { ok: false, code: 'INTERNAL' };
}

const walkInSchema = z.object({
  clinicSlug: z.string().min(1),
  patientId: uuid,
  doctorId: uuid,
  serviceId: uuid,
  /** Generated when the dialog opens: a double submit cannot register the patient twice. */
  idempotencyKey: z.string().min(8).max(100),
  patientReason: z.string().trim().max(200).optional(),
});

export async function registerWalkIn(input: z.input<typeof walkInSchema>): Promise<ActionResult<{ ticket: number; appointmentId: string }>> {
  const parsed = walkInSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const workspace = await loadWorkspace(parsed.data.clinicSlug);
  if (workspace.status !== 'ok') return { ok: false, code: workspace.status === 'unavailable' ? 'UNAVAILABLE' : 'FORBIDDEN' };
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { data, error } = await supabase.rpc('register_walk_in', {
    p_patient_id: parsed.data.patientId,
    p_doctor_id: parsed.data.doctorId,
    p_service_id: parsed.data.serviceId,
    p_idempotency_key: parsed.data.idempotencyKey,
    p_patient_reason: parsed.data.patientReason || null,
  });
  if (error) return { ok: false, code: toErrorCode(error) };
  const row = walkInRow.safeParse(first(data));
  return row.success ? { ok: true, data: { ticket: row.data.ticket_number, appointmentId: row.data.appointment_id } } : { ok: false, code: 'INTERNAL' };
}

export async function markLeft(input: { queueEntryId: string; note?: string }): Promise<ActionResult> {
  const parsed = z.object({ queueEntryId: uuid, note: z.string().trim().max(300).optional() }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { error } = await supabase.rpc('mark_left', { p_queue_entry_id: parsed.data.queueEntryId, p_note: parsed.data.note || null });
  return error ? { ok: false, code: toErrorCode(error) } : { ok: true, data: undefined };
}
