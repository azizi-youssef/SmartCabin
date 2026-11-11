import { describe, expect, it } from 'vitest';

import { createClinicSchema, newPasswordSchema, safeNextPath, signUpSchema, slugify } from './schemas';

describe('slugify', () => {
  it('builds a URL-safe slug from a clinic name', () => {
    expect(slugify('Cabinet Dr. Amal — Nador')).toBe('cabinet-dr-amal-nador');
    expect(slugify('  Clinique Él Amal  ')).toBe('clinique-el-amal');
    expect(slugify('عيادة الأمل')).toBe('');
  });
});

describe('safeNextPath (open-redirect protection)', () => {
  it.each(['/onboarding', '/reset-password', '/w/cabinet?day=2027-01-04'])('keeps same-site path %s', (path) => {
    expect(safeNextPath(path)).toBe(path);
  });
  it.each(['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '', null, undefined])(
    'rejects %s',
    (path) => {
      expect(safeNextPath(path)).toBe('/');
    },
  );
});

describe('account schemas', () => {
  it('requires 10+ characters with letters and digits', () => {
    const base = { fullName: 'Amal Démo', email: 'amal@example.test' };
    expect(signUpSchema.safeParse({ ...base, password: 'short1' }).success).toBe(false);
    expect(signUpSchema.safeParse({ ...base, password: 'onlyletters' }).success).toBe(false);
    expect(signUpSchema.safeParse({ ...base, password: '1234567890' }).success).toBe(false);
    expect(signUpSchema.safeParse({ ...base, password: 'nador2027clinic' }).success).toBe(true);
  });

  it('requires matching confirmation for a new password', () => {
    expect(newPasswordSchema.safeParse({ password: 'nador2027clinic', confirm: 'nador2027clinik' }).success).toBe(false);
    expect(newPasswordSchema.safeParse({ password: 'nador2027clinic', confirm: 'nador2027clinic' }).success).toBe(true);
  });
});

describe('createClinicSchema', () => {
  const valid = { displayName: 'Cabinet Amal', slug: 'cabinet-amal', city: 'Nador', defaultLocale: 'fr' as const, acceptTerms: true as const };

  it('accepts a valid clinic', () => {
    expect(createClinicSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects malformed and reserved slugs, and missing acceptance', () => {
    expect(createClinicSchema.safeParse({ ...valid, slug: 'ab' }).success).toBe(false);
    expect(createClinicSchema.safeParse({ ...valid, slug: 'cabinet--amal' }).success).toBe(false);
    expect(createClinicSchema.safeParse({ ...valid, slug: 'admin' }).success).toBe(false);
    expect(createClinicSchema.safeParse({ ...valid, acceptTerms: false }).success).toBe(false);
  });

  it('normalizes the slug to lower case', () => {
    const parsed = createClinicSchema.safeParse({ ...valid, slug: 'Cabinet-Amal' });
    expect(parsed.success && parsed.data.slug).toBe('cabinet-amal');
  });
});
