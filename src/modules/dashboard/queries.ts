import 'server-only';

import { z } from 'zod';

import { centsToDecimal, decimalToCents } from '@/modules/billing/money';
import { toErrorCode } from '@/shared/lib/errors';
import type { Loaded } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

/*
 * Dashboard reads (counts and short lists), each under the caller's RLS. Every loader is called
 * only for roles holding the matching permission, so no role triggers a refused call.
 */

function failed<T>(error: unknown): Loaded<T> {
  const code = toErrorCode(error);
  return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
}

export interface PendingRequest {
  id: string;
  startsAt: string;
  doctorId: string;
  patientName: string | null;
}

/** Online requests waiting for the clinic's confirmation (A1 → A4): the next few and the total. */
export async function loadPendingRequests(clinicId: string, limit = 3): Promise<Loaded<{ total: number; next: PendingRequest[] }>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const { data, error, count } = await supabase
    .from('appointments')
    .select('id, starts_at, doctor_id, patient:patients!appointments_patient_fkey(first_name, last_name)', { count: 'exact' })
    .eq('clinic_id', clinicId)
    .eq('status', 'pending')
    .gte('starts_at', new Date().toISOString())
    .order('starts_at')
    .limit(limit);
  if (error) return failed(error);
  const rows = z.array(z.object({
    id: z.uuid(),
    starts_at: z.string(),
    doctor_id: z.uuid(),
    patient: z.object({ first_name: z.string(), last_name: z.string() }).nullable(),
  })).safeParse(data);
  if (!rows.success) return { status: 'error', code: 'INTERNAL' };
  return {
    status: 'ok',
    data: {
      total: count ?? rows.data.length,
      next: rows.data.map((r) => ({ id: r.id, startsAt: r.starts_at, doctorId: r.doctor_id, patientName: r.patient ? `${r.patient.first_name} ${r.patient.last_name}` : null })),
    },
  };
}

export interface MoneyDue {
  unpaidCount: number;
  /** Total still due on issued and partly paid invoices (decimal string, MAD). */
  balanceMad: string;
  draftCount: number;
}

/** Invoices to collect and drafts to finish (invoices.view). */
export async function loadMoneyDue(clinicId: string): Promise<Loaded<MoneyDue>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const [unpaid, drafts] = await Promise.all([
    supabase
      .from('invoices')
      .select('total_mad, amount_paid_mad')
      .eq('clinic_id', clinicId)
      .in('status', ['issued', 'partially_paid'])
      .limit(2000),
    supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('clinic_id', clinicId)
      .eq('status', 'draft'),
  ]);
  const error = unpaid.error ?? drafts.error;
  if (error) return failed(error);
  const rows = z.array(z.object({
    total_mad: z.union([z.string(), z.number()]).transform((v) => Number(v).toFixed(2)),
    amount_paid_mad: z.union([z.string(), z.number()]).transform((v) => Number(v).toFixed(2)),
  })).safeParse(unpaid.data);
  if (!rows.success) return { status: 'error', code: 'INTERNAL' };
  const balance = rows.data.reduce((sum, r) => sum + decimalToCents(r.total_mad) - decimalToCents(r.amount_paid_mad), 0);
  return { status: 'ok', data: { unpaidCount: rows.data.length, balanceMad: centsToDecimal(balance), draftCount: drafts.count ?? 0 } };
}
