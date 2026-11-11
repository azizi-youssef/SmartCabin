import type { EmailOtpType } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';

import { isLocale } from '@/i18n/routing';
import { safeNextPath } from '@/modules/identity/schemas';
import { getSupabase } from '@/shared/lib/supabase/server';

const EMAIL_OTP_TYPES: EmailOtpType[] = ['signup', 'invite', 'magiclink', 'recovery', 'email_change', 'email'];

/**
 * Landing point of Supabase Auth email links (sign-up confirmation, password recovery).
 * Supports the PKCE `code` flow and the `token_hash` flow, then redirects to a same-site path.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ locale: string }> }) {
  const { locale: rawLocale } = await params;
  const locale = isLocale(rawLocale) ? rawLocale : 'fr';
  const url = request.nextUrl;
  const next = safeNextPath(url.searchParams.get('next'));
  const failure = NextResponse.redirect(new URL(`/${locale}/sign-in?link=invalid`, url.origin));

  const supabase = await getSupabase();
  if (!supabase) return failure;

  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') as EmailOtpType | null;

  let ok = false;
  if (code) {
    ok = !(await supabase.auth.exchangeCodeForSession(code)).error;
  } else if (tokenHash && type && EMAIL_OTP_TYPES.includes(type)) {
    ok = !(await supabase.auth.verifyOtp({ token_hash: tokenHash, type })).error;
  }
  return ok ? NextResponse.redirect(new URL(`/${locale}${next}`, url.origin)) : failure;
}
