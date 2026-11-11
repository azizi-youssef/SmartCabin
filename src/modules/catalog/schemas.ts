import { z } from 'zod';

import { normalizePhone } from '@/shared/lib/phone';

/** Catalog inputs (doctors, services). Messages are i18n keys under `forms.errors`. */

export const doctorSchema = z
  .object({
    fullName: z.string().trim().min(2, 'required').max(120, 'tooLong'),
    fullNameAr: z.string().trim().max(120, 'tooLong').optional().or(z.literal('')),
    specialtyId: z.uuid().optional().or(z.literal('')),
    inpe: z
      .string()
      .trim()
      .optional()
      .refine((v) => !v || /^[A-Za-z0-9]{3,20}$/.test(v), 'invalidInpe'),
    phone: z
      .string()
      .trim()
      .optional()
      .refine((v) => !v || normalizePhone(v) !== null, 'invalidPhone'),
    userId: z.uuid().optional().or(z.literal('')),
    onlineBookable: z.boolean(),
  });
export type DoctorInput = z.input<typeof doctorSchema>;

const duration = z.coerce.number().int('integer').min(5, 'outOfRange').max(480, 'outOfRange').refine((v) => v % 5 === 0, 'durationStep');
const price = z
  .string()
  .trim()
  .regex(/^\d{1,9}([.,]\d{1,2})?$/, 'invalidPrice')
  .transform((v) => v.replace(',', '.'));

export const doctorServiceItemSchema = z.object({
  serviceId: z.uuid(),
  durationMinutes: z.union([z.literal(''), duration]).optional(),
  priceMad: z.union([z.literal(''), price]).optional(),
  onlineBookable: z.boolean(),
});
export const doctorServicesSchema = z.array(doctorServiceItemSchema).max(100);
export type DoctorServiceItemInput = z.input<typeof doctorServiceItemSchema>;

export const serviceSchema = z
  .object({
    nameFr: z.string().trim().max(120, 'tooLong').optional().or(z.literal('')),
    nameAr: z.string().trim().max(120, 'tooLong').optional().or(z.literal('')),
    specialtyId: z.uuid().optional().or(z.literal('')),
    durationMinutes: duration,
    priceMad: price,
    onlineBookable: z.boolean(),
  })
  .refine((v) => Boolean(v.nameFr || v.nameAr), { path: ['nameFr'], message: 'nameRequired' });
export type ServiceInput = z.input<typeof serviceSchema>;
