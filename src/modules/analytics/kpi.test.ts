import { describe, expect, it } from 'vitest';

import { dayCount, minutesParts, periodRange, ratio } from './kpi';

describe('KPI periods (local dates)', () => {
  it('builds inclusive ranges from the clinic day', () => {
    expect(periodRange('today', '2026-11-12')).toEqual({ from: '2026-11-12', to: '2026-11-12' });
    expect(periodRange('7d', '2026-11-12')).toEqual({ from: '2026-11-06', to: '2026-11-12' });
    expect(periodRange('30d', '2026-11-12')).toEqual({ from: '2026-10-14', to: '2026-11-12' });
    expect(periodRange('month', '2026-11-12')).toEqual({ from: '2026-11-01', to: '2026-11-12' });
    expect(periodRange('previous_month', '2026-11-12')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(periodRange('previous_month', '2026-03-05')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodRange('previous_month', '2027-01-15')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('counts days across month ends and time changes', () => {
    expect(dayCount('2026-11-12', '2026-11-12')).toBe(1);
    expect(dayCount('2026-10-14', '2026-11-12')).toBe(30);
    expect(dayCount('2026-03-25', '2026-04-05')).toBe(12);
  });
});

describe('KPI ratios', () => {
  it('is undefined (null), never 0, when the denominator is zero (K4, K6)', () => {
    expect(ratio(1, 4)).toBe(0.25);
    expect(ratio(0, 3)).toBe(0);
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(5, null)).toBeNull();
  });

  it('splits minutes into hours and minutes', () => {
    expect(minutesParts(45)).toEqual({ hours: 0, minutes: 45 });
    expect(minutesParts(65.4)).toEqual({ hours: 1, minutes: 5 });
    expect(minutesParts(-3)).toEqual({ hours: 0, minutes: 0 });
  });
});
