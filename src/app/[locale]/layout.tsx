import '@/styles/globals.css';

import type { Metadata } from 'next';
import { IBM_Plex_Sans, IBM_Plex_Sans_Arabic } from 'next/font/google';
import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import type { ReactNode } from 'react';

import { directionOf, routing } from '@/i18n/routing';

import { Providers } from './providers';

/* IBM Plex Sans and IBM Plex Sans Arabic are designed as one family: same proportions in both scripts. */
const plex = IBM_Plex_Sans({ subsets: ['latin', 'latin-ext'], weight: ['400', '500', '600'], variable: '--font-plex', display: 'swap' });
const plexArabic = IBM_Plex_Sans_Arabic({ subsets: ['arabic'], weight: ['400', '500', '600'], variable: '--font-plex-arabic', display: 'swap' });

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale: hasLocale(routing.locales, locale) ? locale : routing.defaultLocale, namespace: 'metadata' });
  return {
    title: { default: t('title'), template: `%s · ${t('title')}` },
    description: t('description'),
    robots: { index: false },
    icons: {
      icon: [
        { url: '/favicon.ico', sizes: 'any' },
        { url: '/icon.png', type: 'image/png', sizes: '192x192' },
      ],
      apple: [{ url: '/icon.png', sizes: '192x192' }],
    },
  };
}

export default async function LocaleLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const messages = await getMessages();
  const t = await getTranslations('common');
  const dir = directionOf(locale);

  return (
    <html lang={locale} dir={dir} className={`${plex.variable} ${plexArabic.variable}`}>
      <body>
        <a
          href="#main"
          className="focus-ring sr-only z-[70] rounded-md bg-surface px-3 py-2 text-body font-medium text-ink focus:not-sr-only focus:fixed focus:start-3 focus:top-3"
        >
          {t('skipToContent')}
        </a>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Providers dir={dir} closeLabel={t('close')}>
            {children}
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
