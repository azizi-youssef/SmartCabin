import { createClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';

import { publicEnv } from '@/shared/lib/env';
import { reportError } from '@/shared/lib/report-error';

/**
 * Waiting-room screen snapshot (module 8b). No login: the screen's token is the credential, sent
 * as `Authorization: Bearer <token>` so it never appears in URLs or access logs. The database
 * looks the token up by its SHA-256 and returns ticket numbers and doctor display names only.
 * Called with the public key as `anon`: no session, no service role.
 */
export const dynamic = 'force-dynamic';

const HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };

export async function GET(request: NextRequest) {
  const token = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404, headers: HEADERS });
  const env = publicEnv();
  if (!env) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers: HEADERS });

  const supabase = createClient(env.url, env.key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  try {
    const { data, error } = await supabase.rpc('display_snapshot', { p_token: token });
    if (error) {
      const notFound = error.message === 'NOT_FOUND' || error.code === 'P0002';
      if (!notFound) reportError('api/display', 'UNAVAILABLE', error);
      return NextResponse.json({ error: notFound ? 'NOT_FOUND' : 'UNAVAILABLE' }, { status: notFound ? 404 : 503, headers: HEADERS });
    }
    return NextResponse.json(data, { headers: HEADERS });
  } catch (error) {
    reportError('api/display', 'UNAVAILABLE', error);
    return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers: HEADERS });
  }
}
