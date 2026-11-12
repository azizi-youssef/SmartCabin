import { getTranslations } from 'next-intl/server';

import { DisplayBoard } from '@/modules/reception/ui/display-board';

export async function generateMetadata() {
  const t = await getTranslations('display');
  return { title: t('title'), robots: { index: false, follow: false } };
}

/** Public waiting-room screen. The screen token travels in the URL fragment (#token). */
export default function DisplayPage() {
  return (
    <main id="main" tabIndex={-1}>
      <DisplayBoard />
    </main>
  );
}
