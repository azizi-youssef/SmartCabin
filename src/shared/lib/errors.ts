/**
 * Stable domain error codes (docs/API_SPECIFICATION.md §4.2). Every code has a French and an
 * Arabic message under `errors.<CODE>`. Database commands raise these codes as the message.
 */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'MFA_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'STALE_STATE',
  'SLOT_UNAVAILABLE',
  'SCHEDULE_OVERLAP',
  'CHECK_IN_NOT_TODAY',
  'SESSION_CLOSED',
  'SESSION_PAUSED',
  'SESSION_INVALID_TRANSITION',
  'DOCTOR_BUSY',
  'CORRECTION_WINDOW_PASSED',
  'INVOICE_IMMUTABLE',
  'INVOICE_INVALID_TRANSITION',
  'PAYMENT_EXCEEDS_BALANCE',
  'PLAN_LIMIT_REACHED',
  'SUBSCRIPTION_INVALID_TRANSITION',
  'BOOKING_IN_PAST',
  'BOOKING_RULE_VIOLATED',
  'SERVICE_NOT_OFFERED',
  'APPT_INVALID_TRANSITION',
  'IDEMPOTENCY_KEY_REUSED',
  'NO_SHOW_TOO_EARLY',
  'CLINIC_NOT_ACTIVE',
  'CLINIC_INVALID_TRANSITION',
  'LAST_OWNER',
  'DUPLICATE',
  'LEGAL_ACCEPTANCE_REQUIRED',
  'SLUG_TAKEN',
  'EMAIL_NOT_CONFIRMED',
  'CLINIC_CREATION_LIMIT',
  'WEAK_PASSWORD',
  'ALREADY_MEMBER',
  'INVITATION_INVALID',
  'INVITATION_EMAIL_MISMATCH',
  'MEMBER_NOT_ACTIVE',
  'MEMBER_REMOVED',
  'MEMBER_SUSPENDED',
  'ONLINE_BOOKING_NOT_ALLOWED',
  'INVALID_CREDENTIALS',
  'INVALID_CODE',
  'CAPTCHA_REQUIRED',
  'PHONE_NOT_ALLOWED',
  'RATE_LIMITED',
  'UNAVAILABLE',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const KNOWN = new Set<string>(ERROR_CODES);

interface ErrorLike {
  message?: string | undefined;
  code?: string | undefined;
  status?: number | undefined;
  name?: string | undefined;
}

type ErrorReporter = (code: ErrorCode, error: unknown) => void;
let reporter: ErrorReporter | null = null;

/**
 * Registers the server's reporter for unexpected errors (SC-AUD-04): src/shared/lib/report-error.ts
 * registers itself when loaded. This module stays importable from client components.
 */
export function setErrorReporter(fn: ErrorReporter | null): void {
  reporter = fn;
}

/** Maps a PostgREST / Supabase / network error to a domain code. Never exposes raw messages. */
export function toErrorCode(error: unknown): ErrorCode {
  const code = mapError(error);
  // Domain errors are expected answers; INTERNAL and UNAVAILABLE are incidents worth a trace.
  if ((code === 'INTERNAL' || code === 'UNAVAILABLE') && reporter && typeof window === 'undefined') reporter(code, error);
  return code;
}

function mapError(error: unknown): ErrorCode {
  if (!error || typeof error !== 'object') return 'INTERNAL';
  const e = error as ErrorLike;
  if (e.message && KNOWN.has(e.message)) return e.message as ErrorCode;
  switch (e.code) {
    case '42501':
      return 'FORBIDDEN';
    case 'P0002':
    case 'PGRST116':
      return 'NOT_FOUND';
    case '23P01':
      return 'SLOT_UNAVAILABLE';
    case '40P01': // deadlock_detected
    case '40001': // serialization_failure
      // Transient conflict with a concurrent request: the user can simply retry (SC-AUD-23).
      return 'UNAVAILABLE';
    case '23505':
      return 'DUPLICATE';
    case '23514':
    case '22P02':
    case '22007':
    case '22008':
      return 'VALIDATION_FAILED';
    default:
      break;
  }
  if (e.status === 429 || e.code === 'over_request_rate_limit' || e.code === 'over_sms_send_rate_limit') return 'RATE_LIMITED';
  if (e.code === 'invalid_credentials') return 'INVALID_CREDENTIALS';
  // SC-AUD-01: Supabase Auth refused or did not receive the CAPTCHA token.
  if (e.code === 'captcha_failed' || (typeof e.message === 'string' && /captcha/i.test(e.message))) return 'CAPTCHA_REQUIRED';
  if (e.code === 'weak_password') return 'WEAK_PASSWORD';
  if (e.code === 'email_not_confirmed') return 'EMAIL_NOT_CONFIRMED';
  if (e.code === 'over_email_send_rate_limit') return 'RATE_LIMITED';
  if (e.code === 'mfa_verification_failed' || e.code === 'otp_expired' || e.code === 'invalid_otp') return 'INVALID_CODE';
  if (e.name === 'AuthRetryableFetchError' || e.name === 'TypeError' || e.status === 0 || e.status === 502 || e.status === 503) {
    return 'UNAVAILABLE';
  }
  if (typeof e.message === 'string' && /fetch failed|ECONNREFUSED|network/i.test(e.message)) return 'UNAVAILABLE';
  return 'INTERNAL';
}
