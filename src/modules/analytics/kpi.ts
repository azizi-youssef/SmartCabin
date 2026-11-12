/*
 * KPI arithmetic for display (BUSINESS_RULES §8). The database returns counts and minutes; ratios
 * are derived here and are null, shown as "—", whenever their denominator is zero: never 0 %.
 */

export const PERIODS = ['today', '7d', '30d', 'month', 'previous_month'] as const;
export type Period = (typeof PERIODS)[number];

function shift(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Inclusive local-date range for a preset, from the clinic's local "today" (YYYY-MM-DD). */
export function periodRange(period: Period, today: string): { from: string; to: string } {
  switch (period) {
    case 'today':
      return { from: today, to: today };
    case '7d':
      return { from: shift(today, -6), to: today };
    case '30d':
      return { from: shift(today, -29), to: today };
    case 'previous_month': {
      const firstOfMonth = `${today.slice(0, 7)}-01`;
      const last = shift(firstOfMonth, -1);
      return { from: `${last.slice(0, 7)}-01`, to: last };
    }
    default:
      return { from: `${today.slice(0, 7)}-01`, to: today };
  }
}

/** Number of local days in an inclusive range. */
export function dayCount(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1;
}

export function ratio(numerator: number, denominator: number | null): number | null {
  return denominator === null || denominator <= 0 ? null : numerator / denominator;
}

/** "1 h 05" style durations from minutes (minutes under an hour stay "45 min"). */
export function minutesParts(minutes: number): { hours: number; minutes: number } {
  const total = Math.max(0, Math.round(minutes));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}
