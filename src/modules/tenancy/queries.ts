import 'server-only';

import { z } from 'zod';

import { toErrorCode } from '@/shared/lib/errors';
import type { Loaded } from '@/shared/lib/result';
import { getSupabase, type SupabaseServerClient } from '@/shared/lib/supabase/server';

import { CLINIC_ROLES, MEMBER_STATUSES, type ClinicRole, type MemberStatus } from './roles';

async function run<T>(load: (supabase: SupabaseServerClient) => Promise<{ data: unknown; error: unknown }>, schema: z.ZodType<T>): Promise<Loaded<T>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const { data, error } = await load(supabase);
  if (error) {
    const code = toErrorCode(error);
    return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
  }
  const parsed = schema.safeParse(data);
  return parsed.success ? { status: 'ok', data: parsed.data } : { status: 'error', code: 'INTERNAL' };
}

export interface Member {
  memberId: string;
  userId: string;
  fullName: string;
  email: string;
  role: ClinicRole;
  status: MemberStatus;
  joinedAt: string;
  isPractitioner: boolean;
  isSelf: boolean;
}

export function loadMembers(clinicId: string): Promise<Loaded<Member[]>> {
  return run(
    (s) => Promise.resolve(s.rpc('list_clinic_members', { p_clinic_id: clinicId })),
    z
      .array(
        z.object({
          member_id: z.uuid(),
          user_id: z.uuid(),
          full_name: z.string(),
          email: z.string(),
          role: z.enum(CLINIC_ROLES),
          status: z.enum(MEMBER_STATUSES),
          joined_at: z.string(),
          is_practitioner: z.boolean(),
          is_self: z.boolean(),
        }),
      )
      .transform((rows) =>
        rows.map((r) => ({
          memberId: r.member_id,
          userId: r.user_id,
          fullName: r.full_name,
          email: r.email,
          role: r.role,
          status: r.status,
          joinedAt: r.joined_at,
          isPractitioner: r.is_practitioner,
          isSelf: r.is_self,
        })),
      ),
  );
}

export interface Invitation {
  id: string;
  email: string;
  role: ClinicRole;
  expiresAt: string;
  createdAt: string;
}

/** Open invitations (not accepted, not revoked, not expired). token_hash is never selected. */
export function loadOpenInvitations(clinicId: string): Promise<Loaded<Invitation[]>> {
  return run(
    (s) =>
      Promise.resolve(
        s
          .from('clinic_invitations')
          .select('id, email, role, expires_at, created_at')
          .eq('clinic_id', clinicId)
          .is('accepted_at', null)
          .is('revoked_at', null)
          .gt('expires_at', new Date().toISOString())
          .order('created_at', { ascending: false }),
      ),
    z
      .array(z.object({ id: z.uuid(), email: z.string(), role: z.enum(CLINIC_ROLES), expires_at: z.string(), created_at: z.string() }))
      .transform((rows) => rows.map((r) => ({ id: r.id, email: r.email, role: r.role, expiresAt: r.expires_at, createdAt: r.created_at }))),
  );
}

export interface ClinicProfile {
  displayName: string;
  legalName: string | null;
  city: string;
  addressLine: string | null;
  phone: string | null;
  email: string | null;
  ice: string | null;
  defaultLocale: 'fr' | 'ar';
}

export function loadClinicProfile(clinicId: string): Promise<Loaded<ClinicProfile | null>> {
  return run(
    (s) => Promise.resolve(s.from('clinics').select('display_name, legal_name, city, address_line, phone_e164, email, ice, default_locale').eq('id', clinicId).maybeSingle()),
    z
      .object({
        display_name: z.string(),
        legal_name: z.string().nullable(),
        city: z.string(),
        address_line: z.string().nullable(),
        phone_e164: z.string().nullable(),
        email: z.string().nullable(),
        ice: z.string().nullable(),
        default_locale: z.enum(['fr', 'ar']),
      })
      .nullable()
      .transform((r) =>
        r
          ? {
              displayName: r.display_name,
              legalName: r.legal_name,
              city: r.city,
              addressLine: r.address_line,
              phone: r.phone_e164,
              email: r.email,
              ice: r.ice,
              defaultLocale: r.default_locale,
            }
          : null,
      ),
  );
}

export interface BookingPolicy {
  onlineBookingEnabled: boolean;
  autoConfirmOnline: boolean;
  listedInDirectory: boolean;
  minLeadMinutes: number;
  maxHorizonDays: number;
  patientCancelCutoffHours: number;
  maxActiveOnlineBookings: number;
  reminderHoursBefore: number;
  checkinGraceMinutes: number;
  turnApproachingPositions: number;
  smsSenderName: string | null;
}

export function loadBookingPolicy(clinicId: string): Promise<Loaded<BookingPolicy | null>> {
  return run(
    (s) =>
      Promise.resolve(
        s
          .from('clinic_settings')
          .select(
            'online_booking_enabled, auto_confirm_online, listed_in_directory, min_lead_minutes, max_horizon_days, patient_cancel_cutoff_hours, ' +
              'max_active_online_bookings, reminder_offsets_minutes, checkin_grace_minutes, turn_approaching_positions, sms_sender_name',
          )
          .eq('clinic_id', clinicId)
          .maybeSingle(),
      ),
    z
      .object({
        online_booking_enabled: z.boolean(),
        auto_confirm_online: z.boolean(),
        listed_in_directory: z.boolean(),
        min_lead_minutes: z.number().int(),
        max_horizon_days: z.number().int(),
        patient_cancel_cutoff_hours: z.number().int(),
        max_active_online_bookings: z.number().int(),
        reminder_offsets_minutes: z.array(z.number().int()),
        checkin_grace_minutes: z.number().int(),
        turn_approaching_positions: z.number().int(),
        sms_sender_name: z.string().nullable(),
      })
      .nullable()
      .transform((r) =>
        r
          ? {
              onlineBookingEnabled: r.online_booking_enabled,
              autoConfirmOnline: r.auto_confirm_online,
              listedInDirectory: r.listed_in_directory,
              minLeadMinutes: r.min_lead_minutes,
              maxHorizonDays: r.max_horizon_days,
              patientCancelCutoffHours: r.patient_cancel_cutoff_hours,
              maxActiveOnlineBookings: r.max_active_online_bookings,
              reminderHoursBefore: Math.round((r.reminder_offsets_minutes[0] ?? 1440) / 60),
              checkinGraceMinutes: r.checkin_grace_minutes,
              turnApproachingPositions: r.turn_approaching_positions,
              smsSenderName: r.sms_sender_name,
            }
          : null,
      ),
  );
}

export interface Closure {
  id: string;
  from: string;
  to: string;
  reason: string;
}

/** Upcoming and recent closures. `dates` is a daterange; PostgREST returns "[2027-01-11,2027-01-12)". */
export function loadClosures(clinicId: string): Promise<Loaded<Closure[]>> {
  return run(
    (s) => Promise.resolve(s.from('clinic_closures').select('id, dates, reason').eq('clinic_id', clinicId).order('dates', { ascending: true })),
    z.array(z.object({ id: z.uuid(), dates: z.string(), reason: z.string() })).transform((rows) =>
      rows.map((r) => {
        const [lower, upperExclusive] = parseDateRange(r.dates);
        return { id: r.id, from: lower, to: upperExclusive ? previousDay(upperExclusive) : lower, reason: r.reason };
      }),
    ),
  );
}

/** "[2027-01-11,2027-01-13)" → ["2027-01-11", "2027-01-13"] (canonical daterange: inclusive lower, exclusive upper). */
export function parseDateRange(value: string): [string, string] {
  const match = /^\[(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})\)$/.exec(value);
  return match ? [match[1] ?? '', match[2] ?? ''] : ['', ''];
}

function previousDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export interface DpaStatus {
  version: string;
  acceptedAt: string | null;
}

export function loadDpaStatus(clinicId: string): Promise<Loaded<DpaStatus | null>> {
  return run(
    (s) => Promise.resolve(s.rpc('get_clinic_dpa_status', { p_clinic_id: clinicId })),
    z
      .array(z.object({ document_version: z.string(), accepted_at: z.string().nullable() }))
      .transform((rows) => (rows[0] ? { version: rows[0].document_version, acceptedAt: rows[0].accepted_at } : null)),
  );
}
