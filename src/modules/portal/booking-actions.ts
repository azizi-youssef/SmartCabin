'use server';

import { z } from 'zod';

import { toErrorCode } from '@/shared/lib/errors';
import type { ActionResult } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

import { RELATIONSHIPS, type Relationship } from './booking-domain';

/*
 * Online booking commands (S7). Free slots are public; booking, the people list and cancellation
 * need the patient's phone account. Every rule is checked again by the database.
 */

const uuid = z.uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

async function client() {
  return getSupabase();
}

export async function fetchOnlineSlots(input: { slug: string; doctorId: string; serviceId: string; from: string; to: string }): Promise<ActionResult<string[]>> {
  const parsed = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,80}$/), doctorId: uuid, serviceId: uuid, from: day, to: day }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const supabase = await client();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { data, error } = await supabase.rpc('public_get_available_slots', {
    p_slug: parsed.data.slug,
    p_doctor_id: parsed.data.doctorId,
    p_service_id: parsed.data.serviceId,
    p_from: parsed.data.from,
    p_to: parsed.data.to,
  });
  if (error) return { ok: false, code: toErrorCode(error) };
  const rows = z.array(z.object({ slot_starts_at: z.string() })).safeParse(data);
  return rows.success ? { ok: true, data: rows.data.map((r) => new Date(r.slot_starts_at).toISOString()) } : { ok: false, code: 'INTERNAL' };
}

export interface MyPerson {
  patientId: string;
  firstName: string;
  lastName: string;
  relationship: Relationship;
}

export async function loadMyPeople(input: { clinicId: string }): Promise<ActionResult<MyPerson[]>> {
  if (!uuid.safeParse(input.clinicId).success) return { ok: false, code: 'VALIDATION_FAILED' };
  const supabase = await client();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { data, error } = await supabase.rpc('portal_list_my_people', { p_clinic_id: input.clinicId });
  if (error) return { ok: false, code: toErrorCode(error) };
  const rows = z.array(z.object({ patient_id: uuid, first_name: z.string(), last_name: z.string(), relationship: z.enum(RELATIONSHIPS) })).safeParse(data);
  if (!rows.success) return { ok: false, code: 'INTERNAL' };
  return { ok: true, data: rows.data.map((r) => ({ patientId: r.patient_id, firstName: r.first_name, lastName: r.last_name, relationship: r.relationship })) };
}

const newPerson = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  relationship: z.enum(RELATIONSHIPS),
  dateOfBirth: day.or(z.literal('')),
  dataProcessing: z.literal(true),
  remindersSms: z.boolean(),
  locale: z.enum(['fr', 'ar']),
});

/** A1/A2: books for a linked person or for a new one created and linked now (BR-D-02). */
export async function bookOnline(input: {
  clinicId: string;
  doctorId: string;
  serviceId: string;
  startsAt: string;
  patientId?: string;
  newPerson?: z.input<typeof newPerson>;
  idempotencyKey: string;
}): Promise<ActionResult<{ status: 'pending' | 'confirmed' }>> {
  const parsed = z.object({
    clinicId: uuid,
    doctorId: uuid,
    serviceId: uuid,
    startsAt: z.iso.datetime({ offset: true }),
    patientId: uuid.optional(),
    newPerson: newPerson.optional(),
    idempotencyKey: z.string().min(8).max(100),
  }).refine((v) => Boolean(v.patientId) !== Boolean(v.newPerson)).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const d = parsed.data;
  const supabase = await client();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { data, error } = await supabase.rpc('portal_book_appointment', {
    p_clinic_id: d.clinicId,
    p_doctor_id: d.doctorId,
    p_service_id: d.serviceId,
    p_starts_at: d.startsAt,
    p_patient_id: d.patientId ?? null,
    p_new_person: d.newPerson
      ? {
          first_name: d.newPerson.firstName,
          last_name: d.newPerson.lastName,
          relationship: d.newPerson.relationship,
          date_of_birth: d.newPerson.dateOfBirth || null,
          preferred_locale: d.newPerson.locale,
          data_processing: true,
          reminders_sms: d.newPerson.remindersSms,
        }
      : null,
    p_idempotency_key: d.idempotencyKey,
  });
  if (error) return { ok: false, code: toErrorCode(error) };
  const row = z.array(z.object({ status: z.enum(['pending', 'confirmed']) })).safeParse(data);
  return row.success && row.data[0] ? { ok: true, data: { status: row.data[0].status } } : { ok: false, code: 'INTERNAL' };
}

/** A6 by the patient, before the clinic's cutoff. */
export async function cancelMyAppointment(input: { appointmentId: string }): Promise<ActionResult> {
  if (!uuid.safeParse(input.appointmentId).success) return { ok: false, code: 'VALIDATION_FAILED' };
  const supabase = await client();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { error } = await supabase.rpc('portal_cancel_appointment', { p_appointment_id: input.appointmentId });
  return error ? { ok: false, code: toErrorCode(error) } : { ok: true, data: undefined };
}
