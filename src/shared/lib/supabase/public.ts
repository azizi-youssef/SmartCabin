import 'server-only';

import { createClient } from '@supabase/supabase-js';

import { publicEnv } from '@/shared/lib/env';
// Registers the server's reporter for unexpected errors (SC-AUD-04) wherever Supabase is used.
import '@/shared/lib/report-error';

/**
 * Anonymous client without any session or cookie, for public reads whose result is the same
 * for every visitor and may therefore be cached server-side (the doctor directory). Never use it
 * for anything that depends on who is asking. Returns null when the backend is not configured.
 */
export function getPublicSupabase() {
  const env = publicEnv();
  if (!env) return null;
  return createClient(env.url, env.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
