import type { ErrorCode } from './errors';

/*
 * The log line for an unexpected error (audit SC-AUD-04), kept free of personal data: the error's
 * name, code, HTTP status and a masked message only. Never a request body, a database "detail"
 * (which can quote row values), a hint, or a stack.
 */

const EMAIL = /[^\s@"',;()<>]+@[^\s@"',;()<>]+/g;
const LONG_NUMBER = /\+?\d[\d\s.-]{5,}\d/g;

/** Error messages minus anything that could identify a person. */
export function sanitizeMessage(message: unknown): string | undefined {
  if (typeof message !== 'string' || !message) return undefined;
  return message.replace(EMAIL, '[email]').replace(LONG_NUMBER, '[number]').slice(0, 200);
}

export interface ErrorLine {
  level: 'error';
  at: string;
  requestId: string | null;
  context: string;
  code: ErrorCode | string;
  errorName?: string;
  errorCode?: string;
  status?: number;
  message?: string;
}

export function errorLine(context: string, code: ErrorCode | string, error: unknown, requestId: string | null, at = new Date()): ErrorLine {
  const e = error && typeof error === 'object' ? (error as { name?: unknown; code?: unknown; status?: unknown; message?: unknown }) : {};
  const line: ErrorLine = { level: 'error', at: at.toISOString(), requestId, context, code };
  if (typeof e.name === 'string') line.errorName = e.name;
  if (typeof e.code === 'string') line.errorCode = e.code;
  if (typeof e.status === 'number') line.status = e.status;
  const message = sanitizeMessage(e.message);
  if (message) line.message = message;
  return line;
}
