import { getLocale } from 'next-intl/server';

import { redirect } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { homePath } from '@/modules/identity/home';
import { loadMemberships } from '@/modules/tenancy/workspace';

import { ServiceUnavailablePage } from './_components/service-unavailable';

/** Entry point: routes the caller to the right workspace (navigation only; the database authorizes). */
export default async function Home() {
  const locale = (await getLocale()) as Locale;
  const result = await loadMemberships();
  if (result.status === 'unavailable' || result.status === 'error') return <ServiceUnavailablePage />;
  if (result.status === 'anonymous') redirect({ href: '/sign-in', locale });
  if (result.status !== 'ok') return null;
  redirect({
    href: homePath({
      aal: result.session.aal,
      memberships: result.memberships,
      isPlatformAdmin: result.isPlatformAdmin,
      hasEmail: Boolean(result.session.email),
    }),
    locale,
  });
}
