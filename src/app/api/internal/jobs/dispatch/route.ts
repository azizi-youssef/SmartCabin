import { createClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';

import { runDispatch } from '@/modules/notifications/dispatch';
import { verifyJobSignature } from '@/modules/notifications/hmac';
import { providerFromEnv } from '@/modules/notifications/providers';
import { publicEnv } from '@/shared/lib/env';

/**
 * Notification worker (module 9), called every minute by pg_cron + pg_net (or any scheduler)
 * with an HMAC signature: headers x-smartcabin-timestamp and x-smartcabin-signature over
 * "<timestamp>.<raw body>". No service-role key: the database job functions are guarded by the
 * job key (the same secret, whose SHA-256 is stored in private.job_credentials).
 */
export const dynamic = 'force-dynamic';

const HEADERS = { 'Cache-Control': 'no-store' };
/** The scheduler sends "{}"; anything large is refused before it is read or hashed. */
const MAX_BODY_BYTES = 1024;

export async function POST(request: NextRequest) {
  const secret = process.env['JOBS_SECRET'] ?? '';
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'PAYLOAD_TOO_LARGE' }, { status: 413, headers: HEADERS });
  }
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return NextResponse.json({ error: 'PAYLOAD_TOO_LARGE' }, { status: 413, headers: HEADERS });
  const valid = verifyJobSignature({
    secret,
    timestamp: request.headers.get('x-smartcabin-timestamp'),
    signature: request.headers.get('x-smartcabin-signature'),
    body,
  });
  if (!valid) return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401, headers: HEADERS });
  const env = publicEnv();
  if (!env) return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers: HEADERS });

  const supabase = createClient(env.url, env.key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  try {
    const summary = await runDispatch({
      rpc: async (fn, args) => {
        const { data, error } = await supabase.rpc(fn, args);
        return { data, error: error ? { message: error.message } : null };
      },
      jobKey: secret,
      provider: providerFromEnv(),
    });
    return NextResponse.json(summary, { headers: HEADERS });
  } catch {
    // Counts only, no detail: a failed run is retried by the next call.
    return NextResponse.json({ error: 'UNAVAILABLE' }, { status: 503, headers: HEADERS });
  }
}
