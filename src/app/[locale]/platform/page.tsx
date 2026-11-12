import { Building2 } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { DEFAULT_TIME_ZONE, type Locale } from '@/i18n/routing';
import { loadPlatformClinics, loadPlatformOverview, nextClinicStatuses, type ClinicOverview, type PlatformClinic } from '@/modules/platform';
import { ClinicStatusActions } from '@/modules/platform/ui/clinic-status-actions';
import { SUBSCRIPTION_TONE } from '@/modules/subscriptions/domain';
import type { ClinicStatus } from '@/modules/tenancy/workspace';
import { formatNumber, formatShortDate } from '@/shared/lib/format';
import { Badge, type BadgeTone } from '@/shared/ui/badge';
import { CellStack, DataTable, type Column } from '@/shared/ui/data-table';
import { MetricStrip, PageHeader } from '@/shared/ui/layout';
import { EmptyState, ErrorState, UnavailableState } from '@/shared/ui/states';

export async function generateMetadata() {
  const t = await getTranslations('platform');
  return { title: t('title') };
}

const CLINIC_TONE: Record<ClinicStatus, BadgeTone> = {
  pending_approval: 'warning',
  active: 'success',
  suspended: 'danger',
  closed: 'neutral',
};

/**
 * Platform administration: clinic lifecycle, subscription and activity counts. The database
 * functions behind it return organization metadata and counts — never patient-level data (MD-18).
 */
export default async function PlatformPage() {
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const [clinics, overview] = await Promise.all([loadPlatformClinics(), loadPlatformOverview()]);
  const header = <PageHeader title={t('platform.title')} description={t('platform.subtitle')} />;

  if (clinics.status === 'unavailable') {
    return (<>{header}<div className="rounded-lg border border-line bg-surface"><UnavailableState title={t('states.unavailableTitle')} description={t('states.unavailableBody')} /></div></>);
  }
  if (clinics.status === 'error') {
    return (
      <>
        {header}
        <div className="rounded-lg border border-line bg-surface">
          <ErrorState title={clinics.code === 'FORBIDDEN' ? t('states.forbiddenTitle') : t('states.errorTitle')} description={clinics.code === 'FORBIDDEN' ? t('platform.forbidden') : t(`errors.${clinics.code}`)} />
        </div>
      </>
    );
  }

  const rows = clinics.data;
  const counts: ReadonlyMap<string, ClinicOverview> = overview.status === 'ok' ? overview.data : new Map();
  const countBy = (s: ClinicStatus) => rows.filter((c) => c.status === s).length;
  const openRequests = [...counts.values()].filter((o) => o.openRequestPlanCode).length;
  const columns: Column<PlatformClinic>[] = [
    {
      id: 'clinic',
      header: t('columns.clinic'),
      cell: (c) => (
        <CellStack
          primary={<Link href={`/platform/clinics/${c.id}`} className="focus-ring rounded-sm font-medium text-accent hover:underline">{c.displayName}</Link>}
          secondary={<span dir="ltr">{c.slug}</span>}
        />
      ),
    },
    { id: 'city', header: t('columns.city'), hideBelow: 'lg', className: 'w-32', cell: (c) => c.city },
    {
      id: 'status',
      header: t('columns.status'),
      className: 'w-48',
      cell: (c) => (
        <span className="grid gap-0.5">
          <Badge tone={CLINIC_TONE[c.status]} dot>{t(`clinicStatus.${c.status}`)}</Badge>
          {c.suspendedReason ? <span className="truncate text-caption text-ink-muted">{c.suspendedReason}</span> : null}
        </span>
      ),
    },
    {
      id: 'subscription',
      header: t('platform.subscription'),
      hideBelow: 'md',
      className: 'w-44',
      cell: (c) => {
        const o = counts.get(c.id);
        if (!o?.subscriptionStatus) return <span className="text-ink-subtle">—</span>;
        return (
          <span className="grid gap-0.5">
            <Badge tone={SUBSCRIPTION_TONE[o.subscriptionStatus]}>{t(`subscription.status.${o.subscriptionStatus}`)}</Badge>
            <span className="text-caption text-ink-muted">{locale === 'ar' ? o.planNameAr : o.planNameFr}</span>
            {o.openRequestPlanCode ? <span className="text-caption font-medium text-warning">{t('platform.openRequest', { plan: o.openRequestPlanCode })}</span> : null}
          </span>
        );
      },
    },
    { id: 'appointments', header: t('platform.appointments30d'), hideBelow: 'lg', align: 'end', className: 'w-28', cell: (c) => <span className="tabular">{formatNumber(locale, counts.get(c.id)?.appointments30d ?? 0)}</span> },
    { id: 'members', header: t('columns.members'), hideBelow: 'lg', align: 'end', className: 'w-24', cell: (c) => <span className="tabular">{formatNumber(locale, c.activeMembers)}</span> },
    { id: 'doctors', header: t('columns.doctors'), hideBelow: 'lg', align: 'end', className: 'w-24', cell: (c) => <span className="tabular">{formatNumber(locale, c.activeDoctors)}</span> },
    { id: 'created', header: t('columns.createdAt'), hideBelow: 'sm', className: 'w-32', cell: (c) => formatShortDate(locale, c.createdAt, DEFAULT_TIME_ZONE) },
    {
      id: 'actions',
      header: <span className="sr-only">{t('columns.actions')}</span>,
      align: 'end',
      className: 'w-px whitespace-nowrap',
      cell: (c) => <ClinicStatusActions clinic={{ id: c.id, name: c.displayName, status: c.status }} next={nextClinicStatuses(c.status)} />,
    },
  ];

  return (
    <>
      {header}
      <MetricStrip
        label={t('platform.metricsLabel')}
        metrics={[
          { id: 'total', label: t('platform.total'), value: formatNumber(locale, rows.length) },
          { id: 'review', label: t('platform.toReview'), value: formatNumber(locale, countBy('pending_approval')), tone: countBy('pending_approval') > 0 ? 'warning' : 'default' },
          { id: 'active', label: t('platform.active'), value: formatNumber(locale, countBy('active')) },
          { id: 'suspended', label: t('platform.suspended'), value: formatNumber(locale, countBy('suspended')) },
          { id: 'requests', label: t('platform.requests'), value: formatNumber(locale, openRequests), tone: openRequests > 0 ? 'warning' : 'default' },
        ]}
      />
      <DataTable
        caption={t('platform.title')}
        columns={columns}
        rows={rows}
        getRowId={(c) => c.id}
        rowClassName={(c) => (c.status === 'closed' ? 'text-ink-muted' : undefined)}
        empty={<EmptyState icon={Building2} title={t('platform.empty')} />}
      />
    </>
  );
}
