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
  priorityReason: PriorityReason | null;
  sortKey: number;
  checkedInAt: string;
  sessionId: string;
  calledAt: string | null;
  consultationStartedAt: string | null;
  estimatedStartAt: string | null;
}

export interface DoctorSession {
  id: string;
  doctorId: string;
  status: SessionStatus;
  announcedDelayMinutes: number;
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

export const SESSION_STATUSES = ['planned', 'open', 'paused', 'closed'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const PRIORITY_REASONS = ['elderly', 'pregnancy', 'disability', 'young_child', 'staff_judgement', 'other'] as const;
export type PriorityReason = (typeof PRIORITY_REASONS)[number];

const FIVE_MINUTES = 5 * 60_000;

/**
 * Displayed estimate range (BUSINESS_RULES §3.2, step 4): low = wait − 20 %, high = wait +
 * max(20 %, p80 − median), rounded to 5 minutes. `spreadMinutes` is p80 − median of the
 * doctor's measured durations for the service (0 without statistics). A prediction, never a
 * promise; null when no estimate exists.
 */
export function estimateRange(estimatedStartAt: string | null, now: Date, spreadMinutes = 0): { low: Date; high: Date } | null {
  if (!estimatedStartAt) return null;
  const wait = Math.max(0, new Date(estimatedStartAt).getTime() - now.getTime());
  const round = (ms: number) => new Date(Math.round(ms / FIVE_MINUTES) * FIVE_MINUTES);
  const margin = wait === 0 ? 0 : Math.max(wait * 0.2, spreadMinutes * 60_000);
  return { low: round(now.getTime() + wait * 0.8), high: round(now.getTime() + wait + margin) };
}
