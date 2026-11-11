import 'server-only';

import { z } from 'zod';

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
