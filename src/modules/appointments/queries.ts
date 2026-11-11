import 'server-only';

import { z } from 'zod';

import { toErrorCode } from '@/shared/lib/errors';
import type { Loaded } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';
import { localDayRange } from '@/shared/lib/time';

import { APPOINTMENT_STATUSES, type AppointmentStatus } from './domain/status';

export interface DayAppointment {
  id: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  source: 'staff' | 'online' | 'walk_in';
  isOverbooked: boolean;
  version: number;
  doctorId: string;
  serviceId: string;
  priceMad: string;
  /** Null when RLS hides the patient from the caller (e.g. not the caller's patient). */
  patient: { id: string; firstName: string; lastName: string; fileNumber: string; phone: string | null } | null;
}

const row = z.object({
  id: z.uuid(),
  starts_at: z.string(),
  ends_at: z.string(),
  status: z.enum(APPOINTMENT_STATUSES),
  source: z.enum(['staff', 'online', 'walk_in']),
  is_overbooked: z.boolean(),
  version: z.number().int(),
  doctor_id: z.uuid(),
  service_id: z.uuid(),
  price_mad: z.union([z.string(), z.number()]).transform(String),
  patient: z
    .object({
      id: z.uuid(),
      first_name: z.string(),
      last_name: z.string(),
      file_number: z.string(),
      phone_e164: z.string().nullable(),
    })
    .nullable(),
});

/**
 * Appointments of one clinic-local day, ordered by time. RLS scopes the rows to what the
 * caller may see (a practitioner-only doctor gets their own agenda only).
 */
export async function loadDayAppointments(params: {
  clinicId: string;
  day: string;
  timeZone: string;
  doctorIds?: string[];
}): Promise<Loaded<DayAppointment[]>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const { start, end } = localDayRange(params.day, params.timeZone);

  let query = supabase
    .from('appointments')
    .select(
      'id, starts_at, ends_at, status, source, is_overbooked, version, doctor_id, service_id, price_mad, ' +
        'patient:patients!appointments_patient_fkey(id, first_name, last_name, file_number, phone_e164)',
    )
    .eq('clinic_id', params.clinicId)
    .gte('starts_at', start.toISOString())
    .lt('starts_at', end.toISOString())
    .order('starts_at')
    .limit(500);
  if (params.doctorIds) query = query.in('doctor_id', params.doctorIds);

  const { data, error } = await query;
  if (error) {
    const code = toErrorCode(error);
    return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
  }
  const parsed = z.array(row).safeParse(data);
  if (!parsed.success) return { status: 'error', code: 'INTERNAL' };
  return {
    status: 'ok',
    data: parsed.data.map((r) => ({
      id: r.id,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      status: r.status,
      source: r.source,
      isOverbooked: r.is_overbooked,
      version: r.version,
      doctorId: r.doctor_id,
      serviceId: r.service_id,
      priceMad: r.price_mad,
      patient: r.patient
        ? {
            id: r.patient.id,
            firstName: r.patient.first_name,
            lastName: r.patient.last_name,
            fileNumber: r.patient.file_number,
            phone: r.patient.phone_e164,
          }
        : null,
    })),
  };
}

/** Grace period before a no-show can be recorded (clinic setting). */
export async function loadCheckinGrace(clinicId: string): Promise<number> {
  const supabase = await getSupabase();
  if (!supabase) return 15;
  const { data } = await supabase.from('clinic_settings').select('checkin_grace_minutes').eq('clinic_id', clinicId).maybeSingle();
  const parsed = z.object({ checkin_grace_minutes: z.number().int() }).nullable().safeParse(data);
  return parsed.success && parsed.data ? parsed.data.checkin_grace_minutes : 15;
}
