import { getLocale, getTranslations } from 'next-intl/server';

import { Link, redirect } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { SignUpForm } from '@/modules/identity/ui/account-forms';
import { getSessionState } from '@/shared/lib/auth/session';
import { UnavailableState } from '@/shared/ui/states';

import { AuthFrame } from '../../_components/portal-frame';

export async function generateMetadata() {
  const t = await getTranslations('signUp');
  return { title: t('title') };
}

export default async function SignUpPage() {
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const session = await getSessionState();
  if (session.status === 'signed_in') redirect({ href: '/', locale });

  return (
    <AuthFrame
      footer={
        <Link href="/sign-in" className="focus-ring rounded-sm text-accent hover:underline">
          {t('signUp.haveAccount')}
        </Link>
      }
    >
      <div className="grid gap-5">
        <div className="grid gap-1">
          <h1 className="text-title text-ink">{t('signUp.title')}</h1>
          <p className="text-body text-ink-muted">{t('signUp.subtitle')}</p>
        </div>
        {session.status === 'unavailable' ? (
          <UnavailableState className="px-0 py-0" title={t('states.unavailableTitle')} description={t('auth.notConfigured')} />
        ) : (
          <SignUpForm />
        )}
      </div>
    </AuthFrame>
  );
}
