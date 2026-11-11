import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { Button } from '@/shared/ui/button';
import { EmptyState } from '@/shared/ui/states';

export default async function NotFound() {
  const t = await getTranslations('states');
  return (
    <main id="main" className="grid min-h-dvh place-items-center bg-canvas p-4">
      <div className="w-full max-w-lg rounded-lg border border-line bg-surface">
        <EmptyState
          title={t('notFoundTitle')}
          description={t('notFoundBody')}
          action={
            <Button asChild variant="secondary">
              <Link href="/">{t('goHome')}</Link>
            </Button>
          }
        />
      </div>
    </main>
  );
}
