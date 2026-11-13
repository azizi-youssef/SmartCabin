import { connection } from 'next/server';
import type { ReactNode } from 'react';

/**
 * Every page lives under /[locale], whose layout renders <html lang dir>.
 * This root layout only passes children through (next-intl App Router pattern).
 * Every page renders per request: the Content-Security-Policy nonce (SC-AUD-05) changes with each
 * response, and a page prerendered at build time could not carry it.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  return children;
}
