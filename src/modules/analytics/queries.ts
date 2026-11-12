import 'server-only';

import { z } from 'zod';

import { toErrorCode } from '@/shared/lib/errors';
import type { Loaded } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

/*
 * Operational KPIs (module 11) from kpi_operational(): SECURITY INVOKER, so the caller's RLS
 * applies (a doctor gets their own agendas only). Values are counts and minutes from records.
 */

export type KpiGroup = 'total' | 'day' | 'doctor' | 'service';

export interface KpiRow {
  key: string;
  appointments: number;
  byStatus: Record<string, number>;
  bySource: Record<string, number>;
  completed: number;
  cancelled: number;
  cancelledByPatient: number;
  cancelledByClinic: number;
  cancelledBySystem: number;
  leftBeforeConsultation: number;
  noShow: number;
  noShowDenominator: number;
  waitCount: number;
  waitMeanMinutes: number | null;
  waitMedianMinutes: number | null;
  bookedMinutes: number;
  /** Null when grouped by service (availability is not per service). */
  availableMinutes: number | null;
  actualMinutes: number;
}

const num = z.union([z.number(), z.string()]).transform(Number);

const rows = z.array(z.object({
  group_key: z.string(),
  appointments: z.number().int(),
  by_status: z.record(z.string(), z.number()),
  by_source: z.record(z.string(), z.number()),
  completed: z.number().int(),
  cancelled: z.number().int(),
  cancelled_by_patient: z.number().int(),
  cancelled_by_clinic: z.number().int(),
  cancelled_by_system: z.number().int(),
  left_before_consultation: z.number().int(),
  no_show: z.number().int(),
  no_show_denominator: z.number().int(),
  wait_count: z.number().int(),
  wait_mean_minutes: num.nullable(),
  wait_median_minutes: num.nullable(),
  booked_minutes: z.number().int(),
  available_minutes: z.number().int().nullable(),
  actual_minutes: z.number().int(),
}));

export async function loadKpis(params: { clinicId: string; from: string; to: string; group: KpiGroup; doctorId?: string | null }): Promise<Loaded<KpiRow[]>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const { data, error } = await supabase.rpc('kpi_operational', {
    p_clinic_id: params.clinicId,
    p_from: params.from,
    p_to: params.to,
    p_group: params.group,
    p_doctor_id: params.doctorId ?? null,
  });
  if (error) {
    const code = toErrorCode(error);
    return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
  }
  const parsed = rows.safeParse(data);
  if (!parsed.success) return { status: 'error', code: 'INTERNAL' };
  return {
    status: 'ok',
    data: parsed.data.map((r) => ({
      key: r.group_key,
      appointments: r.appointments,
      byStatus: r.by_status,
      bySource: r.by_source,
      completed: r.completed,
      cancelled: r.cancelled,
      cancelledByPatient: r.cancelled_by_patient,
      cancelledByClinic: r.cancelled_by_clinic,
      cancelledBySystem: r.cancelled_by_system,
      leftBeforeConsultation: r.left_before_consultation,
      noShow: r.no_show,
      noShowDenominator: r.no_show_denominator,
      waitCount: r.wait_count,
      waitMeanMinutes: r.wait_mean_minutes,
      waitMedianMinutes: r.wait_median_minutes,
      bookedMinutes: r.booked_minutes,
      availableMinutes: r.available_minutes,
      actualMinutes: r.actual_minutes,
    })),
  };
}
