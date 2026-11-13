import { createServerClient } from '@supabase/ssr';
import createIntlMiddleware from 'next-intl/middleware';
import { NextRequest } from 'next/server';

import { routing } from './i18n/routing';
import { publicEnv } from './shared/lib/env';
import { buildCsp, createNonce, requestIdFrom } from './shared/lib/security-headers';
import { sessionCookieOptions } from './shared/lib/supabase/cookie-options';

const intl = createIntlMiddleware(routing);

/**
 * Runs on every page request:
 * 1. a request id (logs and error screens, SC-AUD-04) and a Content-Security-Policy with a fresh
 *    nonce (SC-AUD-05), both passed to the rendering through the request headers;
 * 2. locale routing (/fr, /ar, persisted language cookie);
 * 3. Supabase session refresh, so Server Components always see a fresh, verified session, with
 *    HttpOnly cookies (SC-AUD-06).
 * Authorization is NOT decided here: pages, Server Actions and PostgreSQL do that.
 */
export async function proxy(request: NextRequest) {
  const env = publicEnv();
  const nonce = createNonce();
  const requestId = requestIdFrom(request.headers.get('x-request-id'));
  const csp = buildCsp({ nonce, supabaseUrl: env?.url ?? null, development: process.env.NODE_ENV === 'development' });

  // Next.js reads the nonce from the request's CSP header; next-intl forwards these headers.
  const headers = new Headers(request.headers);
  headers.set('content-security-policy', csp);
  headers.set('x-nonce', nonce);
  headers.set('x-request-id', requestId);
  const response = intl(new NextRequest(request.url, { headers, method: request.method }));
  response.headers.set('content-security-policy', csp);
  response.headers.set('x-request-id', requestId);
  if (!env) return response;

  const supabase = createServerClient(env.url, env.key, {
    cookieOptions: sessionCookieOptions(),
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
