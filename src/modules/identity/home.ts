import 'server-only';

import type { Membership } from '@/modules/tenancy/workspace';

/**
 * Where a signed-in user lands. Navigation only — access is enforced by the database.
 * Order: MFA first for roles that need it, then the single clinic, the platform, the portal.
 */
export function homePath(params: {
  aal: 'aal1' | 'aal2';
  memberships: Membership[];
  isPlatformAdmin: boolean;
  /** Email accounts are staff accounts; phone-only accounts are patient portal accounts. */
  hasEmail: boolean;
}): string {
  const { aal, memberships, isPlatformAdmin, hasEmail } = params;
  const needsMfa = (isPlatformAdmin || memberships.some((m) => m.requiresMfa)) && aal !== 'aal2';
  if (needsMfa) return '/mfa';
  const first = memberships[0];
  if (first) return `/w/${first.slug}`;
  if (isPlatformAdmin) return '/platform';
  // A staff account without a clinic yet: create one (or wait for an invitation).
  if (hasEmail) return '/onboarding';
  return '/me';
}
