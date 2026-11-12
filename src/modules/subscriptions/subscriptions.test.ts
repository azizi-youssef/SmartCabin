import { describe, expect, it } from 'vitest';

import { needsPeriod, nextSubscriptionStatuses, parseLimits, usageRatio } from './domain';

describe('subscription lifecycle in the UI (BUSINESS_RULES §7)', () => {
  it('offers the transitions platform_set_subscription accepts', () => {
    expect(nextSubscriptionStatuses('trialing')).toEqual(['trialing', 'active', 'expired']);
    expect(nextSubscriptionStatuses('active')).toEqual(['active', 'past_due', 'cancelled']);
    expect(nextSubscriptionStatuses('past_due')).toEqual(['past_due', 'active', 'expired']);
    expect(nextSubscriptionStatuses('cancelled')).toEqual(['cancelled', 'active', 'expired']);
    // From expired (or no subscription), a new one starts.
    expect(nextSubscriptionStatuses('expired')).toEqual(['trialing', 'active']);
    expect(nextSubscriptionStatuses(null)).toEqual(['trialing', 'active']);
  });

  it('asks for a paid period only where the database requires one', () => {
    expect(['trialing', 'active', 'past_due', 'cancelled', 'expired'].filter((s) => needsPeriod(s as never))).toEqual(['active', 'past_due', 'cancelled']);
  });
});

describe('plan limits (BR-T-08)', () => {
  it('reads limits with null as unlimited, ignoring unknown keys', () => {
    expect(parseLimits({ max_doctors: 3, max_staff: null, other: 9 })).toEqual({ max_doctors: 3, max_staff: null, monthly_sms_quota: null });
    expect(parseLimits(null)).toEqual({ max_doctors: null, max_staff: null, monthly_sms_quota: null });
  });

  it('measures usage against a limit, with no ratio when unlimited', () => {
    expect(usageRatio(2, 4)).toBe(0.5);
    expect(usageRatio(5, 4)).toBe(1.25);
    expect(usageRatio(3, null)).toBeNull();
    expect(usageRatio(0, 0)).toBe(1);
  });
});
