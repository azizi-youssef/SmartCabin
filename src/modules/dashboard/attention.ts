/*
 * "À traiter": what needs someone's action now, built from counts the caller may see. Pure, so
 * the order and the wording keys are tested; each item links to where it is handled.
 */

export type AttentionTone = 'danger' | 'warning' | 'info';

export interface AttentionItem {
  id: AttentionId;
  tone: AttentionTone;
  /** Values for the message (count, amount, date…). */
  values: Record<string, string | number>;
  href: string;
}

export type AttentionId =
  | 'subscriptionExpired'
  | 'subscriptionPastDue'
  | 'dpaPending'
  | 'pendingRequests'
  | 'unresolvedToday'
  | 'unpaidInvoices'
  | 'draftInvoices'
  | 'trialEnding'
  | 'onlineBookingOff';

export interface AttentionFacts {
  base: string;
  subscription?: { status: string; trialEndsInDays: number | null } | null;
  dpaPending?: boolean;
  pendingRequests?: number;
  unresolvedToday?: number;
  unpaid?: { count: number; balance: string } | null;
  drafts?: number;
  onlineBookingOff?: boolean;
}

const ORDER: Record<AttentionTone, number> = { danger: 0, warning: 1, info: 2 };

/** Items worth acting on, most urgent first; facts the caller may not see are simply absent. */
export function attentionItems(f: AttentionFacts): AttentionItem[] {
  const items: AttentionItem[] = [];
  const add = (id: AttentionId, tone: AttentionTone, href: string, values: Record<string, string | number> = {}) =>
    items.push({ id, tone, href, values });

  if (f.subscription?.status === 'expired') add('subscriptionExpired', 'danger', `${f.base}/subscription`);
  else if (f.subscription?.status === 'past_due') add('subscriptionPastDue', 'danger', `${f.base}/subscription`);
  else if (f.subscription?.status === 'trialing' && f.subscription.trialEndsInDays !== null && f.subscription.trialEndsInDays <= 7) {
    add('trialEnding', 'warning', `${f.base}/subscription`, { days: Math.max(0, f.subscription.trialEndsInDays) });
  }
  if (f.dpaPending) add('dpaPending', 'warning', `${f.base}/settings#dpa`);
  if (f.pendingRequests) add('pendingRequests', 'warning', `${f.base}/reception`, { count: f.pendingRequests });
  if (f.unresolvedToday) add('unresolvedToday', 'warning', `${f.base}/reception`, { count: f.unresolvedToday });
  if (f.unpaid && f.unpaid.count > 0) add('unpaidInvoices', 'info', `${f.base}/billing?status=unpaid`, { count: f.unpaid.count, amount: f.unpaid.balance });
  if (f.drafts) add('draftInvoices', 'info', `${f.base}/billing?status=draft`, { count: f.drafts });
  if (f.onlineBookingOff) add('onlineBookingOff', 'info', `${f.base}/settings#policy`);

  return items.sort((a, b) => ORDER[a.tone] - ORDER[b.tone]);
}

/** Whole days from one instant to another, rounded up (a trial ending in 3 h is "today", 0). */
export function daysUntil(instant: string | null, now: Date): number | null {
  if (!instant) return null;
  return Math.ceil((new Date(instant).getTime() - now.getTime()) / 86_400_000);
}
