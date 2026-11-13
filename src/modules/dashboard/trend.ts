/*
 * Week-over-week comparison for the dashboard: the last 7 local days against the 7 before.
 * A change is null (shown "—") when there is nothing to compare with, never an invented 0 %.
 */

export type Direction = 'up' | 'down' | 'flat';

export interface Change {
  direction: Direction;
  /** Relative change of a count (0.25 = +25 %), or the difference of two rates in points. */
  amount: number;
}

/** Relative change of a count: null without a previous value to compare with. */
export function countChange(current: number, previous: number): Change | null {
  if (previous <= 0) return null;
  const amount = (current - previous) / previous;
  return { direction: Math.abs(amount) < 0.005 ? 'flat' : amount > 0 ? 'up' : 'down', amount };
}

/** Difference of two rates in percentage points: null when either rate is unknown. */
export function rateChange(current: number | null, previous: number | null): Change | null {
  if (current === null || previous === null) return null;
  const amount = (current - previous) * 100;
  return { direction: Math.abs(amount) < 0.5 ? 'flat' : amount > 0 ? 'up' : 'down', amount };
}

/** Whether a change is good news: more consultations is good, more no-shows is not. */
export function isFavourable(change: Change, higherIsBetter: boolean): boolean | null {
  if (change.direction === 'flat') return null;
  return (change.direction === 'up') === higherIsBetter;
}
