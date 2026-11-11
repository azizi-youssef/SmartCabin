'use server';

import { z } from 'zod';

import { redirect } from '@/i18n/navigation';
import { isLocale } from '@/i18n/routing';
import { createClinicSchema, type CreateClinicInput } from '@/modules/identity/schemas';
import { toErrorCode } from '@/shared/lib/errors';
import { normalizePhone } from '@/shared/lib/phone';
import type { ActionResult } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

/** Live availability check for the onboarding form (the database re-checks on creation). */
export async function checkSlug(slug: string): Promise<ActionResult<{ available: boolean }>> {
  const parsed = z.string().trim().min(1).max(60).safeParse(slug);
  if (!parsed.success) return { ok: true, data: { available: false } };
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { data, error } = await supabase.rpc('is_slug_available', { p_slug: parsed.data });
  if (error) return { ok: false, code: toErrorCode(error) };
  return { ok: true, data: { available: data === true } };
}

/**
 * Onboarding: records acceptance of the current terms of service and privacy policy, then
 * creates the clinic (pending approval) with the caller as owner. The database refuses the
 * creation if the acceptances are missing. Next stop: MFA enrollment (owners need aal2).
 */
export async function createClinic(locale: string, input: CreateClinicInput): Promise<ActionResult> {
  const parsed = createClinicSchema.safeParse(input);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[String(issue.path[0])] = issue.message;
    return { ok: false, code: 'VALIDATION_FAILED', fields };
  }
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const l = isLocale(locale) ? locale : 'fr';

  const documents = await supabase
    .from('legal_documents')
    .select('id, kind, locale')
    .eq('is_current', true)
    .in('kind', ['terms_of_service', 'privacy_policy']);
  if (documents.error) return { ok: false, code: toErrorCode(documents.error) };
  const rows = z.array(z.object({ id: z.uuid(), kind: z.string(), locale: z.string() })).safeParse(documents.data);
  if (!rows.success) return { ok: false, code: 'INTERNAL' };
  // The version the user read: their language when published, otherwise any current version.
  const chosen = ['terms_of_service', 'privacy_policy'].map(
    (kind) => rows.data.find((d) => d.kind === kind && d.locale === l) ?? rows.data.find((d) => d.kind === kind),
  );
  if (chosen.some((d) => !d)) return { ok: false, code: 'LEGAL_ACCEPTANCE_REQUIRED' };

  const accepted = await supabase
    .from('legal_acceptances')
    .upsert(
      chosen.map((d) => ({ document_id: d?.id, context: 'clinic_creation' })),
      { onConflict: 'document_id,user_id,clinic_id', ignoreDuplicates: true },
    );
  if (accepted.error) return { ok: false, code: toErrorCode(accepted.error) };

  const v = parsed.data;
  const { error } = await supabase.rpc('create_clinic', {
    p_display_name: v.displayName,
    p_slug: v.slug,
    p_city: v.city,
    p_phone_e164: v.phone ? normalizePhone(v.phone) : null,
    p_default_locale: v.defaultLocale,
  });
  if (error) {
    const code = toErrorCode(error);
    return code === 'SLUG_TAKEN' ? { ok: false, code, fields: { slug: 'slugTaken' } } : { ok: false, code };
  }
  redirect({ href: '/mfa', locale: l });
  return { ok: true, data: undefined };
}
