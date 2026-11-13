import 'server-only';

import { cookies } from 'next/headers';

import { searchCookieName, type SearchScope } from './search-cookie';

/*
 * Search terms out of URLs (audit SC-AUD-07): patient names and phone numbers typed in a search
 * box would otherwise land in browser history, shared links and the host's request logs. The
 * term travels in a POST to a server action (search-actions.ts), which keeps it in a short-lived
 * HttpOnly cookie named after the screen and the clinic; the page reads it from there.
 */

/** The current search term of a screen, or an empty string. */
export async function readSearchTerm(scope: SearchScope, clinicSlug: string): Promise<string> {
  const value = (await cookies()).get(searchCookieName(scope, clinicSlug))?.value ?? '';
  try {
    return decodeURIComponent(value).slice(0, 60);
  } catch {
    return '';
  }
}
