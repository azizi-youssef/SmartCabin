import { describe, expect, it } from 'vitest';

import { attentionItems, daysUntil } from './attention';
import { countChange, isFavourable, rateChange } from './trend';

describe('"À traiter" items', () => {
  const base = '/w/cabinet';

  it('lists only what needs action, most urgent first, each with its link', () => {
    const items = attentionItems({
      base,
      subscription: { status: 'past_due', trialEndsInDays: null },
      dpaPending: true,
      pendingRequests: 2,
      unresolvedToday: 0,
      unpaid: { count: 3, balance: '450.00' },
      drafts: 1,
      onlineBookingOff: true,
    });
    expect(items.map((i) => [i.id, i.tone])).toEqual([
      ['subscriptionPastDue', 'danger'],
      ['dpaPending', 'warning'],
      ['pendingRequests', 'warning'],
      ['unpaidInvoices', 'info'],
      ['draftInvoices', 'info'],
      ['onlineBookingOff', 'info'],
    ]);
    expect(items.find((i) => i.id === 'unpaidInvoices')).toMatchObject({ href: '/w/cabinet/billing?status=unpaid', values: { count: 3, amount: '450.00' } });
  });

  it('says nothing when everything is in order, or when the caller may not see a fact', () => {
    expect(attentionItems({ base })).toEqual([]);
    expect(attentionItems({ base, subscription: { status: 'active', trialEndsInDays: null }, unpaid: { count: 0, balance: '0.00' }, pendingRequests: 0 })).toEqual([]);
  });

  it('warns about a trial ending within 7 days, and an expired subscription comes first', () => {
    expect(attentionItems({ base, subscription: { status: 'trialing', trialEndsInDays: 3 } })[0]).toMatchObject({ id: 'trialEnding', values: { days: 3 } });
    expect(attentionItems({ base, subscription: { status: 'trialing', trialEndsInDays: 20 } })).toEqual([]);
    expect(attentionItems({ base, subscription: { status: 'trialing', trialEndsInDays: null } })).toEqual([]);
    expect(attentionItems({ base, drafts: 2, subscription: { status: 'expired', trialEndsInDays: null } })[0]?.id).toBe('subscriptionExpired');
  });

  it('counts days left, rounded up', () => {
    const now = new Date('2026-11-12T10:00:00Z');
    expect(daysUntil('2026-11-12T13:00:00Z', now)).toBe(1);
    expect(daysUntil('2026-11-15T10:00:00Z', now)).toBe(3);
    expect(daysUntil(null, now)).toBeNull();
  });
});

describe('week-over-week changes', () => {
  it('compares counts relatively, and gives no change without a base', () => {
    expect(countChange(12, 10)).toEqual({ direction: 'up', amount: 0.2 });
    expect(countChange(8, 10)).toEqual({ direction: 'down', amount: -0.2 });
    expect(countChange(10, 10)?.direction).toBe('flat');
    expect(countChange(5, 0)).toBeNull();
  });

  it('compares rates in points, and gives no change when a rate is unknown', () => {
    expect(rateChange(0.12, 0.1)?.direction).toBe('up');
    expect(rateChange(0.12, 0.1)?.amount).toBeCloseTo(2);
    expect(rateChange(0.1, 0.101)?.direction).toBe('flat');
    expect(rateChange(null, 0.1)).toBeNull();
  });

  it('knows which direction is good news', () => {
    expect(isFavourable({ direction: 'up', amount: 0.2 }, true)).toBe(true);
    expect(isFavourable({ direction: 'up', amount: 2 }, false)).toBe(false);
    expect(isFavourable({ direction: 'flat', amount: 0 }, true)).toBeNull();
  });
});
