/*
 * Names of the cookies that hold a screen's search term (audit SC-AUD-07): one per screen and
 * clinic, so a search in one clinic never shows up in another.
 */

export const SEARCH_SCOPES = ['patients', 'invoices'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export const SEARCH_TTL_SECONDS = 15 * 60;

export function searchCookieName(scope: SearchScope, clinicSlug: string): string {
  return `sc_q_${scope}_${clinicSlug.replace(/[^a-z0-9-]/g, '')}`;
}

/** A search term as stored: single spaces, at most 60 characters. */
export function normalizeSearchTerm(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 60);
}
