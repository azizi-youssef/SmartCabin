'use server';

import { z } from 'zod';

import { loadWorkspace } from '@/modules/tenancy/workspace';
import { toErrorCode } from '@/shared/lib/errors';
import type { ActionResult } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

import { searchPatients } from './queries';
import {
  CONSENT_PURPOSES,
  createPatientSchema,
  toPatientColumns,
  updatePatientSchema,
  type CreatePatientInput,
  type UpdatePatientInput,
} from './schemas';

const CONSENT_VERSION = 'v1';

function fieldErrors(issues: z.ZodError['issues']): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of issues) fields[String(issue.path[0])] = issue.message;
  return fields;
}

async function rpc(name: string, args: Record<string, unknown>): Promise<ActionResult> {
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { error } = await supabase.rpc(name, args);
  return error ? { ok: false, code: toErrorCode(error) } : { ok: true, data: undefined };
}

/**
 * Registers a patient and the consents in ONE database transaction (register_patient).
 * The clinic comes from the caller's own membership; the database re-checks permissions.
 */
export async function createPatient(clinicSlug: string, input: CreatePatientInput): Promise<ActionResult<{ id: string; fileNumber: string }>> {
  const parsed = createPatientSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED', fields: fieldErrors(parsed.error.issues) };
  const workspace = await loadWorkspace(clinicSlug);
  if (workspace.status !== 'ok') return { ok: false, code: workspace.status === 'unavailable' ? 'UNAVAILABLE' : 'FORBIDDEN' };
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };

  const { data, error } = await supabase.rpc('register_patient', {
    p_clinic_id: workspace.workspace.clinic.id,
    p_patient: { ...toPatientColumns(parsed.data), created_via: 'reception' },
    p_consents: [
      { purpose: 'data_processing', granted: true, document_version: CONSENT_VERSION, source: 'reception' },
      { purpose: 'reminders_sms', granted: parsed.data.consentSmsReminders, document_version: CONSENT_VERSION, source: 'reception' },
    ],
  });
  if (error) return { ok: false, code: toErrorCode(error) };
  const created = z.array(z.object({ patient_id: z.uuid(), file_number: z.string() })).safeParse(data);
  const row = created.success ? created.data[0] : undefined;
  return row ? { ok: true, data: { id: row.patient_id, fileNumber: row.file_number } } : { ok: false, code: 'INTERNAL' };
}

/** Edits administrative data (managed table under RLS; file number and status are not editable). */
export async function updatePatient(patientId: string, input: UpdatePatientInput): Promise<ActionResult> {
  const id = z.uuid().safeParse(patientId);
  const parsed = updatePatientSchema.safeParse(input);
  if (!id.success || !parsed.success) return { ok: false, code: 'VALIDATION_FAILED', fields: parsed.success ? {} : fieldErrors(parsed.error.issues) };
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { data, error } = await supabase.from('patients').update(toPatientColumns(parsed.data)).eq('id', id.data).select('id');
  if (error) return { ok: false, code: toErrorCode(error) };
  return Array.isArray(data) && data.length === 1 ? { ok: true, data: undefined } : { ok: false, code: 'FORBIDDEN' };
}

/** Appends a consent decision (grant or withdrawal); the history is never rewritten. */
export async function recordConsent(clinicSlug: string, patientId: string, purpose: string, granted: boolean): Promise<ActionResult> {
  const parsed = z.object({ patientId: z.uuid(), purpose: z.enum(CONSENT_PURPOSES), granted: z.boolean() }).safeParse({ patientId, purpose, granted });
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const workspace = await loadWorkspace(clinicSlug);
  if (workspace.status !== 'ok') return { ok: false, code: workspace.status === 'unavailable' ? 'UNAVAILABLE' : 'FORBIDDEN' };
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { error } = await supabase.from('patient_consents').insert({
    clinic_id: workspace.workspace.clinic.id,
    patient_id: parsed.data.patientId,
    purpose: parsed.data.purpose,
    granted: parsed.data.granted,
    document_version: CONSENT_VERSION,
    source: 'reception',
  });
  return error ? { ok: false, code: toErrorCode(error) } : { ok: true, data: undefined };
}

export async function setPatientArchived(patientId: string, archived: boolean): Promise<ActionResult> {
  const parsed = z.object({ patientId: z.uuid(), archived: z.boolean() }).safeParse({ patientId, archived });
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  return rpc('set_patient_archived', { p_patient_id: parsed.data.patientId, p_archived: parsed.data.archived });
}

export async function mergePatients(sourceId: string, targetId: string): Promise<ActionResult> {
  const parsed = z.object({ sourceId: z.uuid(), targetId: z.uuid() }).safeParse({ sourceId, targetId });
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  return rpc('merge_patients', { p_source_id: parsed.data.sourceId, p_target_id: parsed.data.targetId });
}

export interface PatientOption {
  id: string;
  label: string;
  fileNumber: string;
}

/** Lightweight lookup for the booking form. */
export async function findPatients(clinicSlug: string, query: string): Promise<ActionResult<PatientOption[]>> {
  const q = z.string().trim().min(2).max(60).safeParse(query);
  if (!q.success) return { ok: true, data: [] };
  const workspace = await loadWorkspace(clinicSlug);
  if (workspace.status !== 'ok') return { ok: false, code: workspace.status === 'unavailable' ? 'UNAVAILABLE' : 'FORBIDDEN' };
  const result = await searchPatients({ clinicId: workspace.workspace.clinic.id, query: q.data });
  if (result.status === 'unavailable') return { ok: false, code: 'UNAVAILABLE' };
  if (result.status === 'error') return { ok: false, code: result.code };
  return {
    ok: true,
    data: result.data.rows
      .filter((p) => p.status === 'active')
      .slice(0, 8)
      .map((p) => ({ id: p.id, label: `${p.firstName} ${p.lastName}`, fileNumber: p.fileNumber })),
  };
}
