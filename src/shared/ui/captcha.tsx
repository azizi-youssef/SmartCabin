'use client';

import { useLocale } from 'next-intl';
import { useEffect, useRef } from 'react';

/*
 * Cloudflare Turnstile widget (SC-AUD-01). Renders only when NEXT_PUBLIC_TURNSTILE_SITE_KEY is
 * set; the token it produces is single use, so forms bump `resetKey` after each submission.
 */

const SCRIPT_ID = 'cf-turnstile-script';
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render: (container: HTMLElement, options: Record<string, unknown>) => string;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? Object.assign(document.createElement('script'), { id: SCRIPT_ID, src: SCRIPT_SRC, async: true, defer: true });
    script.addEventListener('load', () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile'))));
    script.addEventListener('error', () => {
      loading = null;
      reject(new Error('turnstile'));
    });
    if (!existing) document.head.appendChild(script);
  });
  return loading;
}

export function captchaEnabled(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim());
}

/** Calls `onToken` with a fresh token, or null when it expires or fails. */
export function Captcha({ onToken, resetKey = 0 }: { onToken: (token: string | null) => void; resetKey?: number }) {
  const locale = useLocale();
  const container = useRef<HTMLDivElement>(null);
  const callback = useRef(onToken);
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim();

  useEffect(() => {
    callback.current = onToken;
  }, [onToken]);

  useEffect(() => {
    if (!siteKey || !container.current) return;
    let widgetId: string | null = null;
    let cancelled = false;
    callback.current(null);
    loadTurnstile()
      .then((api) => {
        if (cancelled || !container.current) return;
        widgetId = api.render(container.current, {
          sitekey: siteKey,
          language: locale === 'ar' ? 'ar' : 'fr',
          theme: 'light',
          callback: (token: string) => callback.current(token),
          'expired-callback': () => callback.current(null),
          'error-callback': () => callback.current(null),
        });
      })
      .catch(() => callback.current(null));
    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [siteKey, locale, resetKey]);

  if (!siteKey) return null;
  return <div ref={container} className="min-h-[65px]" data-testid="captcha" />;
}
