import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { portalPhoneAllowed } from './phone-policy';

/*
 * SC-AUD-01 — SMS sign-up abuse ("SMS pumping"): the portal never creates an account at sign-in,
 * sends codes to Moroccan mobile numbers only, answers the same for unknown numbers, and passes
 * the CAPTCHA token to Supabase Auth. Supabase Auth itself is mocked here; its settings are
 * checked in src/shared/lib/auth-config.test.ts.
 */

const signInWithOtp = vi.fn();
const signInWithPassword = vi.fn();
vi.mock('@/shared/lib/supabase/server', () => ({
  getSupabase: async () => ({ auth: { signInWithOtp, signInWithPassword } }),
}));
vi.mock('@/i18n/navigation', () => ({ redirect: vi.fn() }));

const MOBILE = '+212612345678';

describe('portal phone numbers', () => {
  it('accepts Moroccan mobile numbers only, and synthetic test numbers outside production', () => {
    expect(portalPhoneAllowed('+212612345678', true)).toBe(true);
    expect(portalPhoneAllowed('+212712345678', true)).toBe(true);
    for (const refused of ['+212512345678', '+212812345678', '+33612345678', '+18005550100', '+882123456789', '+21261234567']) {
      expect(portalPhoneAllowed(refused, true), refused).toBe(false);
    }
    expect(portalPhoneAllowed('+99910000011', true)).toBe(false);
    expect(portalPhoneAllowed('+99910000011', false)).toBe(true);
  });
});

describe('sendPhoneCode (patient portal)', () => {
  beforeEach(() => {
    signInWithOtp.mockReset();
    signInWithOtp.mockResolvedValue({ data: {}, error: null });
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'site-key-test');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('never asks Supabase Auth to create an account, and passes the CAPTCHA token', async () => {
    const { sendPhoneCode } = await import('./actions');
    await expect(sendPhoneCode({ phone: '06 12 34 56 78', captchaToken: 'token-1' })).resolves.toEqual({ ok: true, data: { phone: MOBILE } });
    expect(signInWithOtp).toHaveBeenCalledWith({ phone: MOBILE, options: { shouldCreateUser: false, captchaToken: 'token-1' } });
  });

  it('refuses foreign, landline and premium numbers before any SMS is requested', async () => {
    const { sendPhoneCode } = await import('./actions');
    for (const phone of ['+33 6 12 34 56 78', '05 22 12 34 56', '+1 900 555 0100']) {
      expect(await sendPhoneCode({ phone, captchaToken: 'token-1' }), phone).toEqual({ ok: false, code: 'PHONE_NOT_ALLOWED' });
    }
    expect(await sendPhoneCode({ phone: 'abc' })).toEqual({ ok: false, code: 'VALIDATION_FAILED' });
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  it('requires the CAPTCHA token when CAPTCHA is configured, without calling Supabase Auth', async () => {
    const { sendPhoneCode } = await import('./actions');
    expect(await sendPhoneCode({ phone: MOBILE })).toEqual({ ok: false, code: 'CAPTCHA_REQUIRED' });
    expect(signInWithOtp).not.toHaveBeenCalled();
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '');
    await sendPhoneCode({ phone: MOBILE });
    expect(signInWithOtp).toHaveBeenCalledWith({ phone: MOBILE, options: { shouldCreateUser: false } });
  });

  it('answers an unknown number exactly like a known one (no enumeration)', async () => {
    const { sendPhoneCode } = await import('./actions');
    for (const error of [
      { code: 'otp_disabled', message: 'Signups not allowed for otp', status: 422 },
      { code: undefined, message: 'Signups not allowed for this instance', status: 422 },
    ]) {
      signInWithOtp.mockResolvedValueOnce({ data: {}, error });
      expect(await sendPhoneCode({ phone: MOBILE, captchaToken: 'token-1' })).toEqual({ ok: true, data: { phone: MOBILE } });
    }
  });

  it('reports rate limits and CAPTCHA refusals, and hides any other detail', async () => {
    const { sendPhoneCode } = await import('./actions');
    signInWithOtp.mockResolvedValueOnce({ data: {}, error: { code: 'over_sms_send_rate_limit', message: 'too many', status: 429 } });
    expect(await sendPhoneCode({ phone: MOBILE, captchaToken: 't' })).toEqual({ ok: false, code: 'RATE_LIMITED' });
    signInWithOtp.mockResolvedValueOnce({ data: {}, error: { code: 'captcha_failed', message: 'captcha protection: request disallowed', status: 400 } });
    expect(await sendPhoneCode({ phone: MOBILE, captchaToken: 't' })).toEqual({ ok: false, code: 'CAPTCHA_REQUIRED' });
    signInWithOtp.mockResolvedValueOnce({ data: {}, error: { code: 'sms_send_failed', message: 'provider said no', status: 500 } });
    expect(await sendPhoneCode({ phone: MOBILE, captchaToken: 't' })).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });
});

describe('staff sign-in with CAPTCHA', () => {
  beforeEach(() => {
    signInWithPassword.mockReset();
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'site-key-test');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('passes the token, and tells a CAPTCHA refusal apart from wrong credentials', async () => {
    const { signInWithPassword: action } = await import('./actions');
    const credentials = { email: 'owner@example.test', password: 'secret-password' };
    expect(await action('fr', credentials)).toEqual({ ok: false, code: 'CAPTCHA_REQUIRED' });
    expect(signInWithPassword).not.toHaveBeenCalled();

    signInWithPassword.mockResolvedValueOnce({ data: {}, error: { code: 'captcha_failed', message: 'captcha protection', status: 400 } });
    expect(await action('fr', credentials, 'token-2')).toEqual({ ok: false, code: 'CAPTCHA_REQUIRED' });
    expect(signInWithPassword).toHaveBeenCalledWith({ ...credentials, options: { captchaToken: 'token-2' } });

    signInWithPassword.mockResolvedValueOnce({ data: {}, error: { code: 'invalid_credentials', message: 'Invalid login credentials', status: 400 } });
    expect(await action('fr', credentials, 'token-3')).toEqual({ ok: false, code: 'INVALID_CREDENTIALS' });
  });
});
