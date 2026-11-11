import { Building2 } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { redirect } from '@/i18n/navigation';
import { DEFAULT_TIME_ZONE, type Locale } from '@/i18n/routing';
import { loadPlatformClinics, nextClinicStatuses, type PlatformClinic } from '@/modules/platform';
import { ClinicStatusActions } from '@/modules/platform/ui/clinic-status-actions';
import { loadMemberships, type ClinicStatus } from '@/modules/tenancy/workspace';
import { formatNumber, formatShortDate } from '@/shared/lib/format';
import { AppShell } from '@/shared/ui/app-shell';
import { Badge, type BadgeTone } from '@/shared/ui/badge';
import { CellStack, DataTable, type Column } from '@/shared/ui/data-table';
import { MetricStrip, PageHeader } from '@/shared/ui/layout';
import { EmptyState, ErrorState, UnavailableState } from '@/shared/ui/states';

import { Brand } from '../_components/brand';
import { ServiceUnavailablePage } from '../_components/service-unavailable';
import { AccountMenu, LocaleSwitcher } from '../_components/topbar';

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
 * Platform administration: clinic lifecycle only. The database function behind it returns
 * organization metadata and counts — never patient-level data (MD-18).
 */
export default async function PlatformPage() {
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const memberships = await loadMemberships();
  if (memberships.status === 'anonymous') redirect({ href: '/sign-in', locale });
  if (memberships.status !== 'ok') return <ServiceUnavailablePage />;
  if (memberships.isPlatformAdmin && memberships.session.aal !== 'aal2') redirect({ href: '/mfa', locale });

  const clinics = await loadPlatformClinics();
  const identity = memberships.session.email ?? '';

  let body;
  if (clinics.status === 'unavailable') {
    body = <div className="rounded-lg border border-line bg-surface"><UnavailableState title={t('states.unavailableTitle')} description={t('states.unavailableBody')} /></div>;
  } else if (clinics.status === 'error') {
    body = (
      <div className="rounded-lg border border-line bg-surface">
        <ErrorState title={clinics.code === 'FORBIDDEN' ? t('states.forbiddenTitle') : t('states.errorTitle')} description={clinics.code === 'FORBIDDEN' ? t('platform.forbidden') : t(`errors.${clinics.code}`)} />
      </div>
    );
  } else {
    const rows = clinics.data;
    const countBy = (s: ClinicStatus) => rows.filter((c) => c.status === s).length;
    const columns: Column<PlatformClinic>[] = [
      {
        id: 'clinic',
        header: t('columns.clinic'),
        cell: (c) => <CellStack primary={c.displayName} secondary={<span dir="ltr">{c.slug}</span>} />,
      },
      { id: 'city', header: t('columns.city'), hideBelow: 'md', className: 'w-32', cell: (c) => c.city },
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
      { id: 'members', header: t('columns.members'), hideBelow: 'lg', align: 'end', className: 'w-32', cell: (c) => <span className="tabular">{formatNumber(locale, c.activeMembers)}</span> },
      { id: 'doctors', header: t('columns.doctors'), hideBelow: 'lg', align: 'end', className: 'w-32', cell: (c) => <span className="tabular">{formatNumber(locale, c.activeDoctors)}</span> },
      { id: 'created', header: t('columns.createdAt'), hideBelow: 'sm', className: 'w-32', cell: (c) => formatShortDate(locale, c.createdAt, DEFAULT_TIME_ZONE) },
      {
        id: 'actions',
        header: <span className="sr-only">{t('columns.actions')}</span>,
        align: 'end',
        className: 'w-px whitespace-nowrap',
        cell: (c) => <ClinicStatusActions clinic={{ id: c.id, name: c.displayName, status: c.status }} next={nextClinicStatuses(c.status)} />,
      },
    ];
    body = (
      <>
        <MetricStrip
          label={t('platform.metricsLabel')}
          metrics={[
            { id: 'total', label: t('platform.total'), value: formatNumber(locale, rows.length) },
            { id: 'review', label: t('platform.toReview'), value: formatNumber(locale, countBy('pending_approval')), tone: countBy('pending_approval') > 0 ? 'warning' : 'default' },
            { id: 'active', label: t('platform.active'), value: formatNumber(locale, countBy('active')) },
            { id: 'suspended', label: t('platform.suspended'), value: formatNumber(locale, countBy('suspended')) },
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

  return (
    <AppShell
      brand={<Brand inverse />}
      navLabel={t('nav.mainNavigation')}
      labels={{ openMenu: t('common.openMenu'), closeMenu: t('common.closeMenu') }}
      groups={[
        { label: t('nav.platform'), items: [{ href: '/platform', label: t('nav.clinics'), icon: 'clinics' }] },
        ...(memberships.memberships.length > 0
          ? [{ label: t('shell.clinics'), items: memberships.memberships.map((m) => ({ href: `/w/${m.slug}`, label: m.displayName, icon: 'dashboard' as const })) }]
          : []),
      ]}
      sidebarFooter={
        <div className="grid gap-0.5 text-small">
          <span dir="ltr" className="truncate text-nav-ink-active">{identity}</span>
          <span className="text-caption text-nav-ink">{t('roles.platform_admin')}</span>
        </div>
      }
      topbar={
        <>
          <span className="text-body font-semibold text-ink">{t('nav.platform')}</span>
          <div className="ms-auto flex items-center gap-1">
            <LocaleSwitcher />
            <AccountMenu identity={identity} roleLabel={t('roles.platform_admin')} />
          </div>
        </>
      }
    >
      <PageHeader title={t('platform.title')} description={t('platform.subtitle')} />
      {body}
    </AppShell>
  );
}
