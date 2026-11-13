import { describe, expect, it } from 'vitest';

import { toErrorCode } from './errors';
import { formatMoney, formatTime } from './format';
import { formatPhone, normalizePhone } from './phone';
import { addDays, isLocalDay, localDay, localDayRange, offsetMinutes, zonedInstant } from './time';

describe('time (clinic-local calendar)', () => {
  it('validates local days strictly', () => {
    expect(isLocalDay('2027-02-28')).toBe(true);
    expect(isLocalDay('2027-02-30')).toBe(false);
    expect(isLocalDay('27-02-28')).toBe(false);
    expect(isLocalDay(undefined)).toBe(false);
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
  });

  it('round-trips local wall-clock times through instants for every day of a year', () => {
    const tz = 'Africa/Casablanca';
    for (let d = 0; d < 366; d += 1) {
      const day = addDays('2027-01-01', d);
      const instant = zonedInstant(day, '09:00', tz);
      expect(localDay(instant, tz)).toBe(day);
      const hh = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(instant);
      expect(hh).toBe('09');
    }
  });

  it('uses the offset of each date (no fixed offset): Morocco was UTC+1 until 20 September 2026, UTC+0 since', () => {
    const tz = 'Africa/Casablanca';
    const offsets = new Set<number>();
    for (let d = 0; d < 364; d += 7) {
      const day = addDays('2026-01-05', d);
      const instant = zonedInstant(day, '12:00', tz);
      expect(localDay(instant, tz)).toBe(day);
      offsets.add(offsetMinutes(instant, tz));
    }
    // 2026 had both offsets (tzdata 2026c and later; SC-AUD-24): each date must use its own.
    expect([...offsets].sort((a, b) => a - b)).toEqual([0, 60]);
    expect(offsetMinutes(zonedInstant('2026-07-01', '12:00', tz), tz)).toBe(60);
    expect(offsetMinutes(zonedInstant('2026-11-13', '12:00', tz), tz)).toBe(0);
  });

  it('builds [start, end) ranges covering exactly one local day', () => {
    const { start, end } = localDayRange('2027-01-15', 'Africa/Casablanca');
    expect(end.getTime() - start.getTime()).toBe(24 * 3600 * 1000);
    expect(localDay(start, 'Africa/Casablanca')).toBe('2027-01-15');
  });
});

describe('phone normalization (Morocco)', () => {
  it.each([
    ['0612345678', '+212612345678'],
    ['06 12 34 56 78', '+212612345678'],
    ['+212 6 12 34 56 78', '+212612345678'],
    ['00212712345678', '+212712345678'],
    ['0536-12-34-56', '+212536123456'],
    ['+33612345678', '+33612345678'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(['12345', '0412345678', '+2126123', 'abc'])('rejects %s', (input) => {
    expect(normalizePhone(input)).toBeNull();
  });

  it('formats Moroccan numbers for display', () => {
    expect(formatPhone('+212612345678')).toBe('+212 6 12 34 56 78');
  });
});

describe('formatting (Western digits in both languages)', () => {
  it('formats times on a 24-hour clock with Latin digits in Arabic', () => {
    const instant = new Date('2027-01-15T13:05:00Z');
    expect(formatTime('ar', instant, 'UTC')).toMatch(/13:05/);
    expect(formatTime('fr', instant, 'UTC')).toMatch(/13:05/);
  });

  it('formats MAD amounts from decimal strings', () => {
    expect(formatMoney('fr', '350.00')).toMatch(/350,00/);
    expect(formatMoney('ar', '350.00')).toMatch(/350/);
  });
});

describe('error mapping', () => {
  it('keeps known domain codes raised by the database', () => {
    expect(toErrorCode({ message: 'SLOT_UNAVAILABLE', code: 'P0001' })).toBe('SLOT_UNAVAILABLE');
  });

  it('maps PostgreSQL codes and never leaks raw messages', () => {
    expect(toErrorCode({ code: '42501', message: 'permission denied for table patients' })).toBe('FORBIDDEN');
    expect(toErrorCode({ code: '23P01', message: 'conflicting key value' })).toBe('SLOT_UNAVAILABLE');
    expect(toErrorCode({ code: '99999', message: 'something internal' })).toBe('INTERNAL');
  });

  it('turns transient concurrency conflicts into a retryable answer, not an internal error', () => {
    expect(toErrorCode({ code: '40P01', message: 'deadlock detected' })).toBe('UNAVAILABLE');
    expect(toErrorCode({ code: '40001', message: 'could not serialize access' })).toBe('UNAVAILABLE');
  });

  it('recognizes an unreachable backend', () => {
    expect(toErrorCode({ message: 'TypeError: fetch failed' })).toBe('UNAVAILABLE');
    expect(toErrorCode({ name: 'AuthRetryableFetchError', message: 'x' })).toBe('UNAVAILABLE');
  });
});
