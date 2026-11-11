import type { ReactNode } from 'react';

/**
 * Every page lives under /[locale], whose layout renders <html lang dir>.
 * This root layout only passes children through (next-intl App Router pattern).
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
