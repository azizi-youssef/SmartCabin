// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * The proxy (SC-AUD-04/05/06): every page response carries a CSP with a fresh nonce, the same
 * policy reaches the rendering through the request headers (Next.js reads the nonce there), a
 * request id travels both ways, and the Supabase session client writes HttpOnly cookies.
 */

// next-intl's middleware, reduced to what the proxy relies on (checked in next-intl 4.14 source):
// it copies the incoming request headers into the forwarded request, and redirects "/" to a locale.
vi.mock('next-intl/middleware', async () => {
  const { NextResponse } = await import('next/server');
  return {
    default: () => (request: NextRequest) => (request.nextUrl.pathname === '/'
      ? NextResponse.redirect(new URL('/fr', request.url))
      : NextResponse.next({ request: { headers: new Headers(request.headers) } })),
  };
});

const createServerClient = vi.fn<(url: string, key: string, options: Record<string, unknown>) => unknown>(() => ({ auth: { getClaims: async () => ({ data: null, error: null }) } }));
vi.mock('@supabase/ssr', () => ({ createServerClient: (url: string, key: string, options: Record<string, unknown>) => createServerClient(url, key, options) }));

async function run(path: string, headers: Record<string, string> = {}) {
  const { proxy } = await import('./proxy');
  return proxy(new NextRequest(`http://localhost${path}`, { headers }));
}

describe('proxy security headers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    createServerClient.mockClear();
  });

  it('sets a nonce CSP on the response and hands the same policy and a request id to the rendering', async () => {
    const res = await run('/fr/sign-in');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    // Next.js request-header overrides (how a proxy passes headers to the rendering).
    expect(res.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(res.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get('x-middleware-request-x-request-id')).toBe(id);

    const again = await run('/fr/sign-in');
    expect(again.headers.get('content-security-policy')).not.toBe(csp); // a new nonce each time
  });

  it("keeps a valid incoming request id, and redirects to a locale with the policy too", async () => {
    expect((await run('/fr/sign-in', { 'x-request-id': 'edge-req-0001' })).headers.get('x-request-id')).toBe('edge-req-0001');
    const root = await run('/');
    expect(root.status).toBeGreaterThanOrEqual(300);
    expect(root.headers.get('content-security-policy')).toContain("'strict-dynamic'");
  });

  it('refreshes the session with HttpOnly cookies when a backend is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://xyz.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test_key_000');
    const res = await run('/fr/sign-in');
    expect(createServerClient).toHaveBeenCalledOnce();
    expect(createServerClient.mock.calls[0]?.[2]).toMatchObject({ cookieOptions: { httpOnly: true, sameSite: 'lax' } });
    expect(res.headers.get('content-security-policy')).toContain('connect-src \'self\' https://xyz.supabase.co wss://xyz.supabase.co');
  });
});
