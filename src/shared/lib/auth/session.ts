import 'server-only';

import { cache } from 'react';

import { toErrorCode } from '@/shared/lib/errors';
import { getSupabase } from '@/shared/lib/supabase/server';

export interface Session {
  userId: string;
  aal: 'aal1' | 'aal2';
  email: string | null;
  phone: string | null;
}

export type SessionState =
  | { status: 'unavailable' }
  | { status: 'anonymous' }
  | { status: 'signed_in'; session: Session };

/**
 * Verified identity of the caller (getClaims validates the JWT; never trust getSession alone).
 * Cached per request.
 */
export const getSessionState = cache(async (): Promise<SessionState> => {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  try {
    const { data, error } = await supabase.auth.getClaims();
    if (error) return toErrorCode(error) === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'anonymous' };
    const claims = data?.claims;
    if (!claims?.sub) return { status: 'anonymous' };
    return {
      status: 'signed_in',
      session: {
        userId: claims.sub,
        aal: claims.aal === 'aal2' ? 'aal2' : 'aal1',
        email: typeof claims.email === 'string' && claims.email ? claims.email : null,
        phone: typeof claims.phone === 'string' && claims.phone ? claims.phone : null,
      },
    };
  } catch {
    return { status: 'unavailable' };
  }
});
