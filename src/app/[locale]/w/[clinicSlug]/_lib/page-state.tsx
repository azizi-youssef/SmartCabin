import { getTranslations } from 'next-intl/server';

import type { ErrorCode } from '@/shared/lib/errors';
import { ErrorState, UnavailableState } from '@/shared/ui/states';

/** Renders the non-ok outcome of a data load inside a page region. */
export async function LoadFailure({ outcome }: { outcome: { status: 'unavailable' } | { status: 'error'; code: ErrorCode } }) {
  const t = await getTranslations();
  return (
    <div className="rounded-lg border border-line bg-surface">
      {outcome.status === 'unavailable' ? (
        <UnavailableState title={t('states.unavailableTitle')} description={t('states.unavailableBody')} />
      ) : outcome.code === 'FORBIDDEN' ? (
        <ErrorState title={t('states.forbiddenTitle')} description={t('states.forbiddenBody')} />
      ) : (
        <ErrorState title={t('states.errorTitle')} description={t(`errors.${outcome.code}`)} />
      )}
    </div>
  );
}
