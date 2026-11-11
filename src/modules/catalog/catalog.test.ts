import { describe, expect, it } from 'vitest';

import { doctorSchema, doctorServicesSchema, serviceSchema } from './schemas';

describe('doctorSchema', () => {
  const valid = { fullName: 'Dr Amal Démo', onlineBookable: true };

  it('accepts a doctor without account, specialty or INPE', () => {
    expect(doctorSchema.safeParse({ ...valid, userId: '', specialtyId: '', inpe: '' }).success).toBe(true);
  });

  it('validates INPE and phone formats when present', () => {
    expect(doctorSchema.safeParse({ ...valid, inpe: '12' }).success).toBe(false);
    expect(doctorSchema.safeParse({ ...valid, inpe: 'AB12345' }).success).toBe(true);
    expect(doctorSchema.safeParse({ ...valid, phone: '0612' }).success).toBe(false);
    expect(doctorSchema.safeParse({ ...valid, phone: '0612345678' }).success).toBe(true);
  });
});

describe('doctor service overrides', () => {
  const serviceId = '7d9a6b1e-2f3c-4b5a-8c6d-1e2f3a4b5c6d';

  it('accepts empty overrides (use the service defaults)', () => {
    expect(doctorServicesSchema.safeParse([{ serviceId, durationMinutes: '', priceMad: '', onlineBookable: true }]).success).toBe(true);
  });

  it('enforces 5-minute steps and the 5–480 range', () => {
    expect(doctorServicesSchema.safeParse([{ serviceId, durationMinutes: 7, onlineBookable: true }]).success).toBe(false);
    expect(doctorServicesSchema.safeParse([{ serviceId, durationMinutes: 485, onlineBookable: true }]).success).toBe(false);
    expect(doctorServicesSchema.safeParse([{ serviceId, durationMinutes: 45, onlineBookable: true }]).success).toBe(true);
  });

  it('normalizes a French decimal comma in prices', () => {
    const parsed = doctorServicesSchema.safeParse([{ serviceId, priceMad: '250,50', onlineBookable: true }]);
    expect(parsed.success && parsed.data[0]?.priceMad).toBe('250.50');
  });
});

describe('serviceSchema', () => {
  it('requires a name in at least one language', () => {
    const base = { durationMinutes: 20, priceMad: '200', onlineBookable: false };
    expect(serviceSchema.safeParse({ ...base, nameFr: '', nameAr: '' }).success).toBe(false);
    expect(serviceSchema.safeParse({ ...base, nameFr: '', nameAr: 'استشارة' }).success).toBe(true);
  });

  it('rejects negative or malformed prices', () => {
    const base = { nameFr: 'Consultation', durationMinutes: 20, onlineBookable: false };
    expect(serviceSchema.safeParse({ ...base, priceMad: '-10' }).success).toBe(false);
    expect(serviceSchema.safeParse({ ...base, priceMad: '200.555' }).success).toBe(false);
    expect(serviceSchema.safeParse({ ...base, priceMad: '200' }).success).toBe(true);
  });
});
