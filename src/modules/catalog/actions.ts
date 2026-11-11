'use server';

import { z } from 'zod';

import { loadWorkspace } from '@/modules/tenancy/workspace';
import { toErrorCode } from '@/shared/lib/errors';
import { normalizePhone } from '@/shared/lib/phone';
import type { ActionResult } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

import { doctorSchema, doctorServicesSchema, serviceSchema, type DoctorInput, type DoctorServiceItemInput, type ServiceInput } from './schemas';

/*
 * Catalog commands. Doctors and services are managed tables written under RLS (doctors.manage,
 * services.manage); the doctor's offered services go through the atomic set_doctor_services.
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

/** RLS hides rows silently: a write that touched no row means no permission (or not found). */
function oneRow(data: unknown): boolean {
  return Array.isArray(data) && data.length === 1;
}

function doctorRow(v: z.output<typeof doctorSchema>) {
  return {
    full_name: v.fullName,
    full_name_ar: v.fullNameAr || null,
    specialty_id: v.specialtyId || null,
    inpe: v.inpe || null,
    phone_e164: v.phone ? normalizePhone(v.phone) : null,
    user_id: v.userId || null,
    online_bookable: v.onlineBookable,
  };
}

export async function createDoctor(clinicSlug: string, input: DoctorInput): Promise<ActionResult<{ id: string }>> {
  const parsed = doctorSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED', fields: fieldErrors(parsed.error.issues) };
  const ctx = await context(clinicSlug);
  if (!ctx) return { ok: false, code: 'UNAVAILABLE' };
  const { data, error } = await ctx.supabase.from('doctors').insert({ clinic_id: ctx.clinicId, ...doctorRow(parsed.data) }).select('id').single();
  if (error) return { ok: false, code: error.code === '23505' ? 'DUPLICATE' : toErrorCode(error) };
  const row = z.object({ id: z.uuid() }).safeParse(data);
  return row.success ? { ok: true, data: { id: row.data.id } } : { ok: false, code: 'INTERNAL' };
}

export async function updateDoctor(clinicSlug: string, doctorId: string, input: DoctorInput): Promise<ActionResult> {
  const parsed = doctorSchema.safeParse(input);
  const id = z.uuid().safeParse(doctorId);
  if (!parsed.success || !id.success) return { ok: false, code: 'VALIDATION_FAILED', fields: parsed.success ? {} : fieldErrors(parsed.error.issues) };
  const ctx = await context(clinicSlug);
  if (!ctx) return { ok: false, code: 'UNAVAILABLE' };
  const { data, error } = await ctx.supabase.from('doctors').update(doctorRow(parsed.data)).eq('id', id.data).eq('clinic_id', ctx.clinicId).select('id');
  if (error) return { ok: false, code: error.code === '23505' ? 'DUPLICATE' : toErrorCode(error) };
  return oneRow(data) ? { ok: true, data: undefined } : { ok: false, code: 'FORBIDDEN' };
}

export async function setDoctorActive(clinicSlug: string, doctorId: string, active: boolean): Promise<ActionResult> {
  const id = z.uuid().safeParse(doctorId);
  if (!id.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const ctx = await context(clinicSlug);
  if (!ctx) return { ok: false, code: 'UNAVAILABLE' };
  const { data, error } = await ctx.supabase
    .from('doctors')
    .update({ status: active ? 'active' : 'inactive', ...(active ? {} : { online_bookable: false }) })
    .eq('id', id.data)
    .eq('clinic_id', ctx.clinicId)
    .select('id');
  if (error) return { ok: false, code: toErrorCode(error) };
  return oneRow(data) ? { ok: true, data: undefined } : { ok: false, code: 'FORBIDDEN' };
}

export async function countFutureAppointments(doctorId: string): Promise<ActionResult<number>> {
  const id = z.uuid().safeParse(doctorId);
  if (!id.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { data, error } = await supabase.rpc('count_future_appointments', { p_doctor_id: id.data });
  if (error) return { ok: false, code: toErrorCode(error) };
  return { ok: true, data: typeof data === 'number' ? data : 0 };
}

export async function saveDoctorServices(doctorId: string, items: DoctorServiceItemInput[]): Promise<ActionResult> {
  const id = z.uuid().safeParse(doctorId);
  const parsed = doctorServicesSchema.safeParse(items);
  if (!id.success || !parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const payload = parsed.data.map((i) => ({
    service_id: i.serviceId,
    duration_minutes: i.durationMinutes === '' || i.durationMinutes === undefined ? null : i.durationMinutes,
    price_mad: i.priceMad === '' || i.priceMad === undefined ? null : i.priceMad,
    online_bookable: i.onlineBookable,
  }));
  const { error } = await supabase.rpc('set_doctor_services', { p_doctor_id: id.data, p_services: payload });
  return error ? { ok: false, code: toErrorCode(error) } : { ok: true, data: undefined };
}

function serviceRow(v: z.output<typeof serviceSchema>) {
  return {
    name_fr: v.nameFr || null,
    name_ar: v.nameAr || null,
    specialty_id: v.specialtyId || null,
    default_duration_minutes: v.durationMinutes,
    price_mad: v.priceMad,
    online_bookable: v.onlineBookable,
  };
}

export async function createService(clinicSlug: string, input: ServiceInput): Promise<ActionResult<{ id: string }>> {
  const parsed = serviceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED', fields: fieldErrors(parsed.error.issues) };
  const ctx = await context(clinicSlug);
  if (!ctx) return { ok: false, code: 'UNAVAILABLE' };
  const { data, error } = await ctx.supabase.from('services').insert({ clinic_id: ctx.clinicId, ...serviceRow(parsed.data) }).select('id').single();
  if (error) return { ok: false, code: error.code === '23505' ? 'DUPLICATE' : toErrorCode(error) };
  const row = z.object({ id: z.uuid() }).safeParse(data);
  return row.success ? { ok: true, data: { id: row.data.id } } : { ok: false, code: 'INTERNAL' };
}

export async function updateService(clinicSlug: string, serviceId: string, input: ServiceInput): Promise<ActionResult> {
  const parsed = serviceSchema.safeParse(input);
  const id = z.uuid().safeParse(serviceId);
  if (!parsed.success || !id.success) return { ok: false, code: 'VALIDATION_FAILED', fields: parsed.success ? {} : fieldErrors(parsed.error.issues) };
  const ctx = await context(clinicSlug);
  if (!ctx) return { ok: false, code: 'UNAVAILABLE' };
  const { data, error } = await ctx.supabase.from('services').update(serviceRow(parsed.data)).eq('id', id.data).eq('clinic_id', ctx.clinicId).select('id');
  if (error) return { ok: false, code: error.code === '23505' ? 'DUPLICATE' : toErrorCode(error) };
  return oneRow(data) ? { ok: true, data: undefined } : { ok: false, code: 'FORBIDDEN' };
}

/** Services are archived, never deleted once used (history, invoices). */
export async function setServiceArchived(clinicSlug: string, serviceId: string, archived: boolean): Promise<ActionResult> {
  const id = z.uuid().safeParse(serviceId);
  if (!id.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const ctx = await context(clinicSlug);
  if (!ctx) return { ok: false, code: 'UNAVAILABLE' };
  const { data, error } = await ctx.supabase
    .from('services')
    .update({ status: archived ? 'archived' : 'active', ...(archived ? { online_bookable: false } : {}) })
    .eq('id', id.data)
    .eq('clinic_id', ctx.clinicId)
    .select('id');
  if (error) return { ok: false, code: error.code === '23505' ? 'DUPLICATE' : toErrorCode(error) };
  return oneRow(data) ? { ok: true, data: undefined } : { ok: false, code: 'FORBIDDEN' };
}
