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

// ---------------------------------------------------------------------------
// Appointment file (module 6): get_appointment + list_appointment_history
// ---------------------------------------------------------------------------

export const HISTORY_EVENTS = ['created', 'status_changed', 'rescheduled', 'details_changed'] as const;
export const ACTOR_TYPES = ['user', 'patient', 'platform_admin', 'system'] as const;

export interface AppointmentFile {
  id: string;
  patientId: string;
  doctorId: string;
  serviceId: string;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  source: 'staff' | 'online' | 'walk_in';
  isOverbooked: boolean;
  overbookReason: string | null;
  /** Null when absent or when the caller lacks appointments.view_reason (masked by the database). */
  patientReason: string | null;
  priceMad: string;
  version: number;
  bookedByName: string | null;
  cancelledAt: string | null;
  cancellationActor: 'patient' | 'clinic' | 'system' | null;
  cancellationReason: string | null;
  createdAt: string;
  /** Null when RLS hides the patient from the caller. */
  patient: { id: string; firstName: string; lastName: string; fileNumber: string; phone: string | null } | null;
}

export interface AppointmentEvent {
  occurredAt: string;
  eventType: (typeof HISTORY_EVENTS)[number];
  fromStatus: AppointmentStatus | null;
  toStatus: AppointmentStatus | null;
  previousStartsAt: string | null;
  newStartsAt: string | null;
  actorType: (typeof ACTOR_TYPES)[number];
  actorName: string | null;
  reason: string | null;
}

const fileRow = z.object({
  id: z.uuid(),
  patient_id: z.uuid(),
  doctor_id: z.uuid(),
  service_id: z.uuid(),
  starts_at: z.string(),
  ends_at: z.string(),
  status: z.enum(APPOINTMENT_STATUSES),
  source: z.enum(['staff', 'online', 'walk_in']),
  is_overbooked: z.boolean(),
  overbook_reason: z.string().nullable(),
  patient_reason: z.string().nullable(),
  price_mad: z.union([z.string(), z.number()]).transform(String),
  version: z.number().int(),
  booked_by_name: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  cancellation_actor: z.enum(['patient', 'clinic', 'system']).nullable(),
  cancellation_reason: z.string().nullable(),
  created_at: z.string(),
});
const eventRows = z.array(z.object({
  occurred_at: z.string(),
  event_type: z.enum(HISTORY_EVENTS),
  from_status: z.enum(APPOINTMENT_STATUSES).nullable(),
  to_status: z.enum(APPOINTMENT_STATUSES).nullable(),
  previous_starts_at: z.string().nullable(),
  new_starts_at: z.string().nullable(),
  actor_type: z.enum(ACTOR_TYPES),
  actor_name: z.string().nullable(),
  reason: z.string().nullable(),
}));
const filePatientRow = z.object({
  id: z.uuid(),
  first_name: z.string(),
  last_name: z.string(),
  file_number: z.string(),
  phone_e164: z.string().nullable(),
}).nullable();

/** One appointment with its history. Access is decided by the database (NOT_FOUND outside scope). */
export async function loadAppointmentFile(clinicId: string, appointmentId: string): Promise<Loaded<{ appointment: AppointmentFile; history: AppointmentEvent[] }>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const [appointment, history] = await Promise.all([
    supabase.rpc('get_appointment', { p_appointment_id: appointmentId }),
    supabase.rpc('list_appointment_history', { p_appointment_id: appointmentId }),
  ]);
  const failed = appointment.error ?? history.error;
  if (failed) {
    const code = toErrorCode(failed);
    return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
  }
  const a = fileRow.safeParse(Array.isArray(appointment.data) ? appointment.data[0] : appointment.data);
  const h = eventRows.safeParse(history.data);
  if (!a.success || !h.success) return { status: 'error', code: 'INTERNAL' };

  const patientResult = await supabase
    .from('patients')
    .select('id, first_name, last_name, file_number, phone_e164')
    .eq('clinic_id', clinicId)
    .eq('id', a.data.patient_id)
    .maybeSingle();
  const p = filePatientRow.safeParse(patientResult.error ? null : patientResult.data);
  const patient = p.success && p.data
    ? { id: p.data.id, firstName: p.data.first_name, lastName: p.data.last_name, fileNumber: p.data.file_number, phone: p.data.phone_e164 }
    : null;

  const v = a.data;
  return {
    status: 'ok',
    data: {
      appointment: {
        id: v.id,
        patientId: v.patient_id,
        doctorId: v.doctor_id,
        serviceId: v.service_id,
        startsAt: v.starts_at,
        endsAt: v.ends_at,
        status: v.status,
        source: v.source,
        isOverbooked: v.is_overbooked,
        overbookReason: v.overbook_reason,
        patientReason: v.patient_reason,
        priceMad: v.price_mad,
        version: v.version,
        bookedByName: v.booked_by_name,
        cancelledAt: v.cancelled_at,
        cancellationActor: v.cancellation_actor,
        cancellationReason: v.cancellation_reason,
        createdAt: v.created_at,
        patient,
      },
      history: h.data.map((e) => ({
        occurredAt: e.occurred_at,
        eventType: e.event_type,
        fromStatus: e.from_status,
        toStatus: e.to_status,
        previousStartsAt: e.previous_starts_at,
        newStartsAt: e.new_starts_at,
        actorType: e.actor_type,
        actorName: e.actor_name,
        reason: e.reason,
      })),
    },
  };
}
