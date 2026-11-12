import { describe, expect, it } from 'vitest';

import { estimateRange, minutesSince, unresolvedAppointments, waitingOrder, type QueueEntry } from './queue';

const entry = (ticketNumber: number, sortKey: number, state: QueueEntry['state'] = 'waiting', priorityLevel = 0) =>
  ({ ticketNumber, sortKey, state, priorityLevel });

describe('waiting order (BR-Q-04, BR-Q-05)', () => {
  it('lists waiting and called entries by priority, then sort key, then ticket', () => {
    const ordered = waitingOrder([
      entry(1, 300), // walk-in who arrived at 300
      entry(2, 100), // on-time patient booked at 100
      entry(3, 100), // same anchor: ticket breaks the tie
      entry(4, 900, 'waiting', 1), // priority set by staff
      entry(5, 50, 'in_consultation'),
      entry(6, 10, 'closed'),
      entry(7, 200, 'called'),
    ]);
    expect(ordered.map((e) => e.ticketNumber)).toEqual([4, 2, 3, 7, 1]);
  });
});

describe('reception helpers', () => {
  it('counts whole minutes of waiting, never negative', () => {
    const now = new Date('2027-01-04T10:00:00Z');
    expect(minutesSince('2027-01-04T09:47:30Z', now)).toBe(12);
    expect(minutesSince('2027-01-04T10:05:00Z', now)).toBe(0);
  });

  it('lists confirmed appointments whose grace period is over as unresolved (MD-09)', () => {
    const now = new Date('2027-01-04T10:00:00Z');
    const rows = [
      { id: 'late', status: 'confirmed', startsAt: '2027-01-04T09:30:00Z' }, // 30 min ago
      { id: 'grace', status: 'confirmed', startsAt: '2027-01-04T09:50:00Z' }, // within 15 min
      { id: 'arrived', status: 'checked_in', startsAt: '2027-01-04T09:00:00Z' },
      { id: 'absent', status: 'no_show', startsAt: '2027-01-04T08:00:00Z' },
    ];
    expect(unresolvedAppointments(rows, now, 15).map((r) => r.id)).toEqual(['late']);
  });
});

describe('estimate range (BUSINESS_RULES §3.2)', () => {
  it('shows the expected wait plus or minus 20 %, rounded to 5 minutes', () => {
    const now = new Date('2027-01-04T10:00:00Z');
    const range = estimateRange('2027-01-04T10:50:00Z', now); // 50 min wait → 40 to 60 min
    expect(range?.low.toISOString()).toBe('2027-01-04T10:40:00.000Z');
    expect(range?.high.toISOString()).toBe('2027-01-04T11:00:00.000Z');
  });

  it('never shows a past range, and nothing without an estimate', () => {
    const now = new Date('2027-01-04T10:00:00Z');
    expect(estimateRange('2027-01-04T09:30:00Z', now)).toEqual({ low: now, high: now });
    expect(estimateRange(null, now)).toBeNull();
  });
});

describe('estimate range with measured spread', () => {
  it('widens the upper bound to p80 − median when that is more than 20 %', () => {
    const now = new Date('2027-01-04T10:00:00Z');
    // 50 min wait: low 40 min; high 50 + max(10, 15) = 65 min.
    const range = estimateRange('2027-01-04T10:50:00Z', now, 15);
    expect(range?.low.toISOString()).toBe('2027-01-04T10:40:00.000Z');
    expect(range?.high.toISOString()).toBe('2027-01-04T11:05:00.000Z');
  });
});
