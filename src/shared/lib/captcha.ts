import { z } from 'zod';

/*
 * CAPTCHA (SC-AUD-01). Supabase Auth checks the Turnstile token on sign-up, password sign-in,
 * OTP and password reset once [auth.captcha] is enabled; the site key below only decides whether
 * the forms show the widget. Both must be configured together (docs/SECURITY_MODEL.md §7).
 */

/** Public Turnstile site key, or null when CAPTCHA is not configured for this deployment. */
export function captchaSiteKey(): string | null {
  const key = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim();
  return key ? key : null;
}

/** A Turnstile response token (opaque, single use). */
export const captchaTokenSchema = z.string().trim().min(1).max(4096);

/**
 * Normalizes the token a form sent: required when a site key is configured (the server refuses
 * early instead of letting Supabase Auth do it), ignored otherwise.
 */
export function readCaptchaToken(token: unknown): { ok: true; token: string | undefined } | { ok: false } {
  if (!captchaSiteKey()) return { ok: true, token: undefined };
  const parsed = captchaTokenSchema.safeParse(token);
  return parsed.success ? { ok: true, token: parsed.data } : { ok: false };
}
