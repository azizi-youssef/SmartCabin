'use server';

import { z } from 'zod';

import { can, loadWorkspace } from '@/modules/tenancy/workspace';
import { publicEnv } from '@/shared/lib/env';
import type { ActionResult } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';
import { today } from '@/shared/lib/time';

/*
 * Realtime access for queue screens (module 8b). The browser subscribes to private topics
 * (SECURITY_MODEL §5) with the user's own short-lived access token; the refresh token stays in
 * the server-side cookie. Topic authorization is decided by the policy on realtime.messages.
 */

export interface RealtimeAccess {
  url: string;
  key: string;
  accessToken: string;
  topics: string[];
  /** Seconds until the access token expires (the client asks again before that). */
  expiresIn: number;
}

export async function getRealtimeAccess(input: { clinicSlug: string; doctorIds?: string[] }): Promise<ActionResult<RealtimeAccess>> {
  const parsed = z.object({ clinicSlug: z.string().min(1), doctorIds: z.array(z.uuid()).max(20).optional() }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const env = publicEnv();
  const workspace = await loadWorkspace(parsed.data.clinicSlug);
  const supabase = await getSupabase();
  if (!env || !supabase || workspace.status === 'unavailable') return { ok: false, code: 'UNAVAILABLE' };
  if (workspace.status !== 'ok' || !can(workspace.workspace, 'queue.view')) return { ok: false, code: 'FORBIDDEN' };
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (!session) return { ok: false, code: 'UNAUTHENTICATED' };

  const clinic = workspace.workspace.clinic;
  const day = today(clinic.timezone);
  const topics = parsed.data.doctorIds?.length
    ? parsed.data.doctorIds.map((doctorId) => `clinic:${clinic.id}:doctor:${doctorId}:${day}`)
    : [`clinic:${clinic.id}:board:${day}`];
  const expiresIn = Math.max(60, (session.expires_at ?? 0) - Math.floor(Date.now() / 1000));
  return { ok: true, data: { url: env.url, key: env.key, accessToken: session.access_token, topics, expiresIn } };
}
