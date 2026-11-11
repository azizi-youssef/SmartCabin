import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { homePath } = await import('./home');

const membership = (overrides: Partial<Parameters<typeof homePath>[0]['memberships'][number]> = {}) => ({
  clinicId: 'c1',
  slug: 'cabinet',
  displayName: 'Cabinet',
  clinicStatus: 'active' as const,
  role: 'receptionist' as const,
  isPractitioner: false,
  requiresMfa: false,
  ...overrides,
});

describe('homePath', () => {
  it('sends roles that need MFA to the verification page first', () => {
    expect(homePath({ aal: 'aal1', memberships: [membership({ role: 'clinic_owner', requiresMfa: true })], isPlatformAdmin: false, hasEmail: true })).toBe('/mfa');
    expect(homePath({ aal: 'aal1', memberships: [], isPlatformAdmin: true, hasEmail: true })).toBe('/mfa');
  });

  it('opens the clinic workspace, then the platform', () => {
    expect(homePath({ aal: 'aal1', memberships: [membership()], isPlatformAdmin: false, hasEmail: true })).toBe('/w/cabinet');
    expect(homePath({ aal: 'aal2', memberships: [], isPlatformAdmin: true, hasEmail: true })).toBe('/platform');
  });

  it('sends staff accounts without a clinic to onboarding and phone accounts to the portal', () => {
    expect(homePath({ aal: 'aal1', memberships: [], isPlatformAdmin: false, hasEmail: true })).toBe('/onboarding');
    expect(homePath({ aal: 'aal1', memberships: [], isPlatformAdmin: false, hasEmail: false })).toBe('/me');
  });
});
