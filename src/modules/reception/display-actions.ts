'use server';

import { z } from 'zod';

import { isLocale } from '@/i18n/routing';
import { loadWorkspace } from '@/modules/tenancy/workspace';
import { toErrorCode } from '@/shared/lib/errors';
import type { ActionResult } from '@/shared/lib/result';
import { siteUrl } from '@/shared/lib/site';
import { getSupabase } from '@/shared/lib/supabase/server';

/*
 * Waiting-room screens (module 8b), queue.displays.manage (owner, admin). The link is returned
 * ONCE: only the token's SHA-256 is stored, and the token sits in the URL fragment so it is never
 * sent to a server in a URL.
 */

export async function createDisplayScreen(input: {
  clinicSlug: string;
  locale: string;
  name: string;
  doctorIds: string[] | null;
}): Promise<ActionResult<{ link: string }>> {
  const parsed = z.object({
    clinicSlug: z.string().min(1),
    locale: z.string(),
    name: z.string().trim().min(2).max(60),
    doctorIds: z.array(z.uuid()).min(1).max(20).nullable(),
  }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const workspace = await loadWorkspace(parsed.data.clinicSlug);
  const supabase = await getSupabase();
  if (workspace.status !== 'ok' || !supabase) return { ok: false, code: workspace.status === 'unavailable' || !supabase ? 'UNAVAILABLE' : 'FORBIDDEN' };
  const { data, error } = await supabase.rpc('create_display_screen', {
    p_clinic_id: workspace.workspace.clinic.id,
    p_name: parsed.data.name,
    p_doctor_ids: parsed.data.doctorIds,
  });
  if (error) return { ok: false, code: toErrorCode(error) };
  const row = z.array(z.object({ display_token: z.string().regex(/^[0-9a-f]{64}$/) })).safeParse(data);
  const token = row.success ? row.data[0]?.display_token : undefined;
  if (!token) return { ok: false, code: 'INTERNAL' };
  const locale = isLocale(parsed.data.locale) ? parsed.data.locale : 'fr';
  return { ok: true, data: { link: `${siteUrl()}/${locale}/display#${token}` } };
}

export async function revokeDisplayScreen(screenId: string): Promise<ActionResult> {
  if (!z.uuid().safeParse(screenId).success) return { ok: false, code: 'VALIDATION_FAILED' };
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { error } = await supabase.rpc('revoke_display_screen', { p_screen_id: screenId });
  return error ? { ok: false, code: toErrorCode(error) } : { ok: true, data: undefined };
}
