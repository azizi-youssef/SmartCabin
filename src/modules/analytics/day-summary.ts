import type { AppointmentStatus } from '@/modules/appointments/domain/status';

/**
 * Day figures computed from the appointment rows the caller can see (BUSINESS_RULES §8).
 * Pure function: no sampling, no estimation — counts of real records only.
 */
export interface DaySummary {
  total: number;
  /** Still expected today (pending + confirmed). */
  upcoming: number;
  inClinic: number;
  completed: number;
  cancelled: number;
  noShow: number;
  /** K4: no_show / (completed + no_show + left_before_consultation); null when undefined. */
  noShowRate: number | null;
}

export function summarizeDay(rows: ReadonlyArray<{ status: AppointmentStatus; source: string }>): DaySummary {
  const count = (status: AppointmentStatus) => rows.filter((r) => r.status === status).length;
  const scheduled = rows.filter((r) => r.source !== 'walk_in');
  const noShow = scheduled.filter((r) => r.status === 'no_show').length;
  const completedScheduled = scheduled.filter((r) => r.status === 'completed').length;
  const denominator = completedScheduled + noShow;
  return {
    total: rows.length,
    upcoming: count('pending') + count('confirmed'),
    inClinic: count('checked_in') + count('in_progress'),
    completed: count('completed'),
    cancelled: count('cancelled'),
    noShow: count('no_show'),
    noShowRate: denominator === 0 ? null : noShow / denominator,
  };
}
