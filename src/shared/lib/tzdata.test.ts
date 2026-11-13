// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { formatTime } from './format';
import { localDay, zonedInstant } from './time';
import { timeZoneDataProblem } from './tzdata';

/*
 * SC-AUD-24 guard: fails when the Node.js runtime's time zone data predates Morocco's move to
 * UTC+0 (20 September 2026, tzdata 2026c), instead of letting the server shift every time.
 */
const TZ = 'Africa/Casablanca';

describe('time zone data of the runtime (SC-AUD-24)', () => {
  it('knows that Morocco is on UTC+0 since 20 September 2026', () => {
    expect(timeZoneDataProblem()).toBeNull();
  });

  it('shows and stores clinic times in Nador as PostgreSQL does', () => {
    // After the change: a 15:00 booking is 15:00Z, and staff-entered 15:00 is stored as 15:00Z.
    expect(formatTime('fr', '2026-11-13T15:00:00Z', TZ)).toBe('15:00');
    expect(zonedInstant('2026-11-13', '15:00', TZ).toISOString()).toBe('2026-11-13T15:00:00.000Z');
    expect(localDay(new Date('2026-11-13T23:30:00Z'), TZ)).toBe('2026-11-13');
    // Before it (summer 2026, UTC+1), past appointments keep their original local time.
    expect(formatTime('fr', '2026-07-01T15:00:00Z', TZ)).toBe('16:00');
    expect(zonedInstant('2026-07-01', '16:00', TZ).toISOString()).toBe('2026-07-01T15:00:00.000Z');
  });
});
