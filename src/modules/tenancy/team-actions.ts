'use server';

import { z } from 'zod';

import { redirect } from '@/i18n/navigation';
import { isLocale } from '@/i18n/routing';
import { toErrorCode } from '@/shared/lib/errors';
import type { ActionResult } from '@/shared/lib/result';
import { siteUrl } from '@/shared/lib/site';
import { getSupabase } from '@/shared/lib/supabase/server';

import { CLINIC_ROLES, MEMBER_STATUSES } from './roles';
import { inviteSchema, type InviteInput } from './schemas';
import { loadWorkspace } from './workspace';

/*
 * Team commands. Each calls a guarded database function with the caller's session:
 * owner/admin limits, self-change and last-owner protection are decided by the database.
 */

async function rpc(name: string, args: Record<string, unknown>): Promise<ActionResult> {
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { error } = await supabase.rpc(name, args);
  return error ? { ok: false, code: toErrorCode(error) } : { ok: true, data: undefined };
}

/**
 * Creates an invitation and returns the acceptance link ONCE. Only the token's hash is stored,
 * so the link cannot be shown again; re-inviting issues a new one. Until email delivery exists
 * (notifications module), the inviter shares the link.
 */
export async function inviteMember(
  clinicSlug: string,
  locale: string,
  input: InviteInput,
): Promise<ActionResult<{ link: string; expiresAt: string }>> {
  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const workspace = await loadWorkspace(clinicSlug);
  if (workspace.status !== 'ok') return { ok: false, code: workspace.status === 'unavailable' ? 'UNAVAILABLE' : 'FORBIDDEN' };
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { data, error } = await supabase.rpc('invite_member', {
    p_clinic_id: workspace.workspace.clinic.id,
    p_email: parsed.data.email,
    p_role: parsed.data.role,
  });
  if (error) return { ok: false, code: toErrorCode(error) };
  const row = z.array(z.object({ invitation_token: z.string().regex(/^[0-9a-f]{64}$/), invitation_expires_at: z.string() })).safeParse(data);
  const first = row.success ? row.data[0] : undefined;
  if (!first) return { ok: false, code: 'INTERNAL' };
  const l = isLocale(locale) ? locale : 'fr';
  // The token travels in the URL fragment: it never reaches servers, proxies or logs.
  return { ok: true, data: { link: `${siteUrl()}/${l}/invite#${first.invitation_token}`, expiresAt: first.invitation_expires_at } };
}

export async function revokeInvitation(invitationId: string): Promise<ActionResult> {
  const id = z.uuid().safeParse(invitationId);
  if (!id.success) return { ok: false, code: 'VALIDATION_FAILED' };
  return rpc('revoke_invitation', { p_invitation_id: id.data });
}

export async function changeMemberRole(memberId: string, role: string): Promise<ActionResult> {
  const parsed = z.object({ memberId: z.uuid(), role: z.enum(CLINIC_ROLES) }).safeParse({ memberId, role });
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  return rpc('change_member_role', { p_member_id: parsed.data.memberId, p_role: parsed.data.role });
}

export async function setMemberStatus(memberId: string, status: string): Promise<ActionResult> {
  const parsed = z.object({ memberId: z.uuid(), status: z.enum(MEMBER_STATUSES) }).safeParse({ memberId, status });
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  return rpc('set_member_status', { p_member_id: parsed.data.memberId, p_status: parsed.data.status });
}

/** Accepts an invitation for the signed-in account (email must match), then opens the workspace. */
export async function acceptInvitation(locale: string, token: string): Promise<ActionResult> {
  const parsed = z.string().regex(/^[0-9a-f]{64}$/).safeParse(token);
  if (!parsed.success) return { ok: false, code: 'INVITATION_INVALID' };
  const result = await rpc('accept_invitation', { p_token: parsed.data });
  if (!result.ok) return result;
  redirect({ href: '/', locale: isLocale(locale) ? locale : 'fr' });
  return result;
}
