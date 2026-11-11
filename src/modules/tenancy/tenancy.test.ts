import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { parseDateRange } = await import('./queries');
const { manageableRoles } = await import('./roles');
const { bookingPolicySchema, clinicProfileSchema, closureSchema, inviteSchema } = await import('./schemas');

describe('manageableRoles', () => {
  it('lets owners manage every role and admins only non-admin roles', () => {
    expect(manageableRoles('clinic_owner')).toEqual(['clinic_owner', 'clinic_admin', 'doctor', 'receptionist', 'accountant']);
    expect(manageableRoles('clinic_admin')).toEqual(['doctor', 'receptionist', 'accountant']);
    expect(manageableRoles('receptionist')).toEqual([]);
  });
});

describe('parseDateRange', () => {
  it('reads canonical PostgreSQL date ranges', () => {
    expect(parseDateRange('[2027-01-11,2027-01-12)')).toEqual(['2027-01-11', '2027-01-12']);
    expect(parseDateRange('garbage')).toEqual(['', '']);
  });
});

describe('clinic settings schemas', () => {
  it('validates the ICE as 15 digits when present', () => {
    const base = { displayName: 'Cabinet', city: 'Nador', defaultLocale: 'fr' as const };
    expect(clinicProfileSchema.safeParse({ ...base, ice: '' }).success).toBe(true);
    expect(clinicProfileSchema.safeParse({ ...base, ice: '001234567000089' }).success).toBe(true);
    expect(clinicProfileSchema.safeParse({ ...base, ice: '12345' }).success).toBe(false);
  });

  it('coerces and bounds booking policy numbers', () => {
    const base = {
      onlineBookingEnabled: false,
      autoConfirmOnline: false,
      minLeadMinutes: '60',
      maxHorizonDays: '60',
      patientCancelCutoffHours: '2',
      maxActiveOnlineBookings: '3',
      reminderHoursBefore: '24',
      checkinGraceMinutes: '15',
      turnApproachingPositions: '2',
      smsSenderName: 'CabinetAA',
    };
    const parsed = bookingPolicySchema.safeParse(base);
    expect(parsed.success && parsed.data.minLeadMinutes).toBe(60);
    expect(bookingPolicySchema.safeParse({ ...base, maxHorizonDays: '0' }).success).toBe(false);
    expect(bookingPolicySchema.safeParse({ ...base, checkinGraceMinutes: '7.5' }).success).toBe(false);
    expect(bookingPolicySchema.safeParse({ ...base, smsSenderName: 'Cabinet Gynéco' }).success).toBe(false);
  });

  it('rejects closures that end before they start', () => {
    expect(closureSchema.safeParse({ from: '2027-01-11', to: '2027-01-10', reason: 'Fête' }).success).toBe(false);
    expect(closureSchema.safeParse({ from: '2027-01-11', to: '2027-01-11', reason: 'Fête' }).success).toBe(true);
  });

  it('accepts only known roles in invitations', () => {
    expect(inviteSchema.safeParse({ email: 'a@example.test', role: 'receptionist' }).success).toBe(true);
    expect(inviteSchema.safeParse({ email: 'a@example.test', role: 'superuser' }).success).toBe(false);
  });
});
