import { AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, CheckCircle2, CircleAlert, Info, Minus } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { periodRange, ratio } from '@/modules/analytics/kpi';
import { loadKpis, type KpiRow } from '@/modules/analytics/queries';
import { loadDayQueue } from '@/modules/reception/queries';
import { waitingOrder } from '@/modules/reception/queue';
import { loadMySubscription } from '@/modules/subscriptions/queries';
import { loadBookingPolicy, loadDpaStatus } from '@/modules/tenancy/queries';
import { cn } from '@/shared/lib/cn';
import { formatDateTime, formatMoney, formatNumber, formatPercent } from '@/shared/lib/format';
import { Badge, type BadgeTone } from '@/shared/ui/badge';
import { Skeleton } from '@/shared/ui/states';

import { attentionItems, daysUntil, type AttentionTone } from '../attention';
import { loadMoneyDue, loadPendingRequests } from '../queries';
import { countChange, isFavourable, rateChange, type Change } from '../trend';

/*
 * Dashboard panels (server components). Each loads its own data, so the page streams them in
 * behind placeholders of the same shape; each loads only what the caller's role may see.
 */

/** The part of the workspace the panels need (no Supabase client, no session token). */
export interface DashboardScope {
  clinicId: string;
  slug: string;
  timezone: string;
  today: string;
  can: (permission: string) => boolean;
  doctorNames: ReadonlyMap<string, string>;
}

function PanelFrame({ title, action, children, labelledBy }: { title: string; action?: ReactNode; children: ReactNode; labelledBy: string }) {
  return (
    <section aria-labelledby={labelledBy} className="grid content-start gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id={labelledBy} className="text-heading text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function PanelLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="focus-ring inline-flex items-center gap-1 rounded-sm text-small font-medium text-accent hover:underline">
      {children}
      <ArrowRight aria-hidden className="size-3.5 flip-rtl" />
    </Link>
  );
}

/** Placeholder with the geometry of a panel (no layout jump when it arrives). */
export function PanelSkeleton({ rows = 3, title }: { rows?: number; title: string }) {
  return (
    <div className="grid content-start gap-3" aria-busy="true" aria-label={title}>
      <Skeleton className="h-5 w-40" />
      <div className="grid gap-0 overflow-hidden rounded-lg border border-line bg-surface">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="border-b border-line px-4 py-3 last:border-b-0">
            <Skeleton className="h-4 w-3/4" />
          </div>
        ))}
      </div>
    </div>
  );
}

const TONE_ICON: Record<AttentionTone, typeof CircleAlert> = { danger: CircleAlert, warning: AlertTriangle, info: Info };
const TONE_CLASS: Record<AttentionTone, string> = { danger: 'text-danger', warning: 'text-warning', info: 'text-info' };

/** "À traiter": the actions waiting for someone, most urgent first. */
export async function AttentionPanel({ scope, unresolvedToday }: { scope: DashboardScope; unresolvedToday: number | null }) {
  const t = await getTranslations();
  const locale = (await getLocale()) as Locale;
  const base = `/w/${scope.slug}`;
  const [pending, money, subscription, dpa, policy] = await Promise.all([
    scope.can('appointments.view') ? loadPendingRequests(scope.clinicId) : null,
    scope.can('invoices.view') ? loadMoneyDue(scope.clinicId) : null,
    scope.can('subscription.view') ? loadMySubscription(scope.clinicId) : null,
    scope.can('legal.accept_clinic_dpa') ? loadDpaStatus(scope.clinicId) : null,
    scope.can('clinic.settings.update') ? loadBookingPolicy(scope.clinicId) : null,
  ]);
  const sub = subscription?.status === 'ok' ? subscription.data : null;
  const items = attentionItems({
    base,
    subscription: sub ? { status: sub.status, trialEndsInDays: daysUntil(sub.trialEndsAt, new Date()) } : null,
    dpaPending: dpa?.status === 'ok' && dpa.data !== null && dpa.data.acceptedAt === null,
    pendingRequests: pending?.status === 'ok' ? pending.data.total : 0,
    unresolvedToday: unresolvedToday ?? 0,
    unpaid: money?.status === 'ok' ? { count: money.data.unpaidCount, balance: money.data.balanceMad } : null,
    drafts: money?.status === 'ok' ? money.data.draftCount : 0,
    onlineBookingOff: policy?.status === 'ok' && policy.data !== null && !policy.data.onlineBookingEnabled,
  });
  const failed = [pending, money, subscription, dpa, policy].some((r) => r !== null && r.status !== 'ok');

  return (
    <PanelFrame title={t('dashboard.attention.title')} labelledBy="attention-title">
      {items.length === 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-body text-ink-muted">
          <CheckCircle2 aria-hidden className="size-4 shrink-0 text-success" />
          {failed ? t('dashboard.attention.partial') : t('dashboard.attention.none')}
        </div>
      ) : (
        <ul className="grid overflow-hidden rounded-lg border border-line bg-surface">
          {items.map((item) => {
            const Icon = TONE_ICON[item.tone];
            const values = 'amount' in item.values ? { ...item.values, amount: formatMoney(locale, String(item.values['amount'])) } : item.values;
            return (
              <li key={item.id} className="border-b border-line last:border-b-0">
                <Link href={item.href} className="focus-ring flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-sunken">
                  <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', TONE_CLASS[item.tone])} />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="text-body font-medium text-ink">{t(`dashboard.attention.${item.id}.title`, values)}</span>
                    <span className="text-small text-ink-muted">{t(`dashboard.attention.${item.id}.body`, values)}</span>
                  </span>
                  <ArrowRight aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-subtle flip-rtl" />
                </Link>
                {item.id === 'pendingRequests' && pending?.status === 'ok' ? (
                  <ul className="grid gap-1 px-4 pb-3 ps-11">
                    {pending.data.next.map((p) => (
                      <li key={p.id}>
                        <Link href={`${base}/appointments/${p.id}`} className="focus-ring flex flex-wrap gap-x-2 rounded-sm text-small text-accent hover:underline">
                          <time dateTime={p.startsAt} className="tabular">{formatDateTime(locale, p.startsAt, scope.timezone)}</time>
                          <span className="text-ink-muted">{[p.patientName, scope.doctorNames.get(p.doctorId)].filter(Boolean).join(' · ')}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </PanelFrame>
  );
}

const SESSION_TONE: Record<string, BadgeTone> = { planned: 'neutral', open: 'success', paused: 'warning', closed: 'neutral' };

/** "Files d'attente": each doctor's day right now (queue.view; a doctor sees their own). */
export async function QueuePanel({ scope }: { scope: DashboardScope }) {
  const t = await getTranslations();
  const queue = await loadDayQueue(scope.clinicId, scope.today);
  const action = scope.can('appointments.book') ? <PanelLink href={`/w/${scope.slug}/reception`}>{t('dashboard.openReception')}</PanelLink> : null;
  if (queue.status !== 'ok') {
    return (
      <PanelFrame title={t('dashboard.queue.title')} labelledBy="queue-title" action={action}>
        <p className="rounded-lg border border-line bg-surface px-4 py-3 text-small text-ink-muted">{t('dashboard.panelUnavailable')}</p>
      </PanelFrame>
    );
  }
  const rows = queue.data.sessions.map((s) => {
    const entries = queue.data.entries.filter((e) => e.sessionId === s.id);
    return {
      session: s,
      waiting: waitingOrder(entries).length,
      inConsultation: entries.find((e) => e.state === 'in_consultation')?.ticketNumber ?? null,
    };
  });
  return (
    <PanelFrame title={t('dashboard.queue.title')} labelledBy="queue-title" action={action}>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-line bg-surface px-4 py-3 text-small text-ink-muted">{t('dashboard.queue.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full border-collapse text-body">
            <caption className="sr-only">{t('dashboard.queue.title')}</caption>
            <thead className="bg-surface-muted text-caption text-ink-muted">
              <tr className="border-b border-line">
                <th scope="col" className="h-9 px-3 text-start font-medium">{t('columns.doctor')}</th>
                <th scope="col" className="h-9 px-3 text-start font-medium">{t('dashboard.queue.day')}</th>
                <th scope="col" className="h-9 px-3 text-end font-medium">{t('dashboard.queue.waiting')}</th>
                <th scope="col" className="hidden h-9 px-3 text-end font-medium sm:table-cell">{t('dashboard.queue.inConsultation')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.session.id} className="border-b border-line last:border-b-0">
                  <td className="h-10 px-3">{scope.doctorNames.get(r.session.doctorId) ?? '—'}</td>
                  <td className="h-10 px-3">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={SESSION_TONE[r.session.status] ?? 'neutral'} dot>{t(`queue.session.${r.session.status}`)}</Badge>
                      {r.session.announcedDelayMinutes > 0 ? (
                        <span className="text-caption text-warning">{t('dashboard.queue.delay', { minutes: r.session.announcedDelayMinutes })}</span>
                      ) : null}
                    </span>
                  </td>
                  <td className="h-10 px-3 text-end tabular">{r.waiting}</td>
                  <td className="hidden h-10 px-3 text-end tabular sm:table-cell">{r.inConsultation === null ? '—' : t('reception.ticket', { ticket: r.inConsultation })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PanelFrame>
  );
}

function ChangeLabel({ change, higherIsBetter, points, locale, t }: {
  change: Change | null;
  higherIsBetter: boolean;
  points: boolean;
  locale: Locale;
  t: (key: string, values?: Record<string, string>) => string;
}) {
  if (!change) return <span className="text-caption text-ink-subtle">{t('dashboard.week.noBase')}</span>;
  const good = isFavourable(change, higherIsBetter);
  const Icon = change.direction === 'up' ? ArrowUpRight : change.direction === 'down' ? ArrowDownRight : Minus;
  const value = points
    ? t('dashboard.week.points', { value: `${change.amount > 0 ? '+' : ''}${formatNumber(locale, Math.round(change.amount * 10) / 10)}` })
    : `${change.amount > 0 ? '+' : ''}${formatPercent(locale, change.amount)}`;
  return (
    <span className={cn('inline-flex items-center gap-1 text-caption tabular', good === null ? 'text-ink-muted' : good ? 'text-success' : 'text-danger')}>
      <Icon aria-hidden className="size-3.5" />
      {t(`dashboard.week.${change.direction}`, { value })}
    </span>
  );
}

/** "7 derniers jours": the main indicators against the 7 days before (analytics.operational). */
export async function WeekPanel({ scope }: { scope: DashboardScope }) {
  const t = await getTranslations();
  const locale = (await getLocale()) as Locale;
  const current = periodRange('7d', scope.today);
  // The 7 days that end the day before the current window.
  const before = periodRange('7d', shiftDay(current.from, -1));
  const [now, prev] = await Promise.all([
    loadKpis({ clinicId: scope.clinicId, from: current.from, to: current.to, group: 'total' }),
    loadKpis({ clinicId: scope.clinicId, from: before.from, to: before.to, group: 'total' }),
  ]);
  const action = <PanelLink href={`/w/${scope.slug}/analytics?period=7d`}>{t('dashboard.week.details')}</PanelLink>;
  const a = now.status === 'ok' ? now.data[0] : undefined;
  const b = prev.status === 'ok' ? prev.data[0] : undefined;
  if (!a) {
    return (
      <PanelFrame title={t('dashboard.week.title')} labelledBy="week-title" action={action}>
        <p className="rounded-lg border border-line bg-surface px-4 py-3 text-small text-ink-muted">{t('dashboard.panelUnavailable')}</p>
      </PanelFrame>
    );
  }
  const noShow = (r?: KpiRow) => (r ? ratio(r.noShow, r.noShowDenominator) : null);
  const occupancy = (r?: KpiRow) => (r ? ratio(r.bookedMinutes, r.availableMinutes) : null);
  const tr = (key: string, values?: Record<string, string>) => t(key, values);
  const rows: Array<{ id: string; label: string; value: string; change: Change | null; higherIsBetter: boolean; points: boolean }> = [
    { id: 'appointments', label: t('analytics.k1'), value: formatNumber(locale, a.appointments), change: b ? countChange(a.appointments, b.appointments) : null, higherIsBetter: true, points: false },
    { id: 'completed', label: t('analytics.k2'), value: formatNumber(locale, a.completed), change: b ? countChange(a.completed, b.completed) : null, higherIsBetter: true, points: false },
    {
      id: 'no-show', label: t('analytics.k4'), value: noShow(a) === null ? '—' : formatPercent(locale, noShow(a) ?? 0),
      change: rateChange(noShow(a), noShow(b)), higherIsBetter: false, points: true,
    },
    {
      id: 'occupancy', label: t('analytics.k6'), value: occupancy(a) === null ? '—' : formatPercent(locale, occupancy(a) ?? 0),
      change: rateChange(occupancy(a), occupancy(b)), higherIsBetter: true, points: true,
    },
  ];
  return (
    <PanelFrame title={t('dashboard.week.title')} labelledBy="week-title" action={action}>
      <dl className="grid overflow-hidden rounded-lg border border-line bg-surface">
        {rows.map((r) => (
          <div key={r.id} className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
            <dt className="text-small text-ink-muted">{r.label}</dt>
            <dd className="grid justify-items-end gap-0.5">
              <span className="text-heading tabular text-ink">{r.value}</span>
              <ChangeLabel change={r.change} higherIsBetter={r.higherIsBetter} points={r.points} locale={locale} t={tr} />
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-caption text-ink-subtle">{t('dashboard.week.note')}</p>
    </PanelFrame>
  );
}

function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
