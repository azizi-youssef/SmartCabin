import { getTranslations } from 'next-intl/server';

import { UnavailableState } from '@/shared/ui/states';

import { Brand } from './brand';

/** Full-page state when the backend is not configured or unreachable. Never shows sample data. */
export async function ServiceUnavailablePage() {
  const t = await getTranslations('states');
  return (
    <main id="main" className="grid min-h-dvh place-items-center bg-canvas p-4">
      <div className="grid w-full max-w-lg gap-4">
        <Brand />
        <div className="rounded-lg border border-line bg-surface">
          <UnavailableState title={t('unavailableTitle')} description={t('unavailableBody')} />
        </div>
      </div>
    </main>
  );
}
