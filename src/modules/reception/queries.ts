import 'server-only';

import { z } from 'zod';

import { toErrorCode } from '@/shared/lib/errors';
import type { Loaded } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

import { QUEUE_STATES, type QueueEntry } from './queue';

const sessionRows = z.array(z.object({ id: z.uuid(), doctor_id: z.uuid() }));
const entryRows = z.array(z.object({
  id: z.uuid(),
  appointment_id: z.uuid(),
  doctor_id: z.uuid(),
  ticket_number: z.number().int(),
  state: z.enum(QUEUE_STATES),
  priority_level: z.number().int(),
  sort_key: z.union([z.string(), z.number()]).transform(Number),
  checked_in_at: z.string(),
}));

/**
 * Queue entries of one clinic-local day (all doctors the caller may see: RLS on queue.view, a
 * practitioner-only doctor sees their own queue only).
 */
export async function loadDayQueue(clinicId: string, day: string): Promise<Loaded<QueueEntry[]>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const sessions = await supabase.from('doctor_sessions').select('id, doctor_id').eq('clinic_id', clinicId).eq('service_date', day);
  if (sessions.error) {
    const code = toErrorCode(sessions.error);
    return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
  }
  const s = sessionRows.safeParse(sessions.data);
  if (!s.success) return { status: 'error', code: 'INTERNAL' };
  if (s.data.length === 0) return { status: 'ok', data: [] };

  const entries = await supabase
    .from('queue_entries')
    .select('id, appointment_id, doctor_id, ticket_number, state, priority_level, sort_key, checked_in_at')
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
    data: e.data.map((r) => ({
      id: r.id,
      appointmentId: r.appointment_id,
      doctorId: r.doctor_id,
      ticketNumber: r.ticket_number,
      state: r.state,
      priorityLevel: r.priority_level,
      sortKey: r.sort_key,
      checkedInAt: r.checked_in_at,
    })),
  };
}
