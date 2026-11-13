import 'server-only';

import { headers } from 'next/headers';

import { errorLine } from './error-line';
import { setErrorReporter, type ErrorCode } from './errors';

/*
 * Unexpected errors (audit SC-AUD-04): one structured line on the server's standard error, which
 * the host's log drain collects. It carries the request id (also shown to the user on error
 * screens), the context and the error's own code, never personal data (see error-line.ts).
 * An error tracker may be added later, after its processor agreement.
 */

/** Logs an unexpected error once, with the current request id when there is one. */
export function reportError(context: string, code: ErrorCode | string, error: unknown): void {
  void (async () => {
    let requestId: string | null = null;
    try {
      requestId = (await headers()).get('x-request-id');
    } catch {
      // Outside a request (jobs, tests): no request id.
    }
    console.error(JSON.stringify(errorLine(context, code, error, requestId)));
  })();
}

// Every mapping of an error to INTERNAL or UNAVAILABLE on the server is reported from now on.
setErrorReporter((code, error) => reportError('toErrorCode', code, error));
