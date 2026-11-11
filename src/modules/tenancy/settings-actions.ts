'use server';

import { z } from 'zod';

import { toErrorCode } from '@/shared/lib/errors';
import { normalizePhone } from '@/shared/lib/phone';
import type { ActionResult } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

import { bookingPolicySchema, clinicProfileSchema, closureSchema, type BookingPolicyInput, type ClinicProfileInput, type ClosureInput } from './schemas';
import { loadWorkspace } from './workspace';

/*
 * Clinic settings. Managed tables written under RLS: the clinic id comes from the caller's
 * membership, column grants keep status/slug/time zone out of reach, and triggers enforce
 * invariants (e.g. online booking only when the clinic is active and bookable).
 */

function fieldErrors(issues: z.ZodError['issues']): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of issues) fields[String(issue.path[0])] = issue.message;
  return fields;
}

async function context(clinicSlug: string) {
  const workspace = await loadWorkspace(clinicSlug);
  const supabase = await getSupabase();
  if (workspace.status !== 'ok' || !supabase) return null;
  return { clinicId: workspace.workspace.clinic.id, supabase };
}

export async function updateClinicProfile(clinicSlug: string, input: ClinicProfileInput): Promise<ActionResult> {
  const parsed = clinicProfileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED', fields: fieldErrors(parsed.error.issues) };
  const ctx = await context(clinicSlug);
  if (!ctx) return { ok: false, code: 'UNAVAILABLE' };
  const v = parsed.data;
  const { data, error } = await ctx.supabase
    .from('clinics')
    .update({
      display_name: v.displayName,
      legal_name: v.legalName || null,
      city: v.city,
      address_line: v.addressLine || null,
      phone_e164: v.phone ? normalizePhone(v.phone) : null,
      email: v.email || null,
      ice: v.ice || null,
      default_locale: v.defaultLocale,
    })
    .eq('id', ctx.clinicId)
    .select('id');
  if (error) return { ok: false, code: toErrorCode(error) };
  // RLS filters rows silently: zero rows updated means no permission.
  return Array.isArray(data) && data.length === 1 ? { ok: true, data: undefined } : { ok: false, code: 'FORBIDDEN' };
}

export async function updateBookingPolicy(clinicSlug: string, input: BookingPolicyInput): Promise<ActionResult> {
  const parsed = bookingPolicySchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED', fields: fieldErrors(parsed.error.issues) };
  const ctx = await context(clinicSlug);
  if (!ctx) return { ok: false, code: 'UNAVAILABLE' };
  const v = parsed.data;
  const { data, error } = await ctx.supabase
    .from('clinic_settings')
    .update({
      online_booking_enabled: v.onlineBookingEnabled,
      auto_confirm_online: v.autoConfirmOnline,
      min_lead_minutes: v.minLeadMinutes,
      max_horizon_days: v.maxHorizonDays,
      patient_cancel_cutoff_hours: v.patientCancelCutoffHours,
      max_active_online_bookings: v.maxActiveOnlineBookings,
      reminder_offsets_minutes: [v.reminderHoursBefore * 60],
      checkin_grace_minutes: v.checkinGraceMinutes,
      turn_approaching_positions: v.turnApproachingPositions,
      sms_sender_name: v.smsSenderName || null,
    })
    .eq('clinic_id', ctx.clinicId)
    .select('clinic_id');
  if (error) return { ok: false, code: toErrorCode(error) };
  return Array.isArray(data) && data.length === 1 ? { ok: true, data: undefined } : { ok: false, code: 'FORBIDDEN' };
}

export async function addClosure(clinicSlug: string, input: ClosureInput): Promise<ActionResult> {
  const parsed = closureSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED', fields: fieldErrors(parsed.error.issues) };
  const ctx = await context(clinicSlug);
  if (!ctx) return { ok: false, code: 'UNAVAILABLE' };
  const { error } = await ctx.supabase.from('clinic_closures').insert({
    clinic_id: ctx.clinicId,
    dates: `[${parsed.data.from},${parsed.data.to}]`,
    reason: parsed.data.reason,
  });
  if (error) return { ok: false, code: error.code === '23P01' ? 'DUPLICATE' : toErrorCode(error) };
  return { ok: true, data: undefined };
}

export async function removeClosure(clinicSlug: string, closureId: string): Promise<ActionResult> {
  const id = z.uuid().safeParse(closureId);
  if (!id.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const ctx = await context(clinicSlug);
  if (!ctx) return { ok: false, code: 'UNAVAILABLE' };
  const { data, error } = await ctx.supabase.from('clinic_closures').delete().eq('id', id.data).eq('clinic_id', ctx.clinicId).select('id');
  if (error) return { ok: false, code: toErrorCode(error) };
  return Array.isArray(data) && data.length === 1 ? { ok: true, data: undefined } : { ok: false, code: 'NOT_FOUND' };
}

/** Owner accepts the current data processing agreement for the clinic (RLS: owner with MFA). */
export async function acceptClinicDpa(clinicSlug: string): Promise<ActionResult> {
  const ctx = await context(clinicSlug);
  if (!ctx) return { ok: false, code: 'UNAVAILABLE' };
  const doc = await ctx.supabase.from('legal_documents').select('id').eq('kind', 'clinic_dpa').eq('is_current', true).limit(1).maybeSingle();
  const row = z.object({ id: z.uuid() }).nullable().safeParse(doc.data);
  if (doc.error || !row.success || !row.data) return { ok: false, code: 'LEGAL_ACCEPTANCE_REQUIRED' };
  const { error } = await ctx.supabase
    .from('legal_acceptances')
    .upsert({ document_id: row.data.id, clinic_id: ctx.clinicId, context: 'clinic_creation' }, { onConflict: 'document_id,user_id,clinic_id', ignoreDuplicates: true });
  return error ? { ok: false, code: toErrorCode(error) } : { ok: true, data: undefined };
}
