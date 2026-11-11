import { getLocale, getTranslations } from 'next-intl/server';

import { redirect } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { NewPasswordForm } from '@/modules/identity/ui/account-forms';
import { getSessionState } from '@/shared/lib/auth/session';
import { UnavailableState } from '@/shared/ui/states';

import { AuthFrame } from '../../_components/portal-frame';

export async function generateMetadata() {
  const t = await getTranslations('password');
  return { title: t('resetTitle') };
}

/** Reached from the recovery email link, which opened a session through /auth/callback. */
export default async function ResetPasswordPage() {
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const session = await getSessionState();
  if (session.status === 'anonymous') redirect({ href: '/forgot-password', locale });

  return (
    <AuthFrame>
      <div className="grid gap-5">
        <h1 className="text-title text-ink">{t('password.resetTitle')}</h1>
        {session.status === 'unavailable' ? (
          <UnavailableState className="px-0 py-0" title={t('states.unavailableTitle')} description={t('auth.notConfigured')} />
        ) : (
          <NewPasswordForm />
        )}
      </div>
    </AuthFrame>
  );
}
