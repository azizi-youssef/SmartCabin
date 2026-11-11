import 'server-only';

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { publicEnv } from '@/shared/lib/env';

/**
 * User-scoped Supabase client for Server Components and Server Actions.
 * It carries the caller's session cookie, so every query runs under RLS as that user.
 * Returns null when the backend is not configured.
 */
export async function getSupabase() {
  const env = publicEnv();
  if (!env) return null;
  const store = await cookies();
  return createServerClient(env.url, env.key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Server Components cannot write cookies; the proxy refreshes the session instead.
        }
      },
    },
  });
}

export type SupabaseServerClient = NonNullable<Awaited<ReturnType<typeof getSupabase>>>;
