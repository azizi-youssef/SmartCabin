import type { CookieOptionsWithName } from '@supabase/ssr';

/**
 * Session cookies (audit SC-AUD-06): HttpOnly, so no page script can read the tokens, even
 * after an XSS. Nothing in the browser needs them: every Supabase call runs on the server, and
 * the realtime screens get a short-lived access token from a server action.
 * Secure in production (HTTPS); plain http://localhost keeps working in development.
 */
export function sessionCookieOptions(production = process.env.NODE_ENV === 'production'): CookieOptionsWithName {
  return { httpOnly: true, secure: production, sameSite: 'lax', path: '/' };
}
