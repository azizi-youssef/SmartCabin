import { getLocale, getTranslations } from 'next-intl/server';

import type { Locale } from '@/i18n/routing';
import { LIMIT_KEYS, SUBSCRIPTION_TONE, usageRatio } from '@/modules/subscriptions/domain';
import { loadAvailablePlans, loadMySubscription } from '@/modules/subscriptions/queries';
import { PlanRequestForm } from '@/modules/subscriptions/ui/plan-request-form';
import { can, loadWorkspace } from '@/modules/tenancy/workspace';
import { formatDateTime, formatLongDate, formatMoney, formatNumber, formatPercent } from '@/shared/lib/format';
import { Badge } from '@/shared/ui/badge';
import { DataTable, type Column } from '@/shared/ui/data-table';
import { DetailList, PageHeader, Section } from '@/shared/ui/layout';
import { EmptyState, ErrorState, InlineAlert } from '@/shared/ui/states';

import { LoadFailure } from '../_lib/page-state';

export async function generateMetadata() {
  const t = await getTranslations('subscription');
  return { title: t('title') };
}

/**
 * The clinic's subscription (owner, admin, accountant): plan, status, period, limits and their
 * use. The owner can ask for another plan; the platform applies it (manual billing in the pilot).
 */
export default async function SubscriptionPage({ params }: { params: Promise<{ clinicSlug: string }> }) {
  const { clinicSlug } = await params;
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const result = await loadWorkspace(clinicSlug);
  if (result.status !== 'ok') return null;
  const ws = result.workspace;
  if (!can(ws, 'subscription.view')) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <ErrorState title={t('states.forbiddenTitle')} description={t('states.forbiddenBody')} />
      </div>
    );
  }
  const canRequest = can(ws, 'subscription.request_change');
  const [subscription, plans] = await Promise.all([
    loadMySubscription(ws.clinic.id),
    canRequest ? loadAvailablePlans(ws.clinic.id) : null,
  ]);
  const header = <PageHeader title={t('subscription.title')} description={t('subscription.subtitle')} />;
  if (subscription.status !== 'ok') return (<>{header}<LoadFailure outcome={subscription} /></>);
  const s = subscription.data;
  if (!s) {
    return (<>{header}<div className="rounded-lg border border-line bg-surface"><EmptyState title={t('subscription.none')} /></div></>);
  }
  const tz = ws.clinic.timezone;
  const lastDay = (iso: string) => formatLongDate(locale, new Date(new Date(iso).getTime() - 1), tz);

  const details = [
    { label: t('subscription.plan'), value: <span className="font-medium">{locale === 'ar' ? s.planNameAr : s.planNameFr}</span> },
    { label: t('subscription.statusLabel'), value: <Badge tone={SUBSCRIPTION_TONE[s.status]} dot>{t(`subscription.status.${s.status}`)}</Badge> },
    { label: t('subscription.price'), value: <span className="tabular">{t('subscription.perMonth', { price: formatMoney(locale, s.monthlyPriceMad) })}</span> },
    ...(s.periodStart && s.periodEnd
      ? [{ label: t('subscription.period'), value: t('subscription.periodValue', { from: formatLongDate(locale, s.periodStart, tz), to: lastDay(s.periodEnd) }) }]
      : []),
    ...(s.status === 'trialing'
      ? [{ label: t('subscription.trialEnds'), value: s.trialEndsAt ? lastDay(s.trialEndsAt) : t('subscription.noTrialEnd') }]
      : []),
    { label: t('subscription.since'), value: formatLongDate(locale, s.startedAt, tz) },
  ];

  type Row = { key: (typeof LIMIT_KEYS)[number] };
  const columns: Column<Row>[] = [
    { id: 'limit', header: t('subscription.limit'), cell: (r) => t(`subscription.limits.${r.key}`) },
    { id: 'used', header: t('subscription.used'), align: 'end', cell: (r) => <span className="tabular">{formatNumber(locale, s.usage[r.key] ?? 0)}</span> },
    {
      id: 'max',
      header: t('subscription.allowed'),
      align: 'end',
      cell: (r) => <span className="tabular">{s.limits[r.key] === null ? t('subscription.unlimited') : formatNumber(locale, s.limits[r.key] ?? 0)}</span>,
    },
    {
      id: 'ratio',
      header: t('subscription.usage'),
      align: 'end',
      hideBelow: 'sm',
      cell: (r) => {
        const ratio = usageRatio(s.usage[r.key] ?? 0, s.limits[r.key]);
        return ratio === null ? <span className="text-ink-subtle">—</span> : <span className={ratio >= 1 ? 'tabular font-medium text-danger' : 'tabular'}>{formatPercent(locale, Math.min(ratio, 1))}</span>;
      },
    },
  ];

  const otherPlans = plans?.status === 'ok' ? plans.data : [];
  return (
    <>
      {header}
      {s.readOnlyReason === 'subscription_expired' ? <InlineAlert tone="danger">{t('subscription.expiredNotice')}</InlineAlert> : null}
      {s.status === 'past_due' ? <InlineAlert tone="warning">{t('subscription.pastDueNotice')}</InlineAlert> : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Section id="plan" title={t('subscription.current')}>
          <div className="rounded-lg border border-line bg-surface p-4"><DetailList items={details} /></div>
        </Section>
        <Section id="limits" title={t('subscription.limitsTitle')} description={t('subscription.limitsHint')}>
          <DataTable caption={t('subscription.limitsTitle')} columns={columns} rows={LIMIT_KEYS.map((key) => ({ key }))} getRowId={(r) => r.key} />
        </Section>
      </div>
      {canRequest ? (
        <Section id="request" title={t('subscription.requestTitle')} description={t('subscription.requestHint')}>
          {s.openRequestPlanCode ? (
            <InlineAlert tone="info">
              {t('subscription.openRequest', { plan: s.openRequestPlanCode, date: s.openRequestAt ? formatDateTime(locale, s.openRequestAt, tz) : '—' })}
            </InlineAlert>
          ) : null}
          {otherPlans.length > 0
            ? <PlanRequestForm clinicId={ws.clinic.id} plans={otherPlans} current={s.planCode} />
            : <p className="text-small text-ink-muted">{t('subscription.noPlans')}</p>}
        </Section>
      ) : null}
    </>
  );
}
