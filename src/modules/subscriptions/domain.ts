import type { BadgeTone } from '@/shared/ui/badge';

/** BUSINESS_RULES §7. The database validates every transition; these shape what the UI offers. */
export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'cancelled', 'expired'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** BR-T-08 limits; null means unlimited. */
export const LIMIT_KEYS = ['max_doctors', 'max_staff', 'monthly_sms_quota'] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export type Limits = Record<LimitKey, number | null>;

export const READ_ONLY_REASONS = ['suspended', 'closed', 'subscription_expired'] as const;
export type ReadOnlyReason = (typeof READ_ONLY_REASONS)[number];

export const SUBSCRIPTION_TONE: Record<SubscriptionStatus, BadgeTone> = {
  trialing: 'info',
  active: 'success',
  past_due: 'warning',
  cancelled: 'neutral',
  expired: 'danger',
};

/** Mirrors platform_set_subscription: from a status (or none), the statuses one may set. */
export function nextSubscriptionStatuses(from: SubscriptionStatus | null): SubscriptionStatus[] {
  switch (from) {
    case 'trialing':
      return ['trialing', 'active', 'expired'];
    case 'active':
      return ['active', 'past_due', 'cancelled'];
    case 'past_due':
      return ['past_due', 'active', 'expired'];
    case 'cancelled':
      return ['cancelled', 'active', 'expired'];
    default:
      return ['trialing', 'active'];
  }
}

/** Active, past-due and cancelled subscriptions have a paid period. */
export function needsPeriod(status: SubscriptionStatus): boolean {
  return status === 'active' || status === 'past_due' || status === 'cancelled';
}

/** Share of a limit used, or null when unlimited. */
export function usageRatio(used: number, limit: number | null): number | null {
  return limit === null ? null : limit === 0 ? 1 : used / limit;
}

export function parseLimits(value: unknown): Limits {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(LIMIT_KEYS.map((k) => [k, typeof source[k] === 'number' ? source[k] : null])) as Limits;
}
