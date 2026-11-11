import { createServerClient } from '@supabase/ssr';
import createIntlMiddleware from 'next-intl/middleware';
import type { NextRequest } from 'next/server';

import { routing } from './i18n/routing';
import { publicEnv } from './shared/lib/env';

const intl = createIntlMiddleware(routing);

/**
 * Runs on every page request:
 * 1. locale routing (/fr, /ar, persisted language cookie);
 * 2. Supabase session refresh, so Server Components always see a fresh, verified session.
 * Authorization is NOT decided here: pages, Server Actions and PostgreSQL do that.
 */
export async function proxy(request: NextRequest) {
  const response = intl(request);
  const env = publicEnv();
  if (!env) return response;

  const supabase = createServerClient(env.url, env.key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value, options } of list) {
          request.cookies.set(name, value);
          response.cookies.set(name, value, options);
        }
      },
    },
  });
  try {
    await supabase.auth.getClaims();
  } catch {
    // Backend unreachable: pages render their "service unavailable" state.
  }
  return response;
}

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
