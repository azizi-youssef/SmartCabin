import type { AppointmentStatus } from '@/modules/appointments/domain/status';

/*
 * Appointment progress for patients ("Mes rendez-vous"): where an appointment stands on the
 * normal path, from the online request to the end of the consultation.
 */

export const PROGRESS_STEPS = ['requested', 'confirmed', 'arrived', 'withDoctor', 'done'] as const;
export type ProgressStep = (typeof PROGRESS_STEPS)[number];
export type StepState = 'done' | 'current' | 'todo';

/** The step an appointment has reached, or null when it left the normal path (cancelled, missed). */
export function progressIndex(status: AppointmentStatus): number | null {
  switch (status) {
    case 'pending': return 0;
    case 'confirmed': return 1;
    case 'checked_in': return 2;
    case 'in_progress': return 3;
    case 'completed': return 4;
    default: return null;
  }
}

/** Each step's state; once completed, every step is done. */
export function stepStates(current: number): StepState[] {
  const last = PROGRESS_STEPS.length - 1;
  return PROGRESS_STEPS.map((_, i) => (i < current || current === last ? 'done' : i === current ? 'current' : 'todo'));
}

/** Still followed on the "upcoming" list: not over yet, or the patient is still in the clinic. */
export function isOngoing(a: { status: AppointmentStatus; endsAt: string }, now: number): boolean {
  return new Date(a.endsAt).getTime() >= now || a.status === 'checked_in' || a.status === 'in_progress';
}

/** Worth refreshing the page for: an active appointment starting within 12 hours or under way. */
export function needsLiveUpdates(a: { status: AppointmentStatus; startsAt: string }, now: number): boolean {
  if (a.status === 'checked_in' || a.status === 'in_progress') return true;
  if (a.status !== 'pending' && a.status !== 'confirmed') return false;
  return new Date(a.startsAt).getTime() - now <= 12 * 3_600_000;
}
