// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { errorLine, sanitizeMessage } from './error-line';
import { setErrorReporter, toErrorCode } from './errors';
import { normalizeSearchTerm, searchCookieName } from './search-cookie';
import { buildCsp, createNonce, requestIdFrom } from './security-headers';
import { sessionCookieOptions } from './supabase/cookie-options';

describe('Content-Security-Policy (SC-AUD-05)', () => {
  const directive = (csp: string, name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';

  it('allows only nonce-carrying scripts in production, plus what they load (Turnstile)', () => {
    const csp = buildCsp({ nonce: 'abc123', supabaseUrl: 'https://xyz.supabase.co', development: false });
    expect(directive(csp, 'script-src')).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic' https://challenges.cloudflare.com");
    expect(csp).not.toContain('unsafe-eval');
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self' https://xyz.supabase.co wss://xyz.supabase.co https://challenges.cloudflare.com");
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    expect(directive(csp, 'frame-src')).toBe('frame-src https://challenges.cloudflare.com');
    expect(csp).toContain('upgrade-insecure-requests');
  });

  it('adds eval only in development, for React Fast Refresh, and works without a backend', () => {
    const csp = buildCsp({ nonce: 'n', supabaseUrl: 'http://127.0.0.1:54321', development: true });
    expect(directive(csp, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(csp, 'connect-src')).toContain('ws://127.0.0.1:54321');
    expect(csp).not.toContain('upgrade-insecure-requests');
    expect(directive(buildCsp({ nonce: 'n', supabaseUrl: null, development: false }), 'connect-src')).toBe("connect-src 'self' https://challenges.cloudflare.com");
  });

  it('makes a fresh 128-bit nonce for every response', () => {
    const a = createNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(createNonce()).not.toBe(a);
  });
});

describe('request ids (SC-AUD-04)', () => {
  it("keeps a caller's plain id and replaces anything else", () => {
    expect(requestIdFrom('abc-123-def')).toBe('abc-123-def');
    for (const bad of [null, '', 'short', 'a b c d e f g h', 'x'.repeat(65), 'id\r\nSet-Cookie: x=1']) {
      expect(requestIdFrom(bad)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe('session cookies (SC-AUD-06)', () => {
  it('are HttpOnly and SameSite=Lax, and Secure in production', () => {
    expect(sessionCookieOptions(true)).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    expect(sessionCookieOptions(false)).toMatchObject({ httpOnly: true, secure: false });
  });
});

describe('unexpected errors (SC-AUD-04)', () => {
  afterEach(() => setErrorReporter(null));

  it('logs codes and a masked message, never e-mails, phone numbers, details or hints', () => {
    const error = {
      name: 'PostgrestError', code: 'XX000', status: 500,
      message: 'failed for nadia@example.ma, phone +212 6 12 34 56 78',
      details: 'Key (phone_e164)=(+212612345678) already exists', hint: 'secret hint',
    };
    const line = errorLine('patients/search', 'INTERNAL', error, 'req-12345678', new Date('2026-11-12T10:00:00Z'));
    expect(line).toEqual({
      level: 'error', at: '2026-11-12T10:00:00.000Z', requestId: 'req-12345678', context: 'patients/search', code: 'INTERNAL',
      errorName: 'PostgrestError', errorCode: 'XX000', status: 500, message: 'failed for [email], phone [number]',
    });
    expect(JSON.stringify(line)).not.toMatch(/nadia|212|details|hint/);
    expect(sanitizeMessage('x'.repeat(500))).toHaveLength(200);
    expect(sanitizeMessage(undefined)).toBeUndefined();
  });

  it('reports INTERNAL and UNAVAILABLE once each, and never the expected domain answers', () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);
    expect(toErrorCode({ code: 'XX000', message: 'boom' })).toBe('INTERNAL');
    expect(toErrorCode({ name: 'AuthRetryableFetchError', message: 'fetch failed' })).toBe('UNAVAILABLE');
    expect(toErrorCode({ code: 'P0001', message: 'SLOT_UNAVAILABLE' })).toBe('SLOT_UNAVAILABLE');
    expect(toErrorCode({ code: '42501', message: 'permission denied' })).toBe('FORBIDDEN');
    expect(reporter).toHaveBeenCalledTimes(2);
    expect(reporter.mock.calls.map(([code]) => code)).toEqual(['INTERNAL', 'UNAVAILABLE']);
  });
});

describe('search terms out of URLs (SC-AUD-07)', () => {
  it('keeps one cookie per screen and clinic, and normalizes the term', () => {
    expect(searchCookieName('patients', 'cabinet-demo')).toBe('sc_q_patients_cabinet-demo');
    expect(searchCookieName('invoices', 'cabinet-demo')).toBe('sc_q_invoices_cabinet-demo');
    expect(searchCookieName('patients', 'a;b=c')).toBe('sc_q_patients_abc');
    expect(normalizeSearchTerm('  Alpha   0612  ')).toBe('Alpha 0612');
    expect(normalizeSearchTerm('y'.repeat(80))).toHaveLength(60);
  });
});
