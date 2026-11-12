import 'server-only';

import { z } from 'zod';

import { APPOINTMENT_STATUSES, type AppointmentStatus } from '@/modules/appointments/domain/status';
import { toErrorCode } from '@/shared/lib/errors';
import type { Loaded } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

export interface PortalAppointment {
  id: string;
  clinicName: string;
  /** The clinic's public booking page (/c/<slug>). */
  clinicSlug: string;
  clinicTimezone: string;
  patientFirstName: string;
  relationship: 'self' | 'child' | 'other_dependent';
  doctorName: string;
  serviceNameFr: string | null;
  serviceNameAr: string | null;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  /** Last moment the patient may cancel online (A6), or null when it cannot be cancelled. */
  cancelUntil: string | null;
}

const row = z.object({
  appointment_id: z.uuid(),
  clinic_name: z.string(),
  clinic_slug: z.string(),
  clinic_timezone: z.string(),
  patient_first_name: z.string(),
  relationship: z.enum(['self', 'child', 'other_dependent']),
  doctor_name: z.string(),
  service_name_fr: z.string().nullable(),
  service_name_ar: z.string().nullable(),
  starts_at: z.string(),
  ends_at: z.string(),
  status: z.enum(APPOINTMENT_STATUSES),
  cancel_until: z.string().nullable(),
});

/** Appointments of the records explicitly linked to the signed-in portal account. */
export async function loadMyAppointments(): Promise<Loaded<PortalAppointment[]>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const { data, error } = await supabase.rpc('portal_list_my_appointments');
  if (error) {
    const code = toErrorCode(error);
    return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
  }
  const parsed = z.array(row).safeParse(data);
  if (!parsed.success) return { status: 'error', code: 'INTERNAL' };
  return {
    status: 'ok',
    data: parsed.data.map((r) => ({
      id: r.appointment_id,
      clinicName: r.clinic_name,
      clinicSlug: r.clinic_slug,
      clinicTimezone: r.clinic_timezone,
      patientFirstName: r.patient_first_name,
      relationship: r.relationship,
      doctorName: r.doctor_name,
      serviceNameFr: r.service_name_fr,
      serviceNameAr: r.service_name_ar,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      status: r.status,
      cancelUntil: r.cancel_until,
    })),
  };
}

export interface PortalQueueStatus {
  appointmentId: string;
  clinicName: string;
  clinicTimezone: string;
  doctorName: string;
  ticketNumber: number;
  state: 'waiting' | 'called' | 'in_consultation';
  ahead: number;
  estimatedStartAt: string | null;
}

const queueRow = z.object({
  appointment_id: z.uuid(),
  clinic_name: z.string(),
  clinic_timezone: z.string(),
  doctor_name: z.string(),
  ticket_number: z.number().int(),
  state: z.enum(['waiting', 'called', 'in_consultation']),
  ahead: z.number().int(),
  estimated_start_at: z.string().nullable(),
});

/** The caller's own open tickets today (linked records only; nobody else's position or name). */
export async function loadMyQueueStatus(): Promise<Loaded<PortalQueueStatus[]>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const { data, error } = await supabase.rpc('portal_get_my_queue_status');
  if (error) {
    const code = toErrorCode(error);
    return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
  }
  const rows = z.array(queueRow).safeParse(data);
  if (!rows.success) return { status: 'error', code: 'INTERNAL' };
  return {
    status: 'ok',
    data: rows.data.map((r) => ({
      appointmentId: r.appointment_id,
      clinicName: r.clinic_name,
      clinicTimezone: r.clinic_timezone,
      doctorName: r.doctor_name,
      ticketNumber: r.ticket_number,
      state: r.state,
      ahead: r.ahead,
      estimatedStartAt: r.estimated_start_at,
    })),
  };
}
