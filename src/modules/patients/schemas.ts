import { z } from 'zod';

import { normalizePhone } from '@/shared/lib/phone';

/**
 * Patient inputs, shared by the forms (instant feedback) and the Server Actions (authority
 * before the database). Messages are i18n keys under `patients.form.errors`.
 * Administrative data only (BR-D-01): no clinical field exists.
 */
const patientFields = z.object({
  firstName: z.string().trim().min(1, 'required').max(80, 'tooLong'),
  lastName: z.string().trim().min(1, 'required').max(80, 'tooLong'),
  firstNameAr: z.string().trim().max(80, 'tooLong').optional().or(z.literal('')),
  lastNameAr: z.string().trim().max(80, 'tooLong').optional().or(z.literal('')),
  sex: z.enum(['female', 'male', '']).optional(),
  dateOfBirth: z
    .string()
    .optional()
    .refine((v) => !v || (/^\d{4}-\d{2}-\d{2}$/.test(v) && v >= '1900-01-01' && v <= new Date().toISOString().slice(0, 10)), 'invalidDate'),
  phone: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || normalizePhone(v) !== null, 'invalidPhone'),
  preferredLocale: z.enum(['fr', 'ar']),
  preferredChannel: z.enum(['sms', 'email', 'none']),
});

const smsNeedsPhone = (v: { preferredChannel: string; phone?: string | undefined }) => v.preferredChannel !== 'sms' || Boolean(v.phone);

export const createPatientSchema = patientFields
  .extend({
    consentDataProcessing: z.literal(true, { message: 'consentRequired' }),
    consentSmsReminders: z.boolean(),
  })
  .refine(smsNeedsPhone, { path: ['phone'], message: 'phoneRequiredForSms' });
export type CreatePatientInput = z.input<typeof createPatientSchema>;

export const updatePatientSchema = patientFields.refine(smsNeedsPhone, { path: ['phone'], message: 'phoneRequiredForSms' });
export type UpdatePatientInput = z.input<typeof updatePatientSchema>;

export const CONSENT_PURPOSES = ['data_processing', 'reminders_sms', 'reminders_whatsapp', 'reminders_email'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/** Columns shared by create and update, in database naming. */
export function toPatientColumns(v: z.output<typeof patientFields>) {
  return {
    first_name: v.firstName,
    last_name: v.lastName,
    first_name_ar: v.firstNameAr || null,
    last_name_ar: v.lastNameAr || null,
    sex: v.sex || null,
    date_of_birth: v.dateOfBirth || null,
    phone_e164: v.phone ? normalizePhone(v.phone) : null,
    preferred_locale: v.preferredLocale,
    preferred_channel: v.preferredChannel,
  };
}
