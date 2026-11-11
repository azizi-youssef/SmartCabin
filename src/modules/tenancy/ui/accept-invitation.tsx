'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, useSyncExternalStore, useTransition } from 'react';

import { Link } from '@/i18n/navigation';
import type { ErrorCode } from '@/shared/lib/errors';
import { Button } from '@/shared/ui/button';
import { ErrorState, InlineAlert } from '@/shared/ui/states';

import { acceptInvitation } from '../team-actions';

/** The token lives in the URL fragment (#…): never sent to servers, logs or Referer headers. */
function useFragmentToken(): string | null {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener('hashchange', onChange);
      return () => window.removeEventListener('hashchange', onChange);
    },
    () => {
      const value = window.location.hash.slice(1);
      return /^[0-9a-f]{64}$/.test(value) ? value : null;
    },
    () => null,
  );
}

export function AcceptInvitation({ signedInAs }: { signedInAs: string | null }) {
  const t = useTranslations();
  const locale = useLocale();
  const token = useFragmentToken();
  const [error, setError] = useState<ErrorCode | null>(null);
  const [pending, startTransition] = useTransition();

  if (!token) return <ErrorState className="px-0 py-0" title={t('errors.INVITATION_INVALID')} description={t('invite.missingToken')} />;

  if (!signedInAs) {
    return (
      <div className="grid gap-4">
        <p className="text-body text-ink-muted">{t('invite.signInFirst')}</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="primary">
            <Link href="/sign-in">{t('auth.submit')}</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/sign-up">{t('signUp.submit')}</Link>
          </Button>
        </div>
        <p className="text-small text-ink-muted">{t('invite.reopen')}</p>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <p className="text-body text-ink-muted">
        {t('invite.signedInAs')} <span dir="ltr" className="font-medium text-ink">{signedInAs}</span>
      </p>
      {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
      <Button
        variant="primary"
        size="lg"
        loading={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await acceptInvitation(locale, token);
            if (!result.ok) setError(result.code);
            else window.history.replaceState(null, '', window.location.pathname);
          })
        }
      >
        {t('invite.accept')}
      </Button>
    </div>
  );
}
