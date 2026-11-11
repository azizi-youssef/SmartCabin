import { getTranslations } from 'next-intl/server';

import { AcceptInvitation } from '@/modules/tenancy/ui/accept-invitation';
import { getSessionState } from '@/shared/lib/auth/session';
import { UnavailableState } from '@/shared/ui/states';

import { AuthFrame } from '../_components/portal-frame';

export async function generateMetadata() {
  const t = await getTranslations('invite');
  return { title: t('title') };
}

/** Invitation acceptance. The token is read client-side from the URL fragment. */
export default async function InvitePage() {
  const t = await getTranslations();
  const session = await getSessionState();
  return (
    <AuthFrame>
      <div className="grid gap-5">
        <div className="grid gap-1">
          <h1 className="text-title text-ink">{t('invite.title')}</h1>
          <p className="text-body text-ink-muted">{t('invite.subtitle')}</p>
        </div>
        {session.status === 'unavailable' ? (
          <UnavailableState className="px-0 py-0" title={t('states.unavailableTitle')} description={t('auth.notConfigured')} />
        ) : (
          <AcceptInvitation signedInAs={session.status === 'signed_in' ? (session.session.email ?? session.session.phone) : null} />
        )}
      </div>
    </AuthFrame>
  );
}
