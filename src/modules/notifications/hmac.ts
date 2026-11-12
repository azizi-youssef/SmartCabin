import { createHmac, timingSafeEqual } from 'node:crypto';

/*
 * Signature of internal job calls (API spec: /api/internal/jobs/*): HMAC-SHA256 over
 * "<timestamp>.<raw body>", hex, with a timestamp at most 5 minutes old. pg_net computes the same
 * signature in SQL (private.call_dispatch).
 */

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function signJob(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function verifyJobSignature(input: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  body: string;
  now?: Date;
}): boolean {
  const { secret, timestamp, signature, body } = input;
  if (!secret || secret.length < 32 || !timestamp || !signature || !/^\d{9,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) {
    return false;
  }
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(signJob(secret, timestamp, body), 'hex');
  const given = Buffer.from(signature, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
