import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { redirect } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { can, loadMemberships, loadWorkspace } from '@/modules/tenancy/workspace';
import { formatLongDate } from '@/shared/lib/format';
import { AppShell, type NavGroup } from '@/shared/ui/app-shell';
import { InlineAlert } from '@/shared/ui/states';

import { Brand } from '../../_components/brand';
import { ServiceUnavailablePage } from '../../_components/service-unavailable';
import { AccountMenu, ClinicSwitcher, LocaleSwitcher } from '../../_components/topbar';

export default async function WorkspaceLayout({ children, params }: { children: ReactNode; params: Promise<{ clinicSlug: string }> }) {
  const { clinicSlug } = await params;
  const locale = (await getLocale()) as Locale;
  const result = await loadWorkspace(clinicSlug);

  if (result.status === 'anonymous') redirect({ href: '/sign-in', locale });
  if (result.status === 'mfa_required') redirect({ href: '/mfa', locale });
  if (result.status === 'not_found') notFound();
  if (result.status !== 'ok') return <ServiceUnavailablePage />;

  const ws = result.workspace;
  const memberships = await loadMemberships();
  const isPlatformAdmin = memberships.status === 'ok' && memberships.isPlatformAdmin;
  const t = await getTranslations();
  const base = `/w/${ws.clinic.slug}`;

  const operations: NavGroup = { label: t('nav.operations'), items: [{ href: base, label: t('nav.dashboard'), icon: 'dashboard', exact: true }] };
  if (can(ws, 'appointments.book')) operations.items.push({ href: `${base}/reception`, label: t('nav.reception'), icon: 'reception' });
  if (ws.isPractitioner) operations.items.push({ href: `${base}/doctor`, label: t('nav.doctor'), icon: 'doctor' });
  const groups: NavGroup[] = [operations];
  if (can(ws, 'patients.view')) {
    groups.push({ label: t('nav.records'), items: [{ href: `${base}/patients`, label: t('nav.patients'), icon: 'patients' }] });
  }
  const clinicItems: NavGroup['items'] = [];
  if (can(ws, 'doctors.manage')) clinicItems.push({ href: `${base}/doctors`, label: t('nav.doctors'), icon: 'doctor' });
  if (can(ws, 'services.manage')) clinicItems.push({ href: `${base}/services`, label: t('nav.services'), icon: 'services' });
  if (can(ws, 'schedules.view')) clinicItems.push({ href: `${base}/schedules`, label: t('nav.schedules'), icon: 'schedules' });
  if (can(ws, 'members.view')) clinicItems.push({ href: `${base}/team`, label: t('nav.team'), icon: 'team' });
  if (can(ws, 'clinic.settings.update') || can(ws, 'clinic.profile.update') || can(ws, 'clinic.closures.manage')) {
    clinicItems.push({ href: `${base}/settings`, label: t('nav.settings'), icon: 'settings' });
  }
  if (clinicItems.length > 0) groups.push({ label: t('nav.clinic'), items: clinicItems });
  if (isPlatformAdmin) {
    groups.push({ label: t('nav.platform'), items: [{ href: '/platform', label: t('nav.clinics'), icon: 'clinics' }] });
  }

  const roleLabel = t(`roles.${ws.role}`) + (ws.isPractitioner && ws.role !== 'doctor' ? ` · ${t('roles.practitioner')}` : '');
  const identity = ws.session.email ?? ws.session.phone ?? '';
  const banner =
    ws.clinic.status === 'pending_approval' ? (
      <InlineAlert tone="warning" className="rounded-none border-x-0 border-t-0 px-4 sm:px-6">
        {t('shell.pendingApproval')}
      </InlineAlert>
    ) : ws.clinic.status === 'suspended' ? (
      <InlineAlert tone="danger" className="rounded-none border-x-0 border-t-0 px-4 sm:px-6">
        {t('shell.suspended')}
      </InlineAlert>
    ) : null;

  return (
    <AppShell
      brand={<Brand inverse />}
      groups={groups}
      navLabel={t('nav.mainNavigation')}
      labels={{ openMenu: t('common.openMenu'), closeMenu: t('common.closeMenu') }}
      banner={banner}
      sidebarFooter={
        <div className="grid gap-0.5 text-small">
          <span dir="ltr" className="truncate text-nav-ink-active [unicode-bidi:plaintext]">
            {identity}
          </span>
          <span className="truncate text-caption text-nav-ink">{roleLabel}</span>
        </div>
      }
      topbar={
        <>
          <ClinicSwitcher
            current={{ slug: ws.clinic.slug, name: ws.clinic.displayName }}
            clinics={ws.memberships.map((m) => ({ slug: m.slug, name: m.displayName }))}
            statusLabel={ws.clinic.city}
          />
          <div className="ms-auto flex items-center gap-1">
            <time className="hidden px-2 text-small text-ink-muted md:block" dateTime={new Date().toISOString()}>
              {formatLongDate(locale, new Date(), ws.clinic.timezone)}
            </time>
            <LocaleSwitcher />
            <AccountMenu identity={identity} roleLabel={roleLabel} />
          </div>
        </>
      }
    >
      {children}
    </AppShell>
  );
}
