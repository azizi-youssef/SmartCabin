import 'server-only';

import { cache } from 'react';
import { z } from 'zod';

import { getSessionState, type Session } from '@/shared/lib/auth/session';
import { toErrorCode, type ErrorCode } from '@/shared/lib/errors';
import { getSupabase } from '@/shared/lib/supabase/server';

import { CLINIC_ROLES, type ClinicRole } from './roles';

export { CLINIC_ROLES, type ClinicRole };
export const CLINIC_STATUSES = ['pending_approval', 'active', 'suspended', 'closed'] as const;
export type ClinicStatus = (typeof CLINIC_STATUSES)[number];

const membershipSchema = z.object({
  clinic_id: z.uuid(),
  slug: z.string(),
  display_name: z.string(),
  clinic_status: z.enum(CLINIC_STATUSES),
  role: z.enum(CLINIC_ROLES),
  is_practitioner: z.boolean(),
  requires_mfa: z.boolean(),
});

export interface Membership {
  clinicId: string;
  slug: string;
  displayName: string;
  clinicStatus: ClinicStatus;
  role: ClinicRole;
  isPractitioner: boolean;
  requiresMfa: boolean;
}

export interface Workspace {
  session: Session;
  clinic: { id: string; slug: string; displayName: string; city: string; timezone: string; status: ClinicStatus };
  role: ClinicRole;
  isPractitioner: boolean;
  /** Effective permissions now (MFA, clinic status, subscription), from get_my_clinic_access. */
  permissions: ReadonlySet<string>;
  /** Why writes are refused right now, if they are (BR-P-01 for an expired subscription). */
  readOnlyReason: 'suspended' | 'closed' | 'subscription_expired' | null;
  memberships: Membership[];
}

export type WorkspaceResult =
  | { status: 'ok'; workspace: Workspace }
  | { status: 'unavailable' }
  | { status: 'anonymous' }
  | { status: 'mfa_required' }
  | { status: 'not_found' }
  | { status: 'error'; code: ErrorCode };

export type MembershipsResult =
  | { status: 'ok'; session: Session; memberships: Membership[]; isPlatformAdmin: boolean }
  | { status: 'unavailable' }
  | { status: 'anonymous' }
  | { status: 'error'; code: ErrorCode };

/** The caller's active memberships (works before MFA so the app can prompt for it). */
export const loadMemberships = cache(async (): Promise<MembershipsResult> => {
  const state = await getSessionState();
  if (state.status !== 'signed_in') return state;
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };

  const [memberships, admin] = await Promise.all([
    supabase.rpc('get_my_memberships'),
    supabase.from('platform_admins').select('user_id, revoked_at').eq('user_id', state.session.userId).maybeSingle(),
  ]);
  if (memberships.error) {
    const code = toErrorCode(memberships.error);
    return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
  }
  const parsed = z.array(membershipSchema).safeParse(memberships.data);
  if (!parsed.success) return { status: 'error', code: 'INTERNAL' };
  const adminRow = z.object({ revoked_at: z.string().nullable() }).nullable().safeParse(admin.data);

  return {
    status: 'ok',
    session: state.session,
    isPlatformAdmin: adminRow.success && adminRow.data !== null && adminRow.data.revoked_at === null,
    memberships: parsed.data.map((m) => ({
      clinicId: m.clinic_id,
      slug: m.slug,
      displayName: m.display_name,
      clinicStatus: m.clinic_status,
      role: m.role,
      isPractitioner: m.is_practitioner,
      requiresMfa: m.requires_mfa,
    })),
  };
});

const clinicSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  display_name: z.string(),
  city: z.string(),
  timezone: z.string(),
  status: z.enum(CLINIC_STATUSES),
});

/**
 * Resolves the clinic named in the URL for the signed-in caller. The clinic id is derived
 * from the caller's own memberships — never taken from the client. RLS and the database
 * commands remain the authority; this only shapes navigation and early errors.
 */
export const loadWorkspace = cache(async (slug: string): Promise<WorkspaceResult> => {
  const result = await loadMemberships();
  if (result.status !== 'ok') return result;
  const membership = result.memberships.find((m) => m.slug === slug);
  if (!membership) return { status: 'not_found' };
  if (membership.requiresMfa && result.session.aal !== 'aal2') return { status: 'mfa_required' };

  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const [clinic, permissions] = await Promise.all([
    supabase.from('clinics').select('id, slug, display_name, city, timezone, status').eq('id', membership.clinicId).maybeSingle(),
    supabase.rpc('get_my_clinic_access', { p_clinic_id: membership.clinicId }),
  ]);
  if (clinic.error || permissions.error) {
    const code = toErrorCode(clinic.error ?? permissions.error);
    return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
  }
  const row = clinicSchema.nullable().safeParse(clinic.data);
  if (!row.success) return { status: 'error', code: 'INTERNAL' };
  if (!row.data) return { status: 'not_found' };
  const access = z.array(z.object({
    permissions: z.array(z.string()),
    read_only_reason: z.enum(['suspended', 'closed', 'subscription_expired']).nullable(),
  })).safeParse(permissions.data);
  const effective = access.success ? access.data[0] : undefined;

  return {
    status: 'ok',
    workspace: {
      session: result.session,
      clinic: {
        id: row.data.id,
        slug: row.data.slug,
        displayName: row.data.display_name,
        city: row.data.city,
        timezone: row.data.timezone,
        status: row.data.status,
      },
      role: membership.role,
      isPractitioner: membership.isPractitioner,
      permissions: new Set(effective?.permissions ?? []),
      readOnlyReason: effective?.read_only_reason ?? null,
      memberships: result.memberships,
    },
  };
});

/** UI convenience only — the database enforces every permission again. */
export function can(workspace: Workspace, permission: string): boolean {
  return workspace.permissions.has(permission);
}
