import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { ForgotPasswordForm } from '@/modules/identity/ui/account-forms';
import { getSessionState } from '@/shared/lib/auth/session';
import { UnavailableState } from '@/shared/ui/states';

import { AuthFrame } from '../../_components/portal-frame';

export async function generateMetadata() {
  const t = await getTranslations('password');
  return { title: t('forgotTitle') };
}

export default async function ForgotPasswordPage() {
  const t = await getTranslations();
  const session = await getSessionState();
  return (
    <AuthFrame
      footer={
        <Link href="/sign-in" className="focus-ring rounded-sm text-accent hover:underline">
          {t('password.backToSignIn')}
        </Link>
      }
    >
      <div className="grid gap-5">
        <div className="grid gap-1">
          <h1 className="text-title text-ink">{t('password.forgotTitle')}</h1>
          <p className="text-body text-ink-muted">{t('password.forgotSubtitle')}</p>
        </div>
        {session.status === 'unavailable' ? (
          <UnavailableState className="px-0 py-0" title={t('states.unavailableTitle')} description={t('auth.notConfigured')} />
        ) : (
          <ForgotPasswordForm />
        )}
      </div>
    </AuthFrame>
  );
}
