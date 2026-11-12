/*
 * Online booking (S7) helpers shared by the server and the booking page. The database decides
 * every rule again (BR-B-01…11); these only shape the choices offered.
 */

export interface Offering {
  doctorId: string;
  doctorName: string;
  doctorNameAr: string | null;
  serviceId: string;
  serviceNameFr: string;
  serviceNameAr: string | null;
  durationMinutes: number;
  priceMad: string;
}

export const RELATIONSHIPS = ['self', 'child', 'other_dependent'] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

/** Distinct services, in the order the clinic lists them. */
export function servicesOf(offerings: readonly Offering[]): Offering[] {
  const seen = new Set<string>();
  return offerings.filter((o) => (seen.has(o.serviceId) ? false : (seen.add(o.serviceId), true)));
}

export function doctorsFor(offerings: readonly Offering[], serviceId: string): Offering[] {
  return offerings.filter((o) => o.serviceId === serviceId);
}

/** A day plus n days, on local dates (YYYY-MM-DD). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Slots grouped by their local date in the clinic's time zone, in order. */
export function slotsByDay(slots: readonly string[], timeZone: string): Array<{ day: string; slots: string[] }> {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const days = new Map<string, string[]>();
  for (const s of [...slots].sort()) {
    const day = fmt.format(new Date(s));
    days.set(day, [...(days.get(day) ?? []), s]);
  }
  return [...days.entries()].map(([day, list]) => ({ day, slots: list }));
}

export interface NewPersonInput {
  firstName: string;
  lastName: string;
  relationship: Relationship;
  dateOfBirth: string;
  dataProcessing: boolean;
  remindersSms: boolean;
}

/** Field errors for a new person, or none. Consent to data processing is required (BR-D). */
export function newPersonErrors(p: NewPersonInput, today: string): Partial<Record<keyof NewPersonInput, 'required' | 'invalid'>> {
  const errors: Partial<Record<keyof NewPersonInput, 'required' | 'invalid'>> = {};
  if (!p.firstName.trim()) errors.firstName = 'required';
  else if (p.firstName.trim().length > 80) errors.firstName = 'invalid';
  if (!p.lastName.trim()) errors.lastName = 'required';
  else if (p.lastName.trim().length > 80) errors.lastName = 'invalid';
  if (p.dateOfBirth && (!/^\d{4}-\d{2}-\d{2}$/.test(p.dateOfBirth) || p.dateOfBirth > today || p.dateOfBirth < '1900-01-01')) {
    errors.dateOfBirth = 'invalid';
  }
  if (!p.dataProcessing) errors.dataProcessing = 'required';
  return errors;
}
