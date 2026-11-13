import { z } from 'zod';

import { normalizePhone } from '@/shared/lib/phone';

import { CLINIC_ROLES } from './roles';

/** Clinic administration inputs. Messages are i18n keys under `forms.errors`. */

const optionalText = (max: number) => z.string().trim().max(max, 'tooLong').optional().or(z.literal(''));

export const clinicProfileSchema = z.object({
  displayName: z.string().trim().min(2, 'required').max(120, 'tooLong'),
  legalName: optionalText(200),
  city: z.string().trim().min(2, 'required').max(80, 'tooLong'),
  addressLine: optionalText(300),
  phone: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || normalizePhone(v) !== null, 'invalidPhone'),
  email: z.email('invalidEmail').optional().or(z.literal('')),
  ice: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^\d{15}$/.test(v), 'invalidIce'),
  defaultLocale: z.enum(['fr', 'ar']),
});
export type ClinicProfileInput = z.input<typeof clinicProfileSchema>;

const int = (min: number, max: number) => z.coerce.number().int('integer').min(min, 'outOfRange').max(max, 'outOfRange');

export const bookingPolicySchema = z.object({
  onlineBookingEnabled: z.boolean(),
  autoConfirmOnline: z.boolean(),
  /** BR-P-04: list the clinic's online-bookable doctors in the public directory (/medecins). */
  listedInDirectory: z.boolean(),
  minLeadMinutes: int(0, 10080),
  maxHorizonDays: int(1, 365),
  patientCancelCutoffHours: int(0, 168),
  maxActiveOnlineBookings: int(1, 20),
  reminderHoursBefore: int(1, 168),
  checkinGraceMinutes: int(0, 120),
  turnApproachingPositions: int(1, 10),
  smsSenderName: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^[A-Za-z0-9 ]{3,11}$/.test(v), 'invalidSender'),
});
export type BookingPolicyInput = z.input<typeof bookingPolicySchema>;

export const closureSchema = z
  .object({
    from: z.iso.date('invalidDate'),
    to: z.iso.date('invalidDate'),
    reason: z.string().trim().min(2, 'required').max(200, 'tooLong'),
  })
  .refine((v) => v.to >= v.from, { path: ['to'], message: 'endBeforeStart' });
export type ClosureInput = z.input<typeof closureSchema>;

export const inviteSchema = z.object({
  email: z.email('invalidEmail').max(254, 'tooLong'),
  role: z.enum(CLINIC_ROLES),
});
export type InviteInput = z.input<typeof inviteSchema>;
