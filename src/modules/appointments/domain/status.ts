export const APPOINTMENT_STATUSES = [
  'pending',
  'confirmed',
  'checked_in',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/**
 * Semantic tone per status, consistent across every screen:
 * amber = waiting for someone, blue = scheduled, teal = in the clinic, navy = with the doctor,
 * green = done, grey = cancelled, red = missed.
 */
export const STATUS_TONE = {
  pending: 'warning',
  confirmed: 'info',
  checked_in: 'accent',
  in_progress: 'navy',
  completed: 'success',
  cancelled: 'neutral',
  no_show: 'danger',
} as const satisfies Record<AppointmentStatus, string>;

/** Statuses that still occupy the doctor's time (mirrors the exclusion constraint). */
export const ACTIVE_STATUSES: readonly AppointmentStatus[] = ['pending', 'confirmed', 'checked_in', 'in_progress'];

export const STAFF_CANCELLATION_REASONS = ['patient_request', 'clinic_request', 'doctor_unavailable', 'duplicate', 'other'] as const;
export type StaffCancellationReason = (typeof STAFF_CANCELLATION_REASONS)[number];

/**
 * Which staff actions are offered for an appointment. Mirrors the database transition table
 * (appointment_status_transitions) for the commands that exist today; the database still
 * validates every transition.
 */
export function availableActions(
  appointment: { status: AppointmentStatus; startsAt: string },
  now: Date,
  graceMinutes: number,
): { confirm: boolean; reschedule: boolean; cancel: boolean; noShow: boolean } {
  const { status } = appointment;
  const graceOver = now.getTime() >= new Date(appointment.startsAt).getTime() + graceMinutes * 60_000;
  return {
    confirm: status === 'pending',
    reschedule: status === 'pending' || status === 'confirmed',
    cancel: status === 'pending' || status === 'confirmed',
    noShow: status === 'confirmed' && graceOver,
  };
}
