import { z } from 'zod';

import { normalizePhone } from '@/shared/lib/phone';

/**
 * Identity and onboarding inputs, shared by forms and Server Actions.
 * Error messages are i18n keys under `forms.errors`.
 */

/** 10+ characters with letters and digits; Supabase Auth applies its own policy too. */
export const passwordSchema = z
  .string()
  .min(10, 'passwordTooShort')
  .max(200, 'tooLong')
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'passwordWeak');

export const signUpSchema = z.object({
  fullName: z.string().trim().min(2, 'required').max(120, 'tooLong'),
  email: z.email('invalidEmail').max(254, 'tooLong'),
  password: passwordSchema,
});
export type SignUpInput = z.input<typeof signUpSchema>;

export const emailOnlySchema = z.object({ email: z.email('invalidEmail').max(254, 'tooLong') });

export const newPasswordSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'passwordMismatch' });
export type NewPasswordInput = z.input<typeof newPasswordSchema>;

export const SLUG_PATTERN = /^[a-z0-9](-?[a-z0-9]){2,40}$/;
export const RESERVED_SLUGS = ['admin', 'api', 'app', 'auth', 'platform', 'www', 'static', 'assets', 'login', 'register', 'book', 'me', 'w', 'c'];

/** "Cabinet Dr. Amal — Nador" → "cabinet-dr-amal-nador" (Latin only; Arabic names need a manual slug). */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 41)
    .replace(/-+$/g, '');
}

export const createClinicSchema = z.object({
  displayName: z.string().trim().min(2, 'required').max(120, 'tooLong'),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG_PATTERN, 'invalidSlug')
    .refine((v) => !RESERVED_SLUGS.includes(v), 'reservedSlug'),
  city: z.string().trim().min(2, 'required').max(80, 'tooLong'),
  phone: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || normalizePhone(v) !== null, 'invalidPhone'),
  defaultLocale: z.enum(['fr', 'ar']),
  acceptTerms: z.literal(true, { message: 'termsRequired' }),
});
export type CreateClinicInput = z.input<typeof createClinicSchema>;

/**
 * Post-authentication redirect target from an email link. Only same-site absolute paths
 * are allowed (no "//host", no scheme), to prevent open redirects.
 */
export function safeNextPath(next: string | null | undefined, fallback = '/'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\') || /^\/[a-z]+:/i.test(next)) return fallback;
  return next;
}
