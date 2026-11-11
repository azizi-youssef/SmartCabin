import { getLocale, getTranslations } from 'next-intl/server';

import { Link, redirect } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { SignInForm } from '@/modules/identity/ui/auth-forms';
import { getSessionState } from '@/shared/lib/auth/session';
import { InlineAlert, UnavailableState } from '@/shared/ui/states';

import { AuthFrame } from '../../_components/portal-frame';

export async function generateMetadata() {
  const t = await getTranslations('auth');
  return { title: t('signInTitle') };
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ link?: string }> }) {
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const { link } = await searchParams;
  const session = await getSessionState();
  if (session.status === 'signed_in') redirect({ href: '/', locale });

  return (
    <AuthFrame
      footer={
        <div className="grid gap-2">
          <Link href="/sign-up" className="focus-ring rounded-sm text-accent hover:underline">
            {t('signUp.cta')}
          </Link>
          <Link href="/patient/sign-in" className="focus-ring rounded-sm text-ink-muted hover:text-ink hover:underline">
            {t('auth.patientLink')}
          </Link>
        </div>
      }
    >
      <div className="grid gap-5">
        <div className="grid gap-1">
          <h1 className="text-title text-ink">{t('auth.signInTitle')}</h1>
          <p className="text-body text-ink-muted">{t('auth.signInSubtitle')}</p>
        </div>
        {link === 'invalid' ? <InlineAlert tone="warning">{t('auth.linkInvalid')}</InlineAlert> : null}
        {session.status === 'unavailable' ? (
          <UnavailableState className="px-0 py-0" title={t('states.unavailableTitle')} description={t('auth.notConfigured')} />
        ) : (
          <>
            <SignInForm />
            <Link href="/forgot-password" className="focus-ring justify-self-start rounded-sm text-small text-accent hover:underline">
              {t('password.forgotLink')}
            </Link>
          </>
        )}
      </div>
    </AuthFrame>
  );
}
