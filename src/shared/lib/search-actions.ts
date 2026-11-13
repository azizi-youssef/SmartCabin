'use server';

import { cookies } from 'next/headers';

import { normalizeSearchTerm, SEARCH_SCOPES, SEARCH_TTL_SECONDS, searchCookieName, type SearchScope } from './search-cookie';

/**
 * Stores (or clears) a screen's search term in its HttpOnly cookie (audit SC-AUD-07). Setting a
 * cookie in a server action re-renders the current page, which then reads the term: the URL
 * never carries it.
 */
export async function submitSearch(formData: FormData): Promise<void> {
  const scope = String(formData.get('scope') ?? '');
  const slug = String(formData.get('clinic') ?? '');
  if (!(SEARCH_SCOPES as readonly string[]).includes(scope) || !/^[a-z0-9][a-z0-9-]{1,80}$/.test(slug)) return;
  const term = formData.get('clear') ? '' : normalizeSearchTerm(String(formData.get('q') ?? ''));
  const store = await cookies();
  const name = searchCookieName(scope as SearchScope, slug);
  if (!term) {
    store.delete(name);
    return;
  }
  store.set(name, encodeURIComponent(term), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: SEARCH_TTL_SECONDS,
  });
}
