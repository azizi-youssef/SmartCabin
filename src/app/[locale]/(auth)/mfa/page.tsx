import { getLocale, getTranslations } from 'next-intl/server';

import { redirect } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { MfaForm } from '@/modules/identity/ui/auth-forms';
import { getSessionState } from '@/shared/lib/auth/session';
import { getSupabase } from '@/shared/lib/supabase/server';
import { UnavailableState } from '@/shared/ui/states';

import { AuthFrame } from '../../_components/portal-frame';

export async function generateMetadata() {
  const t = await getTranslations('auth');
  return { title: t('mfaTitle') };
}

export default async function MfaPage() {
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const session = await getSessionState();
  if (session.status === 'anonymous') redirect({ href: '/sign-in', locale });
  if (session.status === 'signed_in' && session.session.aal === 'aal2') redirect({ href: '/', locale });

  let verifiedFactorId: string | null = null;
  const supabase = await getSupabase();
  if (session.status === 'signed_in' && supabase) {
    const factors = await supabase.auth.mfa.listFactors();
    verifiedFactorId = factors.data?.totp.find((f) => f.status === 'verified')?.id ?? null;
  }

  return (
    <AuthFrame>
      <div className="grid gap-5">
        <h1 className="text-title text-ink">{t('auth.mfaTitle')}</h1>
        {session.status === 'unavailable' ? (
          <UnavailableState className="px-0 py-0" title={t('states.unavailableTitle')} description={t('auth.notConfigured')} />
        ) : (
          <MfaForm verifiedFactorId={verifiedFactorId} />
        )}
      </div>
    </AuthFrame>
  );
}
