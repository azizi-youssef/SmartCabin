import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';

import { UnavailableState } from '@/shared/ui/states';

import { Brand } from './brand';

/** Full-page state when the backend is not configured or unreachable. Never shows sample data. */
export async function ServiceUnavailablePage() {
  const t = await getTranslations('states');
  const requestId = (await headers()).get('x-request-id');
  return (
    <main id="main" className="grid min-h-dvh place-items-center bg-canvas p-4">
      <div className="grid w-full max-w-lg gap-4">
        <Brand />
        <div className="rounded-lg border border-line bg-surface">
          <UnavailableState title={t('unavailableTitle')} description={t('unavailableBody')} />
          {requestId ? (
            <p className="border-t border-line px-4 py-2 text-center text-caption text-ink-subtle">{t('reference', { ref: requestId })}</p>
          ) : null}
        </div>
      </div>
    </main>
  );
}
