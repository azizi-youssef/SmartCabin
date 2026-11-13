import 'server-only';

import { unstable_cache } from 'next/cache';
import { z } from 'zod';

import { toErrorCode } from '@/shared/lib/errors';
import type { Loaded } from '@/shared/lib/result';
import { getPublicSupabase } from '@/shared/lib/supabase/public';

import type { DirectoryDoctor } from './domain';

const row = z.object({
  doctor_id: z.uuid(),
  doctor_name: z.string(),
  doctor_name_ar: z.string().nullable(),
  specialty_code: z.string().nullable(),
  specialty_name_fr: z.string().nullable(),
  specialty_name_ar: z.string().nullable(),
  clinic_slug: z.string(),
  clinic_name: z.string(),
  clinic_city: z.string(),
  clinic_address: z.string().nullable(),
  clinic_timezone: z.string(),
  min_price_mad: z.union([z.number(), z.string()]).nullable().transform((v) => (v === null ? null : Number(v).toFixed(2))),
  next_slot_at: z.string().nullable(),
});

class DirectoryReadError extends Error {
  constructor(readonly outcome: Loaded<never>) {
    super('directory read failed');
  }
}

/*
 * The directory is the same for every visitor, so one read serves everyone for 60 seconds:
 * computing next slots for every listed doctor on each anonymous request would let anyone
 * load the database. Failures are not cached (the function throws). The booking page always
 * re-reads the real slots, so a slot shown here may at most be a minute old.
 */
const readDirectory = unstable_cache(
  async (): Promise<DirectoryDoctor[]> => {
    const supabase = getPublicSupabase();
    if (!supabase) throw new DirectoryReadError({ status: 'unavailable' });
    const { data, error } = await supabase.rpc('public_list_directory_doctors');
    if (error) {
      const code = toErrorCode(error);
      throw new DirectoryReadError(code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code });
    }
    const parsed = z.array(row).safeParse(data);
    if (!parsed.success) throw new DirectoryReadError({ status: 'error', code: 'INTERNAL' });
    return parsed.data.map((r) => ({
      id: r.doctor_id,
      name: r.doctor_name,
      nameAr: r.doctor_name_ar,
      specialtyCode: r.specialty_code,
      specialtyFr: r.specialty_name_fr,
      specialtyAr: r.specialty_name_ar,
      clinicSlug: r.clinic_slug,
      clinicName: r.clinic_name,
      clinicCity: r.clinic_city,
      clinicAddress: r.clinic_address,
      clinicTimezone: r.clinic_timezone,
      minPriceMad: r.min_price_mad,
      nextSlotAt: r.next_slot_at,
    }));
  },
  ['public-directory-v1'],
  { revalidate: 60 },
);

/** Doctors listed in the public directory (BR-P-04), from a cache refreshed every minute. */
export async function loadDirectory(): Promise<Loaded<DirectoryDoctor[]>> {
  try {
    return { status: 'ok', data: await readDirectory() };
  } catch (e) {
    if (e instanceof DirectoryReadError) return e.outcome;
    return { status: 'unavailable' };
  }
}
