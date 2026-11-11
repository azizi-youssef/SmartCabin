import type { Locale } from '@/i18n/routing';

/** Bilingual clinic-entered names (MD-24): the locale's name, falling back to the other one. */
export function localizedName(locale: Locale, fr: string | null | undefined, ar: string | null | undefined): string {
  const preferred = locale === 'ar' ? ar : fr;
  const fallback = locale === 'ar' ? fr : ar;
  return (preferred && preferred.trim()) || (fallback && fallback.trim()) || '—';
}

export function doctorDisplayName(locale: Locale, fullName: string, fullNameAr: string | null): string {
  return locale === 'ar' && fullNameAr ? fullNameAr : fullName;
}
