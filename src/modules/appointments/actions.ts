'use server';

import { z } from 'zod';

import { loadWorkspace } from '@/modules/tenancy/workspace';
import { toErrorCode } from '@/shared/lib/errors';
import type { ActionResult } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';
import { isLocalDay } from '@/shared/lib/time';

import { STAFF_CANCELLATION_REASONS } from './domain/status';

/*
 * Server Actions are public POST endpoints: each one validates its input and calls a guarded
 * database command with the caller's own session. The database decides; nothing here grants access.
 */

const uuid = z.uuid();
const version = z.number().int().positive();

async function client() {
  const supabase = await getSupabase();
  if (!supabase) throw new Error('UNAVAILABLE');
  return supabase;
}

function failure(error: unknown): ActionResult<never> {
  if (error instanceof Error && error.message === 'UNAVAILABLE') return { ok: false, code: 'UNAVAILABLE' };
  return { ok: false, code: toErrorCode(error) };
}

export async function confirmAppointment(input: { id: string; version: number }): Promise<ActionResult> {
  const parsed = z.object({ id: uuid, version }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  try {
    const { error } = await (await client()).rpc('confirm_appointment', {
      p_appointment_id: parsed.data.id,
      p_expected_version: parsed.data.version,
    });
    return error ? failure(error) : { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

export async function cancelAppointment(input: {
  id: string;
  version: number;
  reason: string;
  note?: string;
}): Promise<ActionResult> {
  const parsed = z
    .object({ id: uuid, version, reason: z.enum(STAFF_CANCELLATION_REASONS), note: z.string().trim().max(300).optional() })
    .safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  try {
    const { error } = await (await client()).rpc('cancel_appointment', {
      p_appointment_id: parsed.data.id,
      p_reason: parsed.data.reason,
      p_note: parsed.data.note || null,
      p_expected_version: parsed.data.version,
    });
    return error ? failure(error) : { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

export async function markNoShow(input: { id: string; version: number }): Promise<ActionResult> {
  const parsed = z.object({ id: uuid, version }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  try {
    const { error } = await (await client()).rpc('mark_no_show', {
      p_appointment_id: parsed.data.id,
      p_expected_version: parsed.data.version,
    });
    return error ? failure(error) : { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

export async function rescheduleAppointment(input: { id: string; version: number; startsAt: string }): Promise<ActionResult> {
  const parsed = z.object({ id: uuid, version, startsAt: z.iso.datetime({ offset: true }) }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  try {
    const { error } = await (await client()).rpc('reschedule_appointment', {
      p_appointment_id: parsed.data.id,
      p_new_starts_at: parsed.data.startsAt,
      p_expected_version: parsed.data.version,
    });
    return error ? failure(error) : { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

export interface SlotOption {
  startsAt: string;
  endsAt: string;
}

/** Free slots computed by the database (availability, time off, closures, existing bookings). */
export async function fetchSlots(input: { doctorId: string; serviceId: string; day: string }): Promise<ActionResult<SlotOption[]>> {
  const parsed = z.object({ doctorId: uuid, serviceId: uuid, day: z.string().refine(isLocalDay) }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  try {
    const { data, error } = await (await client()).rpc('get_available_slots', {
      p_doctor_id: parsed.data.doctorId,
      p_service_id: parsed.data.serviceId,
      p_from: parsed.data.day,
      p_to: parsed.data.day,
    });
    if (error) return failure(error);
    const rows = z.array(z.object({ slot_starts_at: z.string(), slot_ends_at: z.string() })).safeParse(data);
    if (!rows.success) return { ok: false, code: 'INTERNAL' };
    return { ok: true, data: rows.data.map((r) => ({ startsAt: r.slot_starts_at, endsAt: r.slot_ends_at })) };
  } catch (error) {
    return failure(error);
  }
}

const bookingSchema = z.object({
  clinicSlug: z.string().min(1),
  patientId: uuid,
  doctorId: uuid,
  serviceId: uuid,
  startsAt: z.iso.datetime({ offset: true }),
  /** Generated when the booking form opens: a double submit or a retry cannot create two appointments. */
  idempotencyKey: z.string().min(8).max(100),
  overbookReason: z.string().trim().min(3).max(200).optional(),
  /** Visit reason, optional; readable only with appointments.view_reason. */
  patientReason: z.string().trim().max(200).optional(),
});

export async function bookAppointment(input: z.input<typeof bookingSchema>): Promise<ActionResult<{ id: string }>> {
  const parsed = bookingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const workspace = await loadWorkspace(parsed.data.clinicSlug);
  if (workspace.status !== 'ok') return { ok: false, code: workspace.status === 'unavailable' ? 'UNAVAILABLE' : 'FORBIDDEN' };
  try {
    const { data, error } = await (await client()).rpc('book_appointment', {
      p_patient_id: parsed.data.patientId,
      p_doctor_id: parsed.data.doctorId,
      p_service_id: parsed.data.serviceId,
      p_starts_at: parsed.data.startsAt,
      p_idempotency_key: parsed.data.idempotencyKey,
      p_is_overbooked: Boolean(parsed.data.overbookReason),
      p_overbook_reason: parsed.data.overbookReason ?? null,
      p_patient_reason: parsed.data.patientReason || null,
    });
    if (error) return failure(error);
    const row = z.object({ id: uuid }).safeParse(data);
    return row.success ? { ok: true, data: { id: row.data.id } } : { ok: false, code: 'INTERNAL' };
  } catch (error) {
    return failure(error);
  }
}
