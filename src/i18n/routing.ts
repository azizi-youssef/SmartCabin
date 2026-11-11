import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  locales: ['fr', 'ar'],
  defaultLocale: 'fr',
  localePrefix: 'always',
  // The chosen language persists across visits (master spec §15).
  localeCookie: { name: 'SC_LOCALE', maxAge: 60 * 60 * 24 * 365 },
});

export type Locale = (typeof routing.locales)[number];

/** All clinics are in Morocco for the pilot; each clinic row still carries its own time zone. */
export const DEFAULT_TIME_ZONE = 'Africa/Casablanca';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (routing.locales as readonly string[]).includes(value);
}

export function directionOf(locale: Locale): 'ltr' | 'rtl' {
  return locale === 'ar' ? 'rtl' : 'ltr';
}
