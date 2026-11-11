import 'server-only';

import { z } from 'zod';

import { toErrorCode } from '@/shared/lib/errors';
import type { Loaded } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

export interface PatientRow {
  id: string;
  fileNumber: string;
  firstName: string;
  lastName: string;
  firstNameAr: string | null;
  lastNameAr: string | null;
  sex: 'female' | 'male' | null;
  dateOfBirth: string | null;
  phone: string | null;
  preferredLocale: 'fr' | 'ar';
  status: 'active' | 'archived' | 'merged';
  createdAt: string;
}

const row = z.object({
  id: z.uuid(),
  file_number: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  first_name_ar: z.string().nullable(),
  last_name_ar: z.string().nullable(),
  sex: z.enum(['female', 'male']).nullable(),
  date_of_birth: z.string().nullable(),
  phone_e164: z.string().nullable(),
  preferred_locale: z.enum(['fr', 'ar']),
  status: z.enum(['active', 'archived', 'merged']),
  created_at: z.string(),
});

export const PATIENT_PAGE_SIZE = 50;

/** Removes characters that carry meaning in PostgREST filter syntax. */
export function sanitizeSearch(q: string): string {
  return q.replace(/[,()*%\\:"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/**
 * Patient search (name, Arabic name, file number, phone). Returns at most one page plus a flag
 * telling the UI to ask for a more precise search, instead of loading everything.
 */
export async function searchPatients(params: {
  clinicId: string;
  query: string;
}): Promise<Loaded<{ rows: PatientRow[]; hasMore: boolean }>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const q = sanitizeSearch(params.query);

  let query = supabase
    .from('patients')
    .select('id, file_number, first_name, last_name, first_name_ar, last_name_ar, sex, date_of_birth, phone_e164, preferred_locale, status, created_at')
    .eq('clinic_id', params.clinicId)
    .neq('status', 'merged')
    .limit(PATIENT_PAGE_SIZE + 1);

  if (q) {
    const digits = q.replace(/\D/g, '');
    const terms = [
      `first_name.ilike.*${q}*`,
      `last_name.ilike.*${q}*`,
      `first_name_ar.ilike.*${q}*`,
      `last_name_ar.ilike.*${q}*`,
      `file_number.ilike.*${q}*`,
    ];
    if (digits.length >= 4) terms.push(`phone_e164.ilike.*${digits.slice(-9)}*`);
    query = query.or(terms.join(',')).order('last_name').order('first_name');
  } else {
    query = query.order('created_at', { ascending: false });
  }

  const { data, error } = await query;
  if (error) {
    const code = toErrorCode(error);
    return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
  }
  const parsed = z.array(row).safeParse(data);
  if (!parsed.success) return { status: 'error', code: 'INTERNAL' };
  const rows = parsed.data.slice(0, PATIENT_PAGE_SIZE).map((r) => ({
    id: r.id,
    fileNumber: r.file_number,
    firstName: r.first_name,
    lastName: r.last_name,
    firstNameAr: r.first_name_ar,
    lastNameAr: r.last_name_ar,
    sex: r.sex,
    dateOfBirth: r.date_of_birth,
    phone: r.phone_e164,
    preferredLocale: r.preferred_locale,
    status: r.status,
    createdAt: r.created_at,
  }));
  return { status: 'ok', data: { rows, hasMore: parsed.data.length > PATIENT_PAGE_SIZE } };
}

function failure(error: unknown): Loaded<never> {
  const code = toErrorCode(error);
  return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
}

export interface PatientDetail extends PatientRow {
  clinicId: string;
  email: string | null;
  preferredChannel: 'sms' | 'whatsapp' | 'email' | 'none';
  mergedIntoId: string | null;
  createdVia: string;
}

/** Patient detail through get_patient, which also writes `patient.viewed` to the audit log. */
export async function loadPatient(patientId: string): Promise<Loaded<PatientDetail>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const { data, error } = await supabase.rpc('get_patient', { p_patient_id: patientId });
  if (error) return failure(error);
  const parsed = z
    .array(
      row.extend({
        clinic_id: z.uuid(),
        email: z.string().nullable(),
        preferred_channel: z.enum(['sms', 'whatsapp', 'email', 'none']),
        merged_into_id: z.uuid().nullable(),
        created_via: z.string(),
      }),
    )
    .safeParse(data);
  const r = parsed.success ? parsed.data[0] : undefined;
  if (!r) return parsed.success ? { status: 'error', code: 'NOT_FOUND' } : { status: 'error', code: 'INTERNAL' };
  return {
    status: 'ok',
    data: {
      id: r.id,
      clinicId: r.clinic_id,
      fileNumber: r.file_number,
      firstName: r.first_name,
      lastName: r.last_name,
      firstNameAr: r.first_name_ar,
      lastNameAr: r.last_name_ar,
      sex: r.sex,
      dateOfBirth: r.date_of_birth,
      phone: r.phone_e164,
      email: r.email,
      preferredLocale: r.preferred_locale,
      preferredChannel: r.preferred_channel,
      status: r.status,
      mergedIntoId: r.merged_into_id,
      createdVia: r.created_via,
      createdAt: r.created_at,
    },
  };
}

export interface ConsentRecord {
  purpose: string;
  granted: boolean;
  documentVersion: string;
  source: string;
  recordedAt: string;
}

/** Full consent history, newest first; the first row per purpose is the current decision. */
export async function loadConsents(patientIds: string[]): Promise<Loaded<ConsentRecord[]>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const { data, error } = await supabase
    .from('patient_consents')
    .select('purpose, granted, document_version, source, recorded_at')
    .in('patient_id', patientIds)
    .order('recorded_at', { ascending: false });
  if (error) return failure(error);
  const parsed = z
    .array(z.object({ purpose: z.string(), granted: z.boolean(), document_version: z.string(), source: z.string(), recorded_at: z.string() }))
    .safeParse(data);
  if (!parsed.success) return { status: 'error', code: 'INTERNAL' };
  return {
    status: 'ok',
    data: parsed.data.map((c) => ({ purpose: c.purpose, granted: c.granted, documentVersion: c.document_version, source: c.source, recordedAt: c.recorded_at })),
  };
}

export interface PatientAppointment {
  id: string;
  startsAt: string;
  status: string;
  doctorId: string;
  serviceId: string;
}

/** Appointments of the record and of the records merged into it (history stays on its record). */
export async function loadPatientAppointments(clinicId: string, patientIds: string[]): Promise<Loaded<PatientAppointment[]>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const { data, error } = await supabase
    .from('appointments')
    .select('id, starts_at, status, doctor_id, service_id')
    .eq('clinic_id', clinicId)
    .in('patient_id', patientIds)
    .order('starts_at', { ascending: false })
    .limit(100);
  if (error) return failure(error);
  const parsed = z.array(z.object({ id: z.uuid(), starts_at: z.string(), status: z.string(), doctor_id: z.uuid(), service_id: z.uuid() })).safeParse(data);
  if (!parsed.success) return { status: 'error', code: 'INTERNAL' };
  return { status: 'ok', data: parsed.data.map((a) => ({ id: a.id, startsAt: a.starts_at, status: a.status, doctorId: a.doctor_id, serviceId: a.service_id })) };
}

/** Records merged into this one (their ids extend the history queries). */
export async function loadMergedSources(clinicId: string, patientId: string): Promise<string[]> {
  const supabase = await getSupabase();
  if (!supabase) return [];
  const { data } = await supabase.from('patients').select('id').eq('clinic_id', clinicId).eq('merged_into_id', patientId);
  const parsed = z.array(z.object({ id: z.uuid() })).safeParse(data);
  return parsed.success ? parsed.data.map((p) => p.id) : [];
}

export interface DuplicateCandidate {
  id: string;
  fileNumber: string;
  name: string;
  dateOfBirth: string | null;
  phone: string | null;
  reason: 'phone' | 'name_birth_date';
}

export async function loadDuplicates(patientId: string): Promise<Loaded<DuplicateCandidate[]>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const { data, error } = await supabase.rpc('list_patient_duplicates', { p_patient_id: patientId });
  if (error) return failure(error);
  const parsed = z
    .array(
      z.object({
        patient_id: z.uuid(),
        file_number: z.string(),
        first_name: z.string(),
        last_name: z.string(),
        date_of_birth: z.string().nullable(),
        phone_e164: z.string().nullable(),
        reason: z.enum(['phone', 'name_birth_date']),
      }),
    )
    .safeParse(data);
  if (!parsed.success) return { status: 'error', code: 'INTERNAL' };
  return {
    status: 'ok',
    data: parsed.data.map((d) => ({
      id: d.patient_id,
      fileNumber: d.file_number,
      name: `${d.first_name} ${d.last_name}`,
      dateOfBirth: d.date_of_birth,
      phone: d.phone_e164,
      reason: d.reason,
    })),
  };
}
