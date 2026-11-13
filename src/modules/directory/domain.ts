import type { Locale } from '@/i18n/routing';
import { localizedName } from '@/modules/catalog/names';

/*
 * Public doctor directory (/medecins, BR-P-04): pure helpers shared by the page and its tests.
 * The database decides who is listed; these only group and order what it returns.
 */

export interface DirectoryDoctor {
  id: string;
  name: string;
  nameAr: string | null;
  /** Specialty code, or null when the clinic gave none. */
  specialtyCode: string | null;
  specialtyFr: string | null;
  specialtyAr: string | null;
  clinicSlug: string;
  clinicName: string;
  clinicCity: string;
  clinicAddress: string | null;
  clinicTimezone: string;
  /** Lowest online price (decimal string, MAD). */
  minPriceMad: string | null;
  /** Next free online slot in the next 14 days, or null. */
  nextSlotAt: string | null;
}

export interface SpecialtyGroup {
  /** Specialty code, or null for doctors without a specialty. */
  code: string | null;
  label: string;
  doctors: DirectoryDoctor[];
}

/**
 * Doctors grouped by specialty, groups in the reader's alphabetical order with "no specialty"
 * last; inside a group, the soonest available first, then by name.
 */
export function groupBySpecialty(doctors: readonly DirectoryDoctor[], locale: Locale, otherLabel: string): SpecialtyGroup[] {
  const groups = new Map<string, SpecialtyGroup>();
  for (const d of doctors) {
    const key = d.specialtyCode ?? '';
    const group = groups.get(key) ?? {
      code: d.specialtyCode,
      label: d.specialtyCode ? localizedName(locale, d.specialtyFr, d.specialtyAr) : otherLabel,
      doctors: [],
    };
    group.doctors.push(d);
    groups.set(key, group);
  }
  const collator = new Intl.Collator(locale === 'ar' ? 'ar' : 'fr', { sensitivity: 'base' });
  const name = (d: DirectoryDoctor) => (locale === 'ar' && d.nameAr ? d.nameAr : d.name);
  for (const g of groups.values()) {
    g.doctors.sort((a, b) => {
      if (a.nextSlotAt !== b.nextSlotAt) {
        if (a.nextSlotAt === null) return 1;
        if (b.nextSlotAt === null) return -1;
        return a.nextSlotAt < b.nextSlotAt ? -1 : 1;
      }
      return collator.compare(name(a), name(b));
    });
  }
  return [...groups.values()].sort((a, b) => {
    if (a.code === null) return 1;
    if (b.code === null) return -1;
    return collator.compare(a.label, b.label);
  });
}

/** The specialty filter from the URL, kept only when it names a listed specialty ("" = none). */
export function specialtyFilter(value: string | string[] | undefined, groups: readonly SpecialtyGroup[]): string | null {
  const code = Array.isArray(value) ? value[0] : value;
  if (!code) return null;
  if (code === 'autres') return groups.some((g) => g.code === null) ? 'autres' : null;
  return groups.some((g) => g.code === code) ? code : null;
}

/** "today", "tomorrow" or null, for the clinic's local calendar. */
export function relativeDay(slotDay: string, today: string, tomorrow: string): 'today' | 'tomorrow' | null {
  if (slotDay === today) return 'today';
  if (slotDay === tomorrow) return 'tomorrow';
  return null;
}
