import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';

import type { ErrorCode } from '@/shared/lib/errors';
import { ErrorState, UnavailableState } from '@/shared/ui/states';

/** Renders the non-ok outcome of a data load inside a page region. */
export async function LoadFailure({ outcome }: { outcome: { status: 'unavailable' } | { status: 'error'; code: ErrorCode } }) {
  const t = await getTranslations();
  const requestId = (await headers()).get('x-request-id');
  const unexpected = outcome.status === 'unavailable' || outcome.code === 'INTERNAL' || outcome.code === 'UNAVAILABLE';
  return (
    <div className="rounded-lg border border-line bg-surface">
      {outcome.status === 'unavailable' ? (
        <UnavailableState title={t('states.unavailableTitle')} description={t('states.unavailableBody')} />
      ) : outcome.code === 'FORBIDDEN' ? (
        <ErrorState title={t('states.forbiddenTitle')} description={t('states.forbiddenBody')} />
      ) : (
        <ErrorState title={t('states.errorTitle')} description={t(`errors.${outcome.code}`)} />
      )}
      {unexpected && requestId ? (
        <p className="border-t border-line px-4 py-2 text-center text-caption text-ink-subtle">
          {t('states.reference', { ref: requestId })}
        </p>
      ) : null}
    </div>
  );
}
