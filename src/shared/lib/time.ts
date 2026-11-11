/**
 * Clinic-local calendar helpers. "Today" always means today in the clinic's time zone
 * (BR-TZ-04), and local wall-clock times are converted to instants per date (BR-TZ-02),
 * so Morocco's Ramadan UTC+0 switch is handled by the platform's time-zone database.
 */

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  return date.getUTCFullYear() === y && date.getUTCMonth() + 1 === m && date.getUTCDate() === d;
}

/** Local calendar day (YYYY-MM-DD) of an instant in a time zone. */
export function localDay(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** Offset (minutes, local minus UTC) of a time zone at an instant. */
export function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** Instant of a local wall-clock time on a local day in a time zone. */
export function zonedInstant(day: string, time: string, timeZone: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wallAsUtc = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0);
  const firstGuess = wallAsUtc - offsetMinutes(new Date(wallAsUtc), timeZone) * 60_000;
  const corrected = wallAsUtc - offsetMinutes(new Date(firstGuess), timeZone) * 60_000;
  return new Date(corrected);
}

/** [start, end) instants covering a local day. */
export function localDayRange(day: string, timeZone: string): { start: Date; end: Date } {
  return { start: zonedInstant(day, '00:00', timeZone), end: zonedInstant(addDays(day, 1), '00:00', timeZone) };
}

export function addDays(day: string, amount: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + amount));
  return date.toISOString().slice(0, 10);
}

/**
 * Request time for Server Components. Pages are rendered once per request (dynamic), so a
 * single explicit clock read keeps every comparison on the page consistent.
 */
export function requestNow(): Date {
  return new Date();
}

export function today(timeZone: string, now: Date = new Date()): string {
  return localDay(now, timeZone);
}
