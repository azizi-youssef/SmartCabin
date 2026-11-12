import { describe, expect, it } from 'vitest';

import { summarizeDay } from './analytics/day-summary';
import { APPOINTMENT_STATUSES, availableActions, STATUS_TONE } from './appointments/domain/status';
import { localizedName } from './catalog/names';
import { createPatientSchema, toPatientColumns, updatePatientSchema } from './patients/schemas';

describe('appointment status presentation', () => {
  it('gives every status a tone', () => {
    for (const status of APPOINTMENT_STATUSES) expect(STATUS_TONE[status]).toBeTruthy();
  });

  it('offers only actions valid for the status', () => {
    const now = new Date('2027-01-15T10:00:00Z');
    const later = { startsAt: '2027-01-15T11:00:00Z' };
    const earlier = { startsAt: '2027-01-15T09:00:00Z' };
    expect(availableActions({ status: 'pending', ...later }, now, 15)).toEqual({ confirm: true, reschedule: true, cancel: true, noShow: false });
    expect(availableActions({ status: 'confirmed', ...later }, now, 15)).toEqual({ confirm: false, reschedule: true, cancel: true, noShow: false });
    expect(availableActions({ status: 'confirmed', ...earlier }, now, 15).noShow).toBe(true);
    expect(availableActions({ status: 'confirmed', startsAt: '2027-01-15T09:50:00Z' }, now, 15).noShow).toBe(false);
    for (const status of ['completed', 'cancelled', 'no_show', 'in_progress'] as const) {
      expect(availableActions({ status, ...earlier }, now, 15)).toEqual({ confirm: false, reschedule: false, cancel: false, noShow: false });
    }
  });
});

describe('day summary (counts from records only)', () => {
  it('counts statuses and computes the no-show rate on scheduled appointments', () => {
    const summary = summarizeDay([
      { status: 'completed', source: 'staff' },
      { status: 'completed', source: 'walk_in' },
      { status: 'no_show', source: 'online' },
      { status: 'confirmed', source: 'staff' },
      { status: 'cancelled', source: 'staff' },
      { status: 'checked_in', source: 'staff' },
    ]);
    expect(summary).toEqual({ total: 6, upcoming: 1, inClinic: 1, completed: 2, cancelled: 1, noShow: 1, noShowRate: 0.5 });
  });

  it('counts patients who left before consultation in the no-show denominator (K4)', () => {
    const summary = summarizeDay([
      { status: 'completed', source: 'staff' },
      { status: 'no_show', source: 'staff' },
      { status: 'cancelled', source: 'staff', cancellationReason: 'left_before_consultation' },
      { status: 'cancelled', source: 'staff', cancellationReason: 'patient_request' },
      { status: 'cancelled', source: 'walk_in', cancellationReason: 'left_before_consultation' },
    ]);
    expect(summary.noShowRate).toBeCloseTo(1 / 3);
  });

  it('returns no rate (not zero) when nothing can be measured', () => {
    expect(summarizeDay([]).noShowRate).toBeNull();
    expect(summarizeDay([{ status: 'confirmed', source: 'staff' }]).noShowRate).toBeNull();
  });
});

describe('localized clinic names', () => {
  it('prefers the locale and falls back to the other language', () => {
    expect(localizedName('ar', 'Consultation', 'استشارة')).toBe('استشارة');
    expect(localizedName('ar', 'Consultation', null)).toBe('Consultation');
    expect(localizedName('fr', null, 'استشارة')).toBe('استشارة');
    expect(localizedName('fr', null, null)).toBe('—');
  });
});

describe('patient registration schema', () => {
  const valid = {
    firstName: 'Amina',
    lastName: 'Haddou',
    preferredLocale: 'ar' as const,
    preferredChannel: 'sms' as const,
    phone: '06 12 34 56 78',
    consentDataProcessing: true as const,
    consentSmsReminders: true,
  };

  it('accepts minimal administrative data', () => {
    expect(createPatientSchema.safeParse(valid).success).toBe(true);
  });

  it('requires the data-processing consent', () => {
    const result = createPatientSchema.safeParse({ ...valid, consentDataProcessing: false });
    expect(result.success).toBe(false);
  });

  it('requires a valid phone for the SMS channel', () => {
    expect(createPatientSchema.safeParse({ ...valid, phone: '' }).success).toBe(false);
    expect(createPatientSchema.safeParse({ ...valid, phone: '12' }).success).toBe(false);
    expect(createPatientSchema.safeParse({ ...valid, phone: '', preferredChannel: 'none' }).success).toBe(true);
  });

  it('rejects a birth date in the future', () => {
    expect(createPatientSchema.safeParse({ ...valid, dateOfBirth: '2999-01-01' }).success).toBe(false);
  });
});

describe('patient update schema and column mapping', () => {
  const base = { firstName: 'Amina', lastName: 'Haddou', preferredLocale: 'fr' as const, preferredChannel: 'none' as const };

  it('does not ask for consents on update, but keeps the SMS phone rule', () => {
    expect(updatePatientSchema.safeParse(base).success).toBe(true);
    expect(updatePatientSchema.safeParse({ ...base, preferredChannel: 'sms' }).success).toBe(false);
  });

  it('maps empty optional fields to NULL and normalizes the phone', () => {
    const parsed = updatePatientSchema.parse({ ...base, firstNameAr: '', sex: '', phone: '06 12 34 56 78' });
    expect(toPatientColumns(parsed)).toMatchObject({ first_name_ar: null, sex: null, date_of_birth: null, phone_e164: '+212612345678' });
  });
});
