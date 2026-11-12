import 'server-only';

import { z } from 'zod';

import { toErrorCode } from '@/shared/lib/errors';
import type { Loaded } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

import type { Offering } from './booking-domain';

/*
 * The clinic's public booking page (S7). public_get_clinic_profile is callable without an
 * account and returns the clinic's public profile and online offer only.
 */

export interface PublicClinic {
  id: string;
  slug: string;
  displayName: string;
  city: string;
  addressLine: string | null;
  phone: string | null;
  timezone: string;
  defaultLocale: 'fr' | 'ar';
  onlineBookingOpen: boolean;
  autoConfirm: boolean;
  minLeadMinutes: number;
  maxHorizonDays: number;
  cancelCutoffHours: number;
  offerings: Offering[];
}

const offering = z.object({
  doctor_id: z.uuid(),
  doctor_name: z.string(),
  doctor_name_ar: z.string().nullable(),
  service_id: z.uuid(),
  service_name_fr: z.string(),
  service_name_ar: z.string().nullable(),
  duration_minutes: z.number().int(),
  price_mad: z.union([z.number(), z.string()]).transform((v) => Number(v).toFixed(2)),
});

const profile = z.array(z.object({
  clinic_id: z.uuid(),
  slug: z.string(),
  display_name: z.string(),
  city: z.string(),
  address_line: z.string().nullable(),
  phone_e164: z.string().nullable(),
  timezone: z.string(),
  default_locale: z.enum(['fr', 'ar']),
  online_booking_open: z.boolean(),
  auto_confirm_online: z.boolean(),
  min_lead_minutes: z.number().int(),
  max_horizon_days: z.number().int(),
  patient_cancel_cutoff_hours: z.number().int(),
  offerings: z.array(offering),
}));

export async function loadPublicClinic(slug: string): Promise<Loaded<PublicClinic>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const { data, error } = await supabase.rpc('public_get_clinic_profile', { p_slug: slug });
  if (error) {
    const code = toErrorCode(error);
    return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
  }
  const parsed = profile.safeParse(data);
  if (!parsed.success) return { status: 'error', code: 'INTERNAL' };
  const c = parsed.data[0];
  if (!c) return { status: 'error', code: 'NOT_FOUND' };
  return {
    status: 'ok',
    data: {
      id: c.clinic_id,
      slug: c.slug,
      displayName: c.display_name,
      city: c.city,
      addressLine: c.address_line,
      phone: c.phone_e164,
      timezone: c.timezone,
      defaultLocale: c.default_locale,
      onlineBookingOpen: c.online_booking_open,
      autoConfirm: c.auto_confirm_online,
      minLeadMinutes: c.min_lead_minutes,
      maxHorizonDays: c.max_horizon_days,
      cancelCutoffHours: c.patient_cancel_cutoff_hours,
      offerings: c.offerings.map((o) => ({
        doctorId: o.doctor_id,
        doctorName: o.doctor_name,
        doctorNameAr: o.doctor_name_ar,
        serviceId: o.service_id,
        serviceNameFr: o.service_name_fr,
        serviceNameAr: o.service_name_ar,
        durationMinutes: o.duration_minutes,
        priceMad: o.price_mad,
      })),
    },
  };
}
