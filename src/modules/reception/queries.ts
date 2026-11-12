import 'server-only';

import { z } from 'zod';

import { toErrorCode } from '@/shared/lib/errors';
import type { Loaded } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

import { PRIORITY_REASONS, QUEUE_STATES, SESSION_STATUSES, type DoctorSession, type QueueEntry } from './queue';

const sessionRows = z.array(z.object({ id: z.uuid(), doctor_id: z.uuid(), status: z.enum(SESSION_STATUSES), announced_delay_minutes: z.number().int() }));
const entryRows = z.array(z.object({
  id: z.uuid(),
  appointment_id: z.uuid(),
  doctor_id: z.uuid(),
  ticket_number: z.number().int(),
  state: z.enum(QUEUE_STATES),
  priority_level: z.number().int(),
  priority_reason: z.enum(PRIORITY_REASONS).nullable(),
  sort_key: z.union([z.string(), z.number()]).transform(Number),
  checked_in_at: z.string(),
  session_id: z.uuid(),
  called_at: z.string().nullable(),
  consultation_started_at: z.string().nullable(),
  estimated_start_at: z.string().nullable(),
}));

const spreadRows = z.array(z.object({
  doctor_id: z.uuid(),
  service_id: z.uuid(),
  median_minutes: z.union([z.string(), z.number()]).transform(Number),
  p80_minutes: z.union([z.string(), z.number()]).transform(Number),
}));

/**
 * p80 − median of measured consultation durations per "doctor:service" (only where 20 or more
 * consultations were measured), used to widen the upper bound of estimate ranges.
 */
export async function loadDurationSpreads(clinicId: string): Promise<Map<string, number>> {
  const supabase = await getSupabase();
  if (!supabase) return new Map();
  const { data, error } = await supabase
    .from('consultation_duration_stats')
    .select('doctor_id, service_id, median_minutes, p80_minutes')
    .eq('clinic_id', clinicId)
    .gte('sample_size', 20);
  const rows = spreadRows.safeParse(error ? [] : data);
  return new Map(rows.success ? rows.data.map((r) => [`${r.doctor_id}:${r.service_id}`, Math.max(0, r.p80_minutes - r.median_minutes)]) : []);
}

/**
 * Queue entries of one clinic-local day (all doctors the caller may see: RLS on queue.view, a
 * practitioner-only doctor sees their own queue only).
 */
export async function loadDayQueue(clinicId: string, day: string): Promise<Loaded<{ sessions: DoctorSession[]; entries: QueueEntry[] }>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const sessions = await supabase.from('doctor_sessions').select('id, doctor_id, status, announced_delay_minutes').eq('clinic_id', clinicId).eq('service_date', day);
  if (sessions.error) {
    const code = toErrorCode(sessions.error);
    return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
  }
  const s = sessionRows.safeParse(sessions.data);
  if (!s.success) return { status: 'error', code: 'INTERNAL' };
  const sessionList = s.data.map((r) => ({ id: r.id, doctorId: r.doctor_id, status: r.status, announcedDelayMinutes: r.announced_delay_minutes }));
  if (s.data.length === 0) return { status: 'ok', data: { sessions: [], entries: [] } };

  const entries = await supabase
    .from('queue_entries')
    .select('id, appointment_id, doctor_id, ticket_number, state, priority_level, priority_reason, sort_key, checked_in_at, session_id, called_at, consultation_started_at, estimated_start_at')
    .eq('clinic_id', clinicId)
    .in('session_id', s.data.map((x) => x.id))
    .order('ticket_number');
  if (entries.error) {
    const code = toErrorCode(entries.error);
    return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
  }
  const e = entryRows.safeParse(entries.data);
  if (!e.success) return { status: 'error', code: 'INTERNAL' };
  return {
    status: 'ok',
    data: { sessions: sessionList, entries: e.data.map((r) => ({
      id: r.id,
      appointmentId: r.appointment_id,
      doctorId: r.doctor_id,
      ticketNumber: r.ticket_number,
      state: r.state,
      priorityLevel: r.priority_level,
      priorityReason: r.priority_reason,
      sortKey: r.sort_key,
      checkedInAt: r.checked_in_at,
      sessionId: r.session_id,
      calledAt: r.called_at,
      consultationStartedAt: r.consultation_started_at,
      estimatedStartAt: r.estimated_start_at,
    })) },
  };
}

export interface DisplayScreen {
  id: string;
  name: string;
  doctorIds: string[] | null;
  createdAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
}

const screenRows = z.array(z.object({
  id: z.uuid(),
  name: z.string(),
  doctor_ids: z.array(z.uuid()).nullable(),
  created_at: z.string(),
  revoked_at: z.string().nullable(),
  last_seen_at: z.string().nullable(),
}));

/** Waiting-room screens of a clinic (queue.displays.manage). Token hashes are never readable. */
export async function loadDisplayScreens(clinicId: string): Promise<Loaded<DisplayScreen[]>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const { data, error } = await supabase
    .from('queue_display_screens')
    .select('id, name, doctor_ids, created_at, revoked_at, last_seen_at')
    .eq('clinic_id', clinicId)
    .order('created_at');
  if (error) {
    const code = toErrorCode(error);
    return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
  }
  const rows = screenRows.safeParse(data);
  if (!rows.success) return { status: 'error', code: 'INTERNAL' };
  return {
    status: 'ok',
    data: rows.data.map((r) => ({ id: r.id, name: r.name, doctorIds: r.doctor_ids, createdAt: r.created_at, revokedAt: r.revoked_at, lastSeenAt: r.last_seen_at })),
  };
}
