import 'server-only';

import { z } from 'zod';

import { toErrorCode } from '@/shared/lib/errors';
import type { Loaded } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

import { parseLimits, READ_ONLY_REASONS, SUBSCRIPTION_STATUSES, type Limits, type ReadOnlyReason, type SubscriptionStatus } from './domain';

/*
 * The clinic's own subscription (subscription.view: owner, admin, accountant). Plans and limits
 * come from definer functions; the plan tables themselves are not readable by clinics.
 */

export interface MySubscription {
  planCode: string;
  planNameFr: string;
  planNameAr: string;
  monthlyPriceMad: string;
  status: SubscriptionStatus;
  startedAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  trialEndsAt: string | null;
  limits: Limits;
  usage: Limits;
  readOnlyReason: ReadOnlyReason | null;
  openRequestPlanCode: string | null;
  openRequestAt: string | null;
}

export interface AvailablePlan {
  code: string;
  nameFr: string;
  nameAr: string;
  monthlyPriceMad: string;
  limits: Limits;
}

const money = z.union([z.string(), z.number()]).transform((v) => Number(v).toFixed(2));

function failed<T>(error: unknown): Loaded<T> {
  const code = toErrorCode(error);
  return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
}

export async function loadMySubscription(clinicId: string): Promise<Loaded<MySubscription | null>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const { data, error } = await supabase.rpc('get_my_subscription', { p_clinic_id: clinicId });
  if (error) return failed(error);
  const parsed = z.array(z.object({
    plan_code: z.string(),
    plan_name_fr: z.string(),
    plan_name_ar: z.string(),
    monthly_price_mad: money,
    status: z.enum(SUBSCRIPTION_STATUSES),
    started_at: z.string(),
    current_period_start: z.string().nullable(),
    current_period_end: z.string().nullable(),
    trial_ends_at: z.string().nullable(),
    limits: z.unknown(),
    usage: z.unknown(),
    read_only_reason: z.enum(READ_ONLY_REASONS).nullable(),
    open_request_plan_code: z.string().nullable(),
    open_request_at: z.string().nullable(),
  })).safeParse(data);
  if (!parsed.success) return { status: 'error', code: 'INTERNAL' };
  const r = parsed.data[0];
  if (!r) return { status: 'ok', data: null };
  return {
    status: 'ok',
    data: {
      planCode: r.plan_code,
      planNameFr: r.plan_name_fr,
      planNameAr: r.plan_name_ar,
      monthlyPriceMad: r.monthly_price_mad,
      status: r.status,
      startedAt: r.started_at,
      periodStart: r.current_period_start,
      periodEnd: r.current_period_end,
      trialEndsAt: r.trial_ends_at,
      limits: parseLimits(r.limits),
      usage: parseLimits(r.usage),
      readOnlyReason: r.read_only_reason,
      openRequestPlanCode: r.open_request_plan_code,
      openRequestAt: r.open_request_at,
    },
  };
}

export async function loadAvailablePlans(clinicId: string): Promise<Loaded<AvailablePlan[]>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const { data, error } = await supabase.rpc('list_available_plans', { p_clinic_id: clinicId });
  if (error) return failed(error);
  const parsed = z.array(z.object({ code: z.string(), name_fr: z.string(), name_ar: z.string(), monthly_price_mad: money, limits: z.unknown() })).safeParse(data);
  if (!parsed.success) return { status: 'error', code: 'INTERNAL' };
  return {
    status: 'ok',
    data: parsed.data.map((p) => ({ code: p.code, nameFr: p.name_fr, nameAr: p.name_ar, monthlyPriceMad: p.monthly_price_mad, limits: parseLimits(p.limits) })),
  };
}
