import 'server-only';

import { z } from 'zod';

import { toErrorCode } from '@/shared/lib/errors';
import type { Loaded } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

export const NOTIFICATION_EVENTS = [
  'booking_received', 'appointment_confirmation', 'appointment_reminder', 'appointment_rescheduled',
  'appointment_cancellation', 'doctor_delay', 'turn_approaching', 'staff_invitation', 'clinic_status_changed',
] as const;
export const NOTIFICATION_CHANNELS = ['email', 'sms', 'whatsapp', 'push'] as const;
export const NOTIFICATION_STATUSES = ['scheduled', 'processing', 'sent', 'delivered', 'failed', 'cancelled', 'skipped'] as const;
export const SKIP_REASONS = ['stale', 'no_consent', 'no_address', 'quiet_hours', 'no_template', 'quota_exceeded'] as const;

export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export interface MessageLogEntry {
  id: string;
  eventType: (typeof NOTIFICATION_EVENTS)[number];
  channel: (typeof NOTIFICATION_CHANNELS)[number];
  status: NotificationStatus;
  scheduledFor: string;
  sentAt: string | null;
  failedAt: string | null;
  skipReason: (typeof SKIP_REASONS)[number] | null;
  recipientMasked: string | null;
  attemptCount: number;
}

const rows = z.array(z.object({
  id: z.uuid(),
  event_type: z.enum(NOTIFICATION_EVENTS),
  channel: z.enum(NOTIFICATION_CHANNELS),
  status: z.enum(NOTIFICATION_STATUSES),
  scheduled_for: z.string(),
  sent_at: z.string().nullable(),
  failed_at: z.string().nullable(),
  skip_reason: z.enum(SKIP_REASONS).nullable(),
  recipient_masked: z.string().nullable(),
  attempt_count: z.number().int(),
}));

/**
 * Messages planned for one appointment (module 9). RLS limits the log to notifications.view_log
 * (owner, admin, receptionist); the recipient is stored masked and the content is never stored.
 */
export async function loadAppointmentMessages(clinicId: string, appointmentId: string): Promise<Loaded<MessageLogEntry[]>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const { data, error } = await supabase
    .from('notifications')
    .select('id, event_type, channel, status, scheduled_for, sent_at, failed_at, skip_reason, recipient_masked, attempt_count')
    .eq('clinic_id', clinicId)
    .eq('appointment_id', appointmentId)
    .order('scheduled_for', { ascending: true })
    .limit(50);
  if (error) {
    const code = toErrorCode(error);
    return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
  }
  const parsed = rows.safeParse(data);
  if (!parsed.success) return { status: 'error', code: 'INTERNAL' };
  return {
    status: 'ok',
    data: parsed.data.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      channel: r.channel,
      status: r.status,
      scheduledFor: r.scheduled_for,
      sentAt: r.sent_at,
      failedAt: r.failed_at,
      skipReason: r.skip_reason,
      recipientMasked: r.recipient_masked,
      attemptCount: r.attempt_count,
    })),
  };
}
