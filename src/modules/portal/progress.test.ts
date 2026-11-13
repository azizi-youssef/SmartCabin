import { describe, expect, it } from 'vitest';

import { isOngoing, needsLiveUpdates, progressIndex, stepStates } from './progress';

describe('appointment progress for patients', () => {
  it('places each status on the five steps, and leaves cancelled or missed ones off the path', () => {
    expect((['pending', 'confirmed', 'checked_in', 'in_progress', 'completed'] as const).map(progressIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(progressIndex('cancelled')).toBeNull();
    expect(progressIndex('no_show')).toBeNull();
  });

  it('marks earlier steps done, the reached one current, and every step done once completed', () => {
    expect(stepStates(0)).toEqual(['current', 'todo', 'todo', 'todo', 'todo']);
    expect(stepStates(2)).toEqual(['done', 'done', 'current', 'todo', 'todo']);
    expect(stepStates(4)).toEqual(['done', 'done', 'done', 'done', 'done']);
  });

  it('keeps an appointment under way on the upcoming list after its planned end', () => {
    const now = Date.parse('2026-11-13T12:00:00Z');
    const ended = '2026-11-13T11:30:00Z';
    expect(isOngoing({ status: 'in_progress', endsAt: ended }, now)).toBe(true);
    expect(isOngoing({ status: 'checked_in', endsAt: ended }, now)).toBe(true);
    expect(isOngoing({ status: 'completed', endsAt: ended }, now)).toBe(false);
    expect(isOngoing({ status: 'confirmed', endsAt: '2026-11-13T12:30:00Z' }, now)).toBe(true);
  });

  it('refreshes the page only when an appointment is close or under way', () => {
    const now = Date.parse('2026-11-13T08:00:00Z');
    expect(needsLiveUpdates({ status: 'confirmed', startsAt: '2026-11-13T15:00:00Z' }, now)).toBe(true);
    expect(needsLiveUpdates({ status: 'pending', startsAt: '2026-11-14T15:00:00Z' }, now)).toBe(false);
    expect(needsLiveUpdates({ status: 'checked_in', startsAt: '2026-11-13T07:00:00Z' }, now)).toBe(true);
    expect(needsLiveUpdates({ status: 'cancelled', startsAt: '2026-11-13T09:00:00Z' }, now)).toBe(false);
  });
});
