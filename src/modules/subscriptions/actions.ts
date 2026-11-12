'use server';

import { z } from 'zod';

import { toErrorCode } from '@/shared/lib/errors';
import type { ActionResult } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

/** Owner: asks the platform for a plan (applied manually during the pilot). */
export async function requestPlanChange(input: { clinicId: string; planCode: string; note: string }): Promise<ActionResult> {
  const parsed = z.object({ clinicId: z.uuid(), planCode: z.string().regex(/^[a-z][a-z0-9_]{1,29}$/), note: z.string().trim().max(500) }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { error } = await supabase.rpc('request_plan_change', {
    p_clinic_id: parsed.data.clinicId,
    p_plan_code: parsed.data.planCode,
    p_note: parsed.data.note || null,
  });
  return error ? { ok: false, code: toErrorCode(error) } : { ok: true, data: undefined };
}
