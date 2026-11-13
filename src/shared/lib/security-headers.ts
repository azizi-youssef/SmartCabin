/*
 * Content-Security-Policy and HSTS (audit SC-AUD-05). The proxy builds the CSP for every page
 * with a fresh nonce; Next.js reads the nonce from the request's CSP header and puts it on its
 * own scripts. 'strict-dynamic' then trusts the scripts those load (the Turnstile widget).
 */

const TURNSTILE = 'https://challenges.cloudflare.com';

export function buildCsp(input: { nonce: string; supabaseUrl: string | null; development: boolean }): string {
  const supabase = input.supabaseUrl ? new URL(input.supabaseUrl) : null;
  // Realtime (queue screens) opens a websocket to the same Supabase host.
  const supabaseOrigins = supabase
    ? [supabase.origin, `${supabase.protocol === 'https:' ? 'wss' : 'ws'}://${supabase.host}`]
    : [];
  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    // Development needs eval for React Fast Refresh; production never allows it.
    ['script-src', ["'self'", `'nonce-${input.nonce}'`, "'strict-dynamic'", TURNSTILE, ...(input.development ? ["'unsafe-eval'"] : [])]],
    // Inline style attributes are used by components; scripts are what matters for XSS.
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'", ...supabaseOrigins, TURNSTILE]],
    ['frame-src', [TURNSTILE]],
    ['frame-ancestors', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['object-src', ["'none'"]],
  ];
  const policy = directives.map(([name, values]) => `${name} ${values.join(' ')}`);
  if (!input.development) policy.push('upgrade-insecure-requests');
  return policy.join('; ');
}

/** A random nonce for one response (base64, 128 bits). */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/** Keeps a caller's request id only if it is a plain token; otherwise makes one. */
export function requestIdFrom(incoming: string | null): string {
  if (incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming)) return incoming;
  return crypto.randomUUID();
}

export const HSTS_VALUE = 'max-age=31536000; includeSubDomains';
