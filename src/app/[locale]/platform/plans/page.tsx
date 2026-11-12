import { getLocale, getTranslations } from 'next-intl/server';

import type { Locale } from '@/i18n/routing';
import { loadPlatformPlans, type PlatformPlan } from '@/modules/platform';
import { PlanDialog } from '@/modules/platform/ui/plan-dialog';
import { LIMIT_KEYS } from '@/modules/subscriptions/domain';
import { formatMoney, formatNumber } from '@/shared/lib/format';
import { Badge } from '@/shared/ui/badge';
import { CellStack, DataTable, type Column } from '@/shared/ui/data-table';
import { PageHeader } from '@/shared/ui/layout';
import { EmptyState, ErrorState, UnavailableState } from '@/shared/ui/states';

export async function generateMetadata() {
  const t = await getTranslations('platformPlans');
  return { title: t('title') };
}

/**
 * Plans and their limits (BR-T-08). Prices and limits are commercial decisions: the seeded
 * "pilot" plan is neutral (0 MAD, no limit). A plan is retired, never deleted.
 */
export default async function PlatformPlansPage() {
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const plans = await loadPlatformPlans();
  const header = <PageHeader title={t('platformPlans.title')} description={t('platformPlans.subtitle')} actions={<PlanDialog />} />;
  if (plans.status === 'unavailable') {
    return (<>{header}<div className="rounded-lg border border-line bg-surface"><UnavailableState title={t('states.unavailableTitle')} description={t('states.unavailableBody')} /></div></>);
  }
  if (plans.status === 'error') {
    return (<>{header}<div className="rounded-lg border border-line bg-surface"><ErrorState title={t('states.errorTitle')} description={t('platform.forbidden')} /></div></>);
  }

  const limit = (v: number | null) => (v === null ? t('subscription.unlimited') : formatNumber(locale, v));
  const columns: Column<PlatformPlan>[] = [
    {
      id: 'plan',
      header: t('subscription.plan'),
      cell: (p) => <CellStack primary={locale === 'ar' ? p.nameAr : p.nameFr} secondary={<span dir="ltr">{p.code}</span>} />,
    },
    { id: 'price', header: t('platformPlans.price'), align: 'end', className: 'w-32', cell: (p) => <span className="tabular">{formatMoney(locale, p.monthlyPriceMad)}</span> },
    ...LIMIT_KEYS.map((k): Column<PlatformPlan> => ({
      id: k, header: t(`subscription.limits.${k}`), align: 'end', hideBelow: 'md', className: 'w-28', cell: (p) => <span className="tabular">{limit(p.limits[k])}</span>,
    })),
    { id: 'grace', header: t('platformPlans.graceDays'), align: 'end', hideBelow: 'lg', className: 'w-24', cell: (p) => <span className="tabular">{formatNumber(locale, p.graceDays)}</span> },
    { id: 'subs', header: t('platformPlans.subscriptions'), align: 'end', hideBelow: 'sm', className: 'w-28', cell: (p) => <span className="tabular">{formatNumber(locale, p.liveSubscriptions)}</span> },
    {
      id: 'state',
      header: t('columns.status'),
      className: 'w-40',
      cell: (p) => (
        <span className="flex flex-wrap gap-1">
          <Badge tone={p.isActive ? 'success' : 'neutral'}>{p.isActive ? t('platformPlans.active') : t('platformPlans.retired')}</Badge>
          {p.isPublic ? null : <Badge>{t('platformPlans.private')}</Badge>}
        </span>
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">{t('columns.actions')}</span>,
      align: 'end',
      className: 'w-px whitespace-nowrap',
      cell: (p) => <PlanDialog plan={{ id: p.id, code: p.code, nameFr: p.nameFr, nameAr: p.nameAr, monthlyPriceMad: p.monthlyPriceMad, graceDays: p.graceDays, isPublic: p.isPublic, isActive: p.isActive, limits: p.limits }} />,
    },
  ];

  return (
    <>
      {header}
      <DataTable caption={t('platformPlans.title')} columns={columns} rows={plans.data} getRowId={(p) => p.id} empty={<EmptyState title={t('platformPlans.empty')} />} />
    </>
  );
}
