import { getLocale, getTranslations } from 'next-intl/server';

import { Link, redirect } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { PhoneSignInForm } from '@/modules/identity/ui/auth-forms';
import { getSessionState } from '@/shared/lib/auth/session';
import { UnavailableState } from '@/shared/ui/states';

import { AuthFrame } from '../../../_components/portal-frame';

export async function generateMetadata() {
  const t = await getTranslations('auth');
  return { title: t('patientTitle') };
}

export default async function PatientSignInPage() {
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const session = await getSessionState();
  if (session.status === 'signed_in') redirect({ href: '/me', locale });

  return (
    <AuthFrame
      footer={
        <Link href="/sign-in" className="focus-ring rounded-sm text-accent hover:underline">
          {t('auth.staffLink')}
        </Link>
      }
    >
      <div className="grid gap-5">
        <div className="grid gap-1">
          <h1 className="text-title text-ink">{t('auth.patientTitle')}</h1>
          <p className="text-body text-ink-muted">{t('auth.patientSubtitle')}</p>
        </div>
        {session.status === 'unavailable' ? (
          <UnavailableState className="px-0 py-0" title={t('states.unavailableTitle')} description={t('auth.notConfigured')} />
        ) : (
          <PhoneSignInForm />
        )}
      </div>
    </AuthFrame>
  );
}
