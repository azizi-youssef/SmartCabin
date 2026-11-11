import { getLocale, getTranslations } from 'next-intl/server';
import { z } from 'zod';

import { redirect } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { OnboardingForm } from '@/modules/tenancy/ui/onboarding-form';
import { loadMemberships } from '@/modules/tenancy/workspace';
import { getSupabase } from '@/shared/lib/supabase/server';
import { ErrorState } from '@/shared/ui/states';

import { AuthFrame } from '../_components/portal-frame';
import { ServiceUnavailablePage } from '../_components/service-unavailable';

export async function generateMetadata() {
  const t = await getTranslations('onboarding');
  return { title: t('title') };
}

/**
 * First step after email confirmation: create the clinic. It starts "pending approval":
 * setup is possible right away, online booking opens after platform approval.
 */
export default async function OnboardingPage() {
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const memberships = await loadMemberships();
  if (memberships.status === 'anonymous') redirect({ href: '/sign-in', locale });
  if (memberships.status !== 'ok') return <ServiceUnavailablePage />;
  if (memberships.memberships.length > 0) redirect({ href: '/', locale });

  const supabase = await getSupabase();
  const docs = supabase
    ? await supabase.from('legal_documents').select('kind, version, locale').eq('is_current', true).in('kind', ['terms_of_service', 'privacy_policy'])
    : null;
  const parsed = z.array(z.object({ kind: z.string(), version: z.string(), locale: z.string() })).safeParse(docs?.data ?? []);
  const documents = parsed.success
    ? ['terms_of_service', 'privacy_policy']
        .map((kind) => parsed.data.find((d) => d.kind === kind && d.locale === locale) ?? parsed.data.find((d) => d.kind === kind))
        .filter((d): d is { kind: string; version: string; locale: string } => Boolean(d))
    : [];

  return (
    <AuthFrame>
      <div className="grid gap-5">
        <div className="grid gap-1">
          <p className="text-small text-ink-muted">{t('onboarding.step')}</p>
          <h1 className="text-title text-ink">{t('onboarding.title')}</h1>
          <p className="text-body text-ink-muted">{t('onboarding.subtitle')}</p>
        </div>
        {documents.length < 2 ? (
          <ErrorState className="px-0 py-0" title={t('onboarding.closedTitle')} description={t('onboarding.closedBody')} />
        ) : (
          <OnboardingForm documents={documents} />
        )}
        <p className="text-small text-ink-muted">{t('onboarding.inviteNote')}</p>
      </div>
    </AuthFrame>
  );
}
