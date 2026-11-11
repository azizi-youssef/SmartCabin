import { z } from 'zod';

/**
 * Public origin used in email links (confirmation, password reset, invitations).
 * Taken from configuration, never from request headers (Host header injection).
 */
export function siteUrl(): string {
  const parsed = z.url().safeParse(process.env.NEXT_PUBLIC_SITE_URL);
  if (parsed.success) return parsed.data.replace(/\/+$/, '');
  if (process.env.NODE_ENV !== 'production') return 'http://localhost:3000';
  throw new Error('NEXT_PUBLIC_SITE_URL must be configured in production');
}
