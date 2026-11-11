'use server';

import { z } from 'zod';

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
