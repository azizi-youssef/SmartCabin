import type { ErrorCode } from './errors';

/**
 * Outcome of a data load, rendered explicitly by pages:
 * - ok: real rows from the database (possibly empty → empty state)
 * - unavailable: backend not configured or unreachable → "service unavailable" state
 * - error: a domain error code → error state with a localized message
 * Pages never substitute sample data for a missing backend.
 */
export type Loaded<T> =
  | { status: 'ok'; data: T }
  | { status: 'unavailable' }
  | { status: 'error'; code: ErrorCode };

/** Outcome of a mutation (Server Action), serializable to the client. */
export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; code: ErrorCode; fields?: Record<string, string> };

export function ok<T>(data: T): Loaded<T> {
  return { status: 'ok', data };
}
