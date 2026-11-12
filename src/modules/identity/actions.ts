'use server';

import { z } from 'zod';

import { redirect } from '@/i18n/navigation';
import { isLocale, type Locale } from '@/i18n/routing';
import { readCaptchaToken } from '@/shared/lib/captcha';
import { toErrorCode } from '@/shared/lib/errors';
import { normalizePhone } from '@/shared/lib/phone';
import type { ActionResult } from '@/shared/lib/result';
import { siteUrl } from '@/shared/lib/site';
import { getSupabase } from '@/shared/lib/supabase/server';

import { portalPhoneAllowed } from './phone-policy';
import { emailOnlySchema, newPasswordSchema, signUpSchema, type NewPasswordInput, type SignUpInput } from './schemas';

const credentials = z.object({ email: z.email().max(254), password: z.string().min(1).max(200) });

function localeOf(value: string): Locale {
  return isLocale(value) ? value : 'fr';
}

/**
 * Clinic owner sign-up. Supabase Auth sends a confirmation email whose link returns to
 * /[locale]/auth/callback. The answer is the same whether or not the email already exists
 * (no account enumeration).
 */
export async function signUp(locale: string, input: SignUpInput, captchaToken?: string): Promise<ActionResult> {
  const parsed = signUpSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const captcha = readCaptchaToken(captchaToken);
  if (!captcha.ok) return { ok: false, code: 'CAPTCHA_REQUIRED' };
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const l = localeOf(locale);
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { full_name: parsed.data.fullName, locale: l },
      emailRedirectTo: `${siteUrl()}/${l}/auth/callback?next=/onboarding`,
      ...(captcha.token ? { captchaToken: captcha.token } : {}),
    },
  });
  if (error) {
    const code = toErrorCode(error);
    if (code === 'WEAK_PASSWORD' || code === 'RATE_LIMITED' || code === 'UNAVAILABLE' || code === 'CAPTCHA_REQUIRED') return { ok: false, code };
  }
  return { ok: true, data: undefined };
}

/** Sends a password-reset link. Always answers success (no account enumeration). */
export async function requestPasswordReset(locale: string, input: { email: string }, captchaToken?: string): Promise<ActionResult> {
  const parsed = emailOnlySchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const captcha = readCaptchaToken(captchaToken);
  if (!captcha.ok) return { ok: false, code: 'CAPTCHA_REQUIRED' };
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${siteUrl()}/${localeOf(locale)}/auth/callback?next=/reset-password`,
    ...(captcha.token ? { captchaToken: captcha.token } : {}),
  });
  const failure = error ? toErrorCode(error) : null;
  if (failure === 'RATE_LIMITED' || failure === 'CAPTCHA_REQUIRED') return { ok: false, code: failure };
  return { ok: true, data: undefined };
}

/** Sets a new password for the session opened by the reset link, then signs other sessions out. */
export async function updatePassword(locale: string, input: NewPasswordInput): Promise<ActionResult> {
  const parsed = newPasswordSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return { ok: false, code: toErrorCode(error) };
  await supabase.auth.signOut({ scope: 'others' }).catch(() => undefined);
  redirect({ href: '/', locale: localeOf(locale) });
  return { ok: true, data: undefined };
}

/** Staff sign-in (email + password). The landing page then routes by role and MFA level. */
export async function signInWithPassword(locale: string, input: { email: string; password: string }, captchaToken?: string): Promise<ActionResult> {
  const parsed = credentials.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const captcha = readCaptchaToken(captchaToken);
  if (!captcha.ok) return { ok: false, code: 'CAPTCHA_REQUIRED' };
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { error } = await supabase.auth.signInWithPassword({
    ...parsed.data,
    ...(captcha.token ? { options: { captchaToken: captcha.token } } : {}),
  });
  if (error) {
    const code = toErrorCode(error);
    // One message for unknown email and wrong password (no account enumeration).
    return { ok: false, code: code === 'UNAVAILABLE' || code === 'CAPTCHA_REQUIRED' ? code : 'INVALID_CREDENTIALS' };
  }
  redirect({ href: '/', locale: isLocale(locale) ? locale : 'fr' });
  return { ok: true, data: undefined };
}

export async function signOut(locale: string): Promise<void> {
  const supabase = await getSupabase();
  await supabase?.auth.signOut().catch(() => undefined);
  redirect({ href: '/sign-in', locale: (isLocale(locale) ? locale : 'fr') as Locale });
}

export interface TotpEnrollment {
  factorId: string;
  qrCode: string;
  secret: string;
}

/** Starts TOTP enrollment; the QR code is an SVG data URI generated by Supabase Auth. */
export async function startTotpEnrollment(): Promise<ActionResult<TotpEnrollment>> {
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  // Remove abandoned, never-verified factors first (Supabase refuses duplicate friendly names).
  const factors = await supabase.auth.mfa.listFactors();
  for (const factor of factors.data?.all ?? []) {
    if (factor.factor_type === 'totp' && factor.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: factor.id });
  }
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `SmartCabin ${new Date().toISOString().slice(0, 10)}` });
  if (error || !data) return { ok: false, code: toErrorCode(error) };
  return { ok: true, data: { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret } };
}

/** Verifies a 6-digit code for an enrolled (or enrolling) factor and upgrades the session to aal2. */
export async function verifyTotp(locale: string, input: { factorId: string; code: string }): Promise<ActionResult> {
  const parsed = z.object({ factorId: z.string().min(1), code: z.string().regex(/^\d{6}$/) }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_CODE' };
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: parsed.data.factorId, code: parsed.data.code });
  if (error) return { ok: false, code: toErrorCode(error) === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'INVALID_CODE' };
  redirect({ href: '/', locale: isLocale(locale) ? locale : 'fr' });
  return { ok: true, data: undefined };
}

/** GoTrue's answers for a number with no account (shouldCreateUser false): treated as sent. */
const NO_ACCOUNT_CODES = new Set(['otp_disabled', 'user_not_found', 'signup_disabled', 'phone_provider_disabled']);

/**
 * Sends a one-time SMS code (SC-AUD-01): Moroccan mobile numbers only, CAPTCHA token required
 * when configured (Supabase Auth verifies it), and one answer whether or not the number has an
 * account (no enumeration). Supabase Auth applies the same limits to direct calls (config.toml,
 * and the before-user-created hook of migration 0030).
 */
async function requestSmsCode(
  input: { phone: string; captchaToken?: string | undefined },
  createAccount: boolean,
): Promise<ActionResult<{ phone: string }>> {
  const phone = normalizePhone(input.phone);
  if (!phone) return { ok: false, code: 'VALIDATION_FAILED' };
  if (!portalPhoneAllowed(phone)) return { ok: false, code: 'PHONE_NOT_ALLOWED' };
  const captcha = readCaptchaToken(input.captchaToken);
  if (!captcha.ok) return { ok: false, code: 'CAPTCHA_REQUIRED' };
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { error } = await supabase.auth.signInWithOtp({
    phone,
    options: { shouldCreateUser: createAccount, ...(captcha.token ? { captchaToken: captcha.token } : {}) },
  });
  if (error && !NO_ACCOUNT_CODES.has((error as { code?: string }).code ?? '') && !/signups? not allowed/i.test(error.message)) {
    const code = toErrorCode(error);
    return { ok: false, code: code === 'RATE_LIMITED' || code === 'CAPTCHA_REQUIRED' ? code : 'UNAVAILABLE' };
  }
  return { ok: true, data: { phone } };
}

/** Portal sign-in: never creates an account (accounts come from online booking or a clinic link). */
export async function sendPhoneCode(input: { phone: string; captchaToken?: string }): Promise<ActionResult<{ phone: string }>> {
  return requestSmsCode(input, false);
}

/**
 * Online booking (S7): the patient's account is created on the way if needed. The database hook
 * accepts Moroccan mobile numbers only, so the same holds for direct calls to Supabase Auth.
 */
export async function sendBookingCode(input: { phone: string; captchaToken?: string }): Promise<ActionResult<{ phone: string }>> {
  return requestSmsCode(input, true);
}

/** Verifies the booking code and opens the session, without leaving the booking page. */
export async function verifyBookingCode(input: { phone: string; code: string }): Promise<ActionResult> {
  const parsed = z.object({ phone: z.string().regex(/^\+[1-9]\d{7,14}$/), code: z.string().regex(/^\d{6}$/) }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_CODE' };
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { error } = await supabase.auth.verifyOtp({ phone: parsed.data.phone, token: parsed.data.code, type: 'sms' });
  if (error) return { ok: false, code: toErrorCode(error) === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'INVALID_CODE' };
  return { ok: true, data: undefined };
}

export async function verifyPhoneCode(locale: string, input: { phone: string; code: string }): Promise<ActionResult> {
  const parsed = z.object({ phone: z.string().regex(/^\+[1-9]\d{7,14}$/), code: z.string().regex(/^\d{6}$/) }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'INVALID_CODE' };
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { error } = await supabase.auth.verifyOtp({ phone: parsed.data.phone, token: parsed.data.code, type: 'sms' });
  if (error) return { ok: false, code: toErrorCode(error) === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'INVALID_CODE' };
  redirect({ href: '/me', locale: isLocale(locale) ? locale : 'fr' });
  return { ok: true, data: undefined };
}
