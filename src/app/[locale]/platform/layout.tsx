import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { redirect } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { loadMemberships } from '@/modules/tenancy/workspace';
import { AppShell } from '@/shared/ui/app-shell';
import { ErrorState } from '@/shared/ui/states';

import { Brand } from '../_components/brand';
import { ServiceUnavailablePage } from '../_components/service-unavailable';
import { AccountMenu, LocaleSwitcher } from '../_components/topbar';

/**
 * Platform administration shell: platform admins with an MFA session only. Every page below
 * calls platform_* functions, which check the same thing again in the database.
 */
export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const memberships = await loadMemberships();
  if (memberships.status === 'anonymous') redirect({ href: '/sign-in', locale });
  if (memberships.status !== 'ok') return <ServiceUnavailablePage />;
  if (memberships.isPlatformAdmin && memberships.session.aal !== 'aal2') redirect({ href: '/mfa', locale });
  const identity = memberships.session.email ?? '';

  return (
    <AppShell
      brand={<Brand inverse />}
      navLabel={t('nav.mainNavigation')}
      labels={{ openMenu: t('common.openMenu'), closeMenu: t('common.closeMenu') }}
      groups={[
        {
          label: t('nav.platform'),
          items: [
            { href: '/platform', label: t('nav.clinics'), icon: 'clinics', exact: true },
            { href: '/platform/plans', label: t('nav.plans'), icon: 'plans' },
          ],
        },
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
      {memberships.isPlatformAdmin ? children : (
        <div className="rounded-lg border border-line bg-surface">
          <ErrorState title={t('states.forbiddenTitle')} description={t('platform.forbidden')} />
        </div>
      )}
    </AppShell>
  );
}
