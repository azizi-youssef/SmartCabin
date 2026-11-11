import type { Locale } from '@/i18n/routing';

/**
 * Locale-aware formatting for Morocco. Moroccan usage is Western digits (0-9) in both
 * French and Arabic (decision A16), while generic "ar" locales default to Eastern Arabic digits.
 * Always format through these helpers.
 */
const INTL_LOCALE: Record<Locale, string> = {
  fr: 'fr-MA-u-nu-latn',
  ar: 'ar-MA-u-nu-latn',
};

export function intlLocale(locale: Locale): string {
  return INTL_LOCALE[locale];
}

export function formatNumber(locale: Locale, value: number): string {
  return new Intl.NumberFormat(intlLocale(locale), { numberingSystem: 'latn' }).format(value);
}

export function formatPercent(locale: Locale, ratio: number): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: 'percent',
    maximumFractionDigits: 0,
    numberingSystem: 'latn',
  }).format(ratio);
}

/** Amounts arrive from the database as decimal strings ("350.00"); never floats in storage. */
export function formatMoney(locale: Locale, amount: string | number): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: 'currency',
    currency: 'MAD',
    numberingSystem: 'latn',
  }).format(Number(amount));
}

/** 24-hour clock, the convention in Moroccan clinics. */
export function formatTime(locale: Locale, date: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
    numberingSystem: 'latn',
  }).format(new Date(date));
}

export function formatLongDate(locale: Locale, date: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone,
    numberingSystem: 'latn',
  }).format(new Date(date));
}

export function formatShortDate(locale: Locale, date: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone,
    numberingSystem: 'latn',
  }).format(new Date(date));
}

export function formatDateTime(locale: Locale, date: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
    numberingSystem: 'latn',
  }).format(new Date(date));
}

/** Formats a local calendar day ("2026-11-23") without time-zone drift. */
export function formatLocalDay(locale: Locale, day: string, style: 'long' | 'short' = 'long'): string {
  const [y, m, d] = day.split('-').map(Number);
  const noonUtc = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12));
  return style === 'long' ? formatLongDate(locale, noonUtc, 'UTC') : formatShortDate(locale, noonUtc, 'UTC');
}

/** "Amina H." style: enough to identify at the desk, minimal on shared screens. */
export function personName(first: string, last: string): string {
  return `${first} ${last}`.trim();
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
  return letters.map((p) => (p ?? '').charAt(0).toUpperCase()).join('');
}
