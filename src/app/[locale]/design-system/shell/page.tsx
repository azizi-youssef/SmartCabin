import { CalendarDays } from 'lucide-react';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { AppShell } from '@/shared/ui/app-shell';
import { Button } from '@/shared/ui/button';
import { DataTable } from '@/shared/ui/data-table';
import { MetricStrip, PageHeader, Section } from '@/shared/ui/layout';
import { EmptyState, InlineAlert } from '@/shared/ui/states';

import { Brand } from '../../_components/brand';
import { AccountMenu, ClinicSwitcher, LocaleSwitcher } from '../../_components/topbar';

export const metadata = { robots: { index: false } };

/**
 * Development-only preview of the workspace frame (404 in production): the real AppShell with
 * empty example content, so the layout can be reviewed in both directions without a backend.
 */
export default async function ShellPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  const t = await getTranslations();
  const base = '/design-system/shell';
  return (
    <AppShell
      brand={<Brand inverse />}
      navLabel={t('nav.mainNavigation')}
      labels={{ openMenu: t('common.openMenu'), closeMenu: t('common.closeMenu') }}
      groups={[
        {
          label: t('nav.operations'),
          items: [
            { href: base, label: t('nav.dashboard'), icon: 'dashboard', exact: true },
            { href: '/design-system/shell/reception', label: t('nav.reception'), icon: 'reception' },
            { href: '/design-system/shell/doctor', label: t('nav.doctor'), icon: 'doctor' },
          ],
        },
        { label: t('nav.records'), items: [{ href: '/design-system/shell/patients', label: t('nav.patients'), icon: 'patients' }] },
        { label: t('nav.platform'), items: [{ href: '/design-system', label: t('designSystem.title'), icon: 'design', exact: true }] },
      ]}
      banner={
        <InlineAlert tone="warning" className="rounded-none border-x-0 border-t-0 px-4 sm:px-6">
          {t('shell.pendingApproval')}
        </InlineAlert>
      }
      sidebarFooter={
        <div className="grid gap-0.5 text-small">
          <span dir="ltr" className="truncate text-nav-ink-active">example@example.test</span>
          <span className="text-caption text-nav-ink">{t('roles.clinic_owner')} · {t('roles.practitioner')}</span>
        </div>
      }
      topbar={
        <>
          <ClinicSwitcher current={{ slug: 'exemple', name: t('designSystem.title') }} clinics={[]} statusLabel="Nador" />
          <div className="ms-auto flex items-center gap-1">
            <LocaleSwitcher />
            <AccountMenu identity="example@example.test" roleLabel={t('roles.clinic_owner')} />
          </div>
        </>
      }
    >
      <PageHeader title={t('dashboard.title')} meta={t('designSystem.intro')} actions={<Button variant="primary">{t('reception.newAppointment')}</Button>} />
      <MetricStrip
        label={t('dashboard.metricsLabel')}
        metrics={[
          { id: 'total', label: t('dashboard.total'), value: '—' },
          { id: 'upcoming', label: t('dashboard.upcoming'), value: '—' },
          { id: 'in', label: t('dashboard.inClinic'), value: '—' },
          { id: 'done', label: t('dashboard.completed'), value: '—' },
          { id: 'cancelled', label: t('dashboard.cancelled'), value: '—' },
          { id: 'rate', label: t('dashboard.noShowRate'), value: '—', hint: t('dashboard.noShowRateHint') },
        ]}
      />
      <Section id="next" title={t('dashboard.nextTitle')}>
        <DataTable
          caption={t('dashboard.nextTitle')}
          columns={[{ id: 'time', header: t('columns.time'), cell: () => null }]}
          rows={[] as Array<{ id: string }>}
          getRowId={(r) => r.id}
          empty={<EmptyState icon={CalendarDays} title={t('dashboard.nextEmpty')} />}
        />
      </Section>
    </AppShell>
  );
}
