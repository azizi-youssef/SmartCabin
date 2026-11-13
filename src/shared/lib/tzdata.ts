import { offsetMinutes } from './time';

/*
 * SC-AUD-24. The server formats and converts clinic times with the runtime's own time zone data
 * (Intl, through Node.js's ICU), while slots and SMS texts come from PostgreSQL's. Morocco moved
 * to UTC+0 for good on 20 September 2026 (IANA tzdata 2026c): a runtime with older data shows
 * every time one hour late and stores staff-entered times one hour early.
 */

/** Oldest IANA time zone data release that knows Morocco's move to UTC+0. */
export const MIN_TZDATA = '2026c';

/** A sentence describing the problem when this runtime's time zone data is too old, else null. */
export function timeZoneDataProblem(): string | null {
  const offset = offsetMinutes(new Date('2026-11-13T12:00:00Z'), 'Africa/Casablanca');
  if (offset === 0) return null;
  const version = typeof process !== 'undefined' ? (process.versions as Record<string, string | undefined>)['tz'] : undefined;
  const hours = `${offset > 0 ? '+' : ''}${offset / 60}`;
  return `this runtime puts Africa/Casablanca at UTC${hours} in November 2026 (time zone data ${version ?? 'unknown'}); `
    + `Morocco is on UTC+0 since 2026-09-20 (tzdata ${MIN_TZDATA} or later). Every clinic time computed by the server is wrong: `
    + 'upgrade Node.js (22.23.3 or later in the 22.x line).';
}
