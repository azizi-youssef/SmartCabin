import 'server-only';

import { z } from 'zod';

import { parseLimits, SUBSCRIPTION_STATUSES, type Limits, type SubscriptionStatus } from '@/modules/subscriptions/domain';
import { CLINIC_STATUSES, type ClinicStatus } from '@/modules/tenancy/workspace';
import { toErrorCode } from '@/shared/lib/errors';
import type { Loaded } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

export interface PlatformClinic {
  id: string;
  slug: string;
  displayName: string;
  city: string;
  status: ClinicStatus;
  createdAt: string;
  approvedAt: string | null;
  suspendedReason: string | null;
  activeMembers: number;
  activeDoctors: number;
}

const row = z.object({
  clinic_id: z.uuid(),
  slug: z.string(),
  display_name: z.string(),
  city: z.string(),
  status: z.enum(CLINIC_STATUSES),
  created_at: z.string(),
  approved_at: z.string().nullable(),
  suspended_reason: z.string().nullable(),
  active_members: z.number().int(),
  active_doctors: z.number().int(),
});

/** Clinic metadata for platform admins (guarded in the database; no patient-level data). */
export async function loadPlatformClinics(): Promise<Loaded<PlatformClinic[]>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const { data, error } = await supabase.rpc('platform_list_clinics');
  if (error) {
    const code = toErrorCode(error);
    return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
  }
  const parsed = z.array(row).safeParse(data);
  if (!parsed.success) return { status: 'error', code: 'INTERNAL' };
  return {
    status: 'ok',
    data: parsed.data.map((r) => ({
      id: r.clinic_id,
      slug: r.slug,
      displayName: r.display_name,
      city: r.city,
      status: r.status,
      createdAt: r.created_at,
      approvedAt: r.approved_at,
      suspendedReason: r.suspended_reason,
      activeMembers: r.active_members,
      activeDoctors: r.active_doctors,
    })),
  };
}

/** Allowed next statuses (mirrors platform_set_clinic_status; the database re-validates). */
export function nextClinicStatuses(status: ClinicStatus): ClinicStatus[] {
  switch (status) {
    case 'pending_approval':
      return ['active', 'closed'];
    case 'active':
      return ['suspended', 'closed'];
    case 'suspended':
      return ['active', 'closed'];
    case 'closed':
      return [];
  }
}

// ---------------------------------------------------------------------------
// Module 12: subscriptions, plans and per-clinic counts (platform admins with MFA only)
// ---------------------------------------------------------------------------

export interface ClinicOverview {
  clinicId: string;
  planCode: string | null;
  planNameFr: string | null;
  planNameAr: string | null;
  subscriptionStatus: SubscriptionStatus | null;
  periodEnd: string | null;
  trialEndsAt: string | null;
  openRequestPlanCode: string | null;
  appointments30d: number;
  completed30d: number;
  onlineBookings30d: number;
  smsThisMonth: number;
  activeMembers: number;
  activeDoctors: number;
  patientsTotal: number;
}

const overviewRow = z.object({
  clinic_id: z.uuid(),
  plan_code: z.string().nullable(),
  plan_name_fr: z.string().nullable(),
  plan_name_ar: z.string().nullable(),
  subscription_status: z.enum(SUBSCRIPTION_STATUSES).nullable(),
  current_period_end: z.string().nullable(),
  trial_ends_at: z.string().nullable(),
  open_request_plan_code: z.string().nullable(),
  appointments_30d: z.number().int(),
  completed_30d: z.number().int(),
  online_bookings_30d: z.number().int(),
  sms_this_month: z.number().int(),
  active_members: z.number().int(),
  active_doctors: z.number().int(),
  patients_total: z.number().int(),
});

/** Subscription and activity counts per clinic: aggregates only (RBAC §4). */
export async function loadPlatformOverview(): Promise<Loaded<Map<string, ClinicOverview>>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const { data, error } = await supabase.rpc('platform_kpi_overview');
  if (error) {
    const code = toErrorCode(error);
    return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
  }
  const parsed = z.array(overviewRow).safeParse(data);
  if (!parsed.success) return { status: 'error', code: 'INTERNAL' };
  return {
    status: 'ok',
    data: new Map(parsed.data.map((r) => [r.clinic_id, {
      clinicId: r.clinic_id,
      planCode: r.plan_code,
      planNameFr: r.plan_name_fr,
      planNameAr: r.plan_name_ar,
      subscriptionStatus: r.subscription_status,
      periodEnd: r.current_period_end,
      trialEndsAt: r.trial_ends_at,
      openRequestPlanCode: r.open_request_plan_code,
      appointments30d: r.appointments_30d,
      completed30d: r.completed_30d,
      onlineBookings30d: r.online_bookings_30d,
      smsThisMonth: r.sms_this_month,
      activeMembers: r.active_members,
      activeDoctors: r.active_doctors,
      patientsTotal: r.patients_total,
    }])),
  };
}

export interface PlatformPlan {
  id: string;
  code: string;
  nameFr: string;
  nameAr: string;
  monthlyPriceMad: string;
  graceDays: number;
  isPublic: boolean;
  isActive: boolean;
  limits: Limits;
  liveSubscriptions: number;
}

export async function loadPlatformPlans(): Promise<Loaded<PlatformPlan[]>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const { data, error } = await supabase.rpc('platform_list_plans');
  if (error) {
    const code = toErrorCode(error);
    return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
  }
  const parsed = z.array(z.object({
    plan_id: z.uuid(),
    code: z.string(),
    name_fr: z.string(),
    name_ar: z.string(),
    monthly_price_mad: z.union([z.string(), z.number()]).transform((v) => Number(v).toFixed(2)),
    grace_days: z.number().int(),
    is_public: z.boolean(),
    is_active: z.boolean(),
    limits: z.unknown(),
    live_subscriptions: z.number().int(),
  })).safeParse(data);
  if (!parsed.success) return { status: 'error', code: 'INTERNAL' };
  return {
    status: 'ok',
    data: parsed.data.map((p) => ({
      id: p.plan_id,
      code: p.code,
      nameFr: p.name_fr,
      nameAr: p.name_ar,
      monthlyPriceMad: p.monthly_price_mad,
      graceDays: p.grace_days,
      isPublic: p.is_public,
      isActive: p.is_active,
      limits: parseLimits(p.limits),
      liveSubscriptions: p.live_subscriptions,
    })),
  };
}
