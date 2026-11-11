/*
 * Pure queue helpers (module 7). The order is decided by the database (BR-Q-04, BR-Q-05):
 * priority first, then sort_key (appointment time for on-time patients, arrival time otherwise),
 * then ticket number. The reception board only displays it.
 */

export const QUEUE_STATES = ['waiting', 'called', 'in_consultation', 'closed'] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

export interface QueueEntry {
  id: string;
  appointmentId: string;
  doctorId: string;
  ticketNumber: number;
  state: QueueState;
  priorityLevel: number;
  sortKey: number;
  checkedInAt: string;
}

/** Entries still waiting for the doctor (waiting or called), in queue order. */
export function waitingOrder<T extends Pick<QueueEntry, 'state' | 'priorityLevel' | 'sortKey' | 'ticketNumber'>>(entries: readonly T[]): T[] {
  return entries
    .filter((e) => e.state === 'waiting' || e.state === 'called')
    .sort((a, b) => b.priorityLevel - a.priorityLevel || a.sortKey - b.sortKey || a.ticketNumber - b.ticketNumber);
}

/** Whole minutes elapsed since an instant (never negative). */
export function minutesSince(instant: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(instant).getTime()) / 60_000));
}

/**
 * MD-09 end-of-day list: confirmed appointments whose start plus the check-in grace period has
 * passed without check-in. Staff decide (no automatic no-show): mark absent or cancel.
 */
export function unresolvedAppointments<T extends { status: string; startsAt: string }>(rows: readonly T[], now: Date, graceMinutes: number): T[] {
  return rows.filter((a) => a.status === 'confirmed' && now.getTime() >= new Date(a.startsAt).getTime() + graceMinutes * 60_000);
}
