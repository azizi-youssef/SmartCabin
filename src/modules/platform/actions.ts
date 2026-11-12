'use server';

import { z } from 'zod';

import { SUBSCRIPTION_STATUSES } from '@/modules/subscriptions/domain';
import { CLINIC_STATUSES } from '@/modules/tenancy/workspace';
import { toErrorCode } from '@/shared/lib/errors';
import type { ActionResult } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

const input = z
  .object({ clinicId: z.uuid(), status: z.enum(CLINIC_STATUSES), reason: z.string().trim().max(300).optional() })
  .refine((v) => v.status !== 'suspended' || (v.reason && v.reason.length >= 3), { path: ['reason'] });

/** Platform path: approve, suspend, reactivate or close a clinic (aal2 platform admin, checked in the database). */
export async function setClinicStatus(values: z.input<typeof input>): Promise<ActionResult> {
  const parsed = input.safeParse(values);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { error } = await supabase.rpc('platform_set_clinic_status', {
    p_clinic_id: parsed.data.clinicId,
    p_status: parsed.data.status,
    p_reason: parsed.data.reason || null,
  });
  return error ? { ok: false, code: toErrorCode(error) } : { ok: true, data: undefined };
}

const planCode = z.string().regex(/^[a-z][a-z0-9_]{1,29}$/);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const limit = z.number().int().min(0).max(1_000_000).nullable();

async function rpc(fn: string, args: Record<string, unknown>): Promise<ActionResult> {
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { error } = await supabase.rpc(fn, args);
  return error ? { ok: false, code: toErrorCode(error) } : { ok: true, data: undefined };
}

/** Creates (planId null) or updates a plan and its limits (null = unlimited). */
export async function savePlan(input: {
  planId: string | null;
  code: string;
  nameFr: string;
  nameAr: string;
  monthlyPriceMad: string;
  graceDays: number;
  isPublic: boolean;
  isActive: boolean;
  limits: { max_doctors: number | null; max_staff: number | null; monthly_sms_quota: number | null };
}): Promise<ActionResult> {
  const parsed = z.object({
    planId: z.uuid().nullable(),
    code: planCode,
    nameFr: z.string().trim().min(2).max(60),
    nameAr: z.string().trim().min(2).max(60),
    monthlyPriceMad: z.string().trim().regex(/^\d{1,7}(\.\d{1,2})?$/),
    graceDays: z.number().int().min(0).max(60),
    isPublic: z.boolean(),
    isActive: z.boolean(),
    limits: z.object({ max_doctors: limit, max_staff: limit, monthly_sms_quota: limit }),
  }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const d = parsed.data;
  return rpc('platform_save_plan', {
    p_plan_id: d.planId,
    p_code: d.code,
    p_name_fr: d.nameFr,
    p_name_ar: d.nameAr,
    p_monthly_price_mad: d.monthlyPriceMad,
    p_grace_days: d.graceDays,
    p_is_public: d.isPublic,
    p_is_active: d.isActive,
    p_limits: d.limits,
  });
}

/** Plan, status and period of a clinic's subscription; dates are the clinic's local dates. */
export async function setSubscription(input: {
  clinicId: string;
  planCode: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  trialEndsOn: string;
  notes: string;
}): Promise<ActionResult> {
  const parsed = z.object({
    clinicId: z.uuid(),
    planCode,
    status: z.enum(SUBSCRIPTION_STATUSES),
    periodStart: localDate.or(z.literal('')),
    periodEnd: localDate.or(z.literal('')),
    trialEndsOn: localDate.or(z.literal('')),
    notes: z.string().trim().max(500),
  }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const d = parsed.data;
  return rpc('platform_set_subscription', {
    p_clinic_id: d.clinicId,
    p_plan_code: d.planCode,
    p_status: d.status,
    p_period_start: d.periodStart || null,
    p_period_end: d.periodEnd || null,
    p_trial_ends_on: d.trialEndsOn || null,
    p_notes: d.notes || null,
  });
}

/** A payment received: the subscription is active until that local date (included). */
export async function markSubscriptionPaid(input: { clinicId: string; paidUntil: string; notes: string }): Promise<ActionResult> {
  const parsed = z.object({ clinicId: z.uuid(), paidUntil: localDate, notes: z.string().trim().max(500) }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  return rpc('platform_mark_subscription_paid', {
    p_clinic_id: parsed.data.clinicId,
    p_paid_until: parsed.data.paidUntil,
    p_notes: parsed.data.notes || null,
  });
}
