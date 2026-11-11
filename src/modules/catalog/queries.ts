import 'server-only';

import { z } from 'zod';

import { toErrorCode } from '@/shared/lib/errors';
import type { Loaded } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

export interface Doctor {
  id: string;
  fullName: string;
  fullNameAr: string | null;
  userId: string | null;
  specialtyId: string | null;
  inpe: string | null;
  phone: string | null;
  onlineBookable: boolean;
  active: boolean;
}

export interface Service {
  id: string;
  nameFr: string | null;
  nameAr: string | null;
  specialtyId: string | null;
  durationMinutes: number;
  priceMad: string;
  onlineBookable: boolean;
  active: boolean;
}

export interface DoctorService {
  doctorId: string;
  serviceId: string;
  durationMinutes: number | null;
  priceMad: string | null;
  onlineBookable: boolean;
  active: boolean;
}

export interface Catalog {
  doctors: Doctor[];
  services: Service[];
  offerings: DoctorService[];
}

export interface Specialty {
  id: string;
  code: string;
  nameFr: string;
  nameAr: string;
}

const money = z.union([z.string(), z.number()]).transform(String);

const doctorRow = z.object({
  id: z.uuid(),
  full_name: z.string(),
  full_name_ar: z.string().nullable(),
  user_id: z.uuid().nullable(),
  specialty_id: z.uuid().nullable(),
  inpe: z.string().nullable(),
  phone_e164: z.string().nullable(),
  online_bookable: z.boolean(),
  status: z.enum(['active', 'inactive']),
});
const serviceRow = z.object({
  id: z.uuid(),
  name_fr: z.string().nullable(),
  name_ar: z.string().nullable(),
  specialty_id: z.uuid().nullable(),
  default_duration_minutes: z.number().int(),
  price_mad: money,
  online_bookable: z.boolean(),
  status: z.enum(['active', 'archived']),
});
const offeringRow = z.object({
  doctor_id: z.uuid(),
  service_id: z.uuid(),
  duration_minutes: z.number().int().nullable(),
  price_mad: money.nullable(),
  online_bookable: z.boolean(),
  is_active: z.boolean(),
});

/** Doctors, services and who offers what, for one clinic (RLS-scoped). */
export async function loadCatalog(clinicId: string): Promise<Loaded<Catalog>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const [doctors, services, offerings] = await Promise.all([
    supabase
      .from('doctors')
      .select('id, full_name, full_name_ar, user_id, specialty_id, inpe, phone_e164, online_bookable, status')
      .eq('clinic_id', clinicId)
      .order('full_name'),
    supabase
      .from('services')
      .select('id, name_fr, name_ar, specialty_id, default_duration_minutes, price_mad, online_bookable, status')
      .eq('clinic_id', clinicId)
      .order('name_fr'),
    supabase
      .from('doctor_services')
      .select('doctor_id, service_id, duration_minutes, price_mad, online_bookable, is_active')
      .eq('clinic_id', clinicId),
  ]);
  const failed = doctors.error ?? services.error ?? offerings.error;
  if (failed) {
    const code = toErrorCode(failed);
    return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
  }
  const d = z.array(doctorRow).safeParse(doctors.data);
  const s = z.array(serviceRow).safeParse(services.data);
  const o = z.array(offeringRow).safeParse(offerings.data);
  if (!d.success || !s.success || !o.success) return { status: 'error', code: 'INTERNAL' };

  return {
    status: 'ok',
    data: {
      doctors: d.data.map((r) => ({
        id: r.id,
        fullName: r.full_name,
        fullNameAr: r.full_name_ar,
        userId: r.user_id,
        specialtyId: r.specialty_id,
        inpe: r.inpe,
        phone: r.phone_e164,
        onlineBookable: r.online_bookable,
        active: r.status === 'active',
      })),
      services: s.data.map((r) => ({
        id: r.id,
        nameFr: r.name_fr,
        nameAr: r.name_ar,
        specialtyId: r.specialty_id,
        durationMinutes: r.default_duration_minutes,
        priceMad: r.price_mad,
        onlineBookable: r.online_bookable,
        active: r.status === 'active',
      })),
      offerings: o.data.map((r) => ({
        doctorId: r.doctor_id,
        serviceId: r.service_id,
        durationMinutes: r.duration_minutes,
        priceMad: r.price_mad,
        onlineBookable: r.online_bookable,
        active: r.is_active,
      })),
    },
  };
}

/** Platform reference list of specialties (readable by every role). */
export async function loadSpecialties(): Promise<Loaded<Specialty[]>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const { data, error } = await supabase.from('specialties').select('id, code, name_fr, name_ar').eq('is_active', true).order('name_fr');
  if (error) {
    const code = toErrorCode(error);
    return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
  }
  const parsed = z.array(z.object({ id: z.uuid(), code: z.string(), name_fr: z.string(), name_ar: z.string() })).safeParse(data);
  if (!parsed.success) return { status: 'error', code: 'INTERNAL' };
  return { status: 'ok', data: parsed.data.map((r) => ({ id: r.id, code: r.code, nameFr: r.name_fr, nameAr: r.name_ar })) };
}
