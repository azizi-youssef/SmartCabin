'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import type { Locale } from '@/i18n/routing';
import { cn } from '@/shared/lib/cn';
import { formatTime } from '@/shared/lib/format';

interface DisplayDoctor {
  name: string;
  name_ar: string | null;
  session: 'planned' | 'open' | 'paused' | 'closed' | null;
  serving: number | null;
  called: number[];
  next: number[];
  waiting: number;
}

interface Snapshot {
  clinic: string;
  screen: string;
  timezone: string;
  generated_at: string;
  doctors: DisplayDoctor[];
}

type State = { status: 'loading' } | { status: 'missing' } | { status: 'revoked' } | { status: 'unavailable' } | { status: 'ok'; data: Snapshot; stale: boolean };

const POLL_SECONDS = 10;

/**
 * Waiting-room TV screen (module 8b): ticket numbers only, never patient names (BR-Q-09). The token
 * comes from the URL fragment (never sent to the server in the URL) and is sent as a bearer header.
 */
export function DisplayBoard() {
  const t = useTranslations('display');
  const locale = useLocale() as Locale;
  const [state, setState] = useState<State>({ status: 'loading' });
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    const token = window.location.hash.slice(1);
    const valid = /^[0-9a-f]{64}$/.test(token);
    let stopped = false;
    async function poll() {
      if (!valid) return setState({ status: 'missing' });
      try {
        const response = await fetch('/api/display', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
        if (stopped) return;
        if (response.status === 404) return setState({ status: 'revoked' });
        if (!response.ok) throw new Error(String(response.status));
        const data = (await response.json()) as Snapshot;
        setState({ status: 'ok', data, stale: false });
      } catch {
        // Keep the last snapshot on screen, marked as not current; otherwise say we are retrying.
        if (!stopped) setState((s) => (s.status === 'ok' ? { ...s, stale: true } : { status: 'unavailable' }));
      }
    }
    void poll();
    const timer = valid ? window.setInterval(() => void poll(), POLL_SECONDS * 1000) : undefined;
    const tick = () => setNow(new Date());
    const first = window.setTimeout(tick, 0);
    const clock = window.setInterval(tick, 15_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.clearTimeout(first);
      window.clearInterval(clock);
    };
  }, []);

  if (state.status === 'loading') return <p className="p-10 text-heading text-ink-muted">{t('loading')}</p>;
  if (state.status === 'unavailable') {
    return (
      <div className="grid min-h-screen place-items-center p-10 text-center">
        <div className="grid max-w-xl gap-3">
          <h1 className="text-display text-ink">{t('unavailableTitle')}</h1>
          <p className="text-heading text-ink-muted">{t('unavailableBody')}</p>
        </div>
      </div>
    );
  }
  if (state.status === 'missing' || state.status === 'revoked') {
    return (
      <div className="grid min-h-screen place-items-center p-10 text-center">
        <div className="grid max-w-xl gap-3">
          <h1 className="text-display text-ink">{t(state.status === 'missing' ? 'missingTitle' : 'revokedTitle')}</h1>
          <p className="text-heading text-ink-muted">{t(state.status === 'missing' ? 'missingBody' : 'revokedBody')}</p>
        </div>
      </div>
    );
  }

  const { data, stale } = state;
  const timeZone = data.timezone;
  return (
    <div className="flex min-h-screen flex-col gap-6 bg-canvas p-6 lg:p-10">
      <header className="flex flex-wrap items-baseline justify-between gap-4">
        <div className="grid">
          <h1 className="text-display text-ink">{data.clinic}</h1>
          <p className="text-heading text-ink-muted">{data.screen}</p>
        </div>
        <div className="flex items-baseline gap-4">
          {stale ? <span className="rounded-md bg-warning-bg px-3 py-1 text-body text-warning">{t('stale')}</span> : null}
          {now ? <span className="text-display tabular text-ink" dir="ltr">{formatTime(locale, now, timeZone)}</span> : null}
        </div>
      </header>

      {data.doctors.length === 0 ? (
        <p className="text-title text-ink-muted">{t('noDoctors')}</p>
      ) : (
        <div className="grid flex-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
          {data.doctors.map((d, i) => {
            const name = locale === 'ar' && d.name_ar ? d.name_ar : d.name;
            const closed = d.session === 'closed';
            return (
              <section key={`${d.name}-${i}`} aria-label={name} className={cn('grid content-start gap-5 rounded-xl border-2 border-line bg-surface p-6', closed && 'opacity-60')}>
                <h2 className="text-title text-ink">{name}</h2>
                {closed ? (
                  <p className="text-heading text-ink-muted">{t('closed')}</p>
                ) : (
                  <>
                    <div className="grid gap-1">
                      <span className="text-heading text-ink-muted">{t('serving')}</span>
                      <span className="text-[5rem] font-semibold leading-none tabular text-primary">{d.serving ?? '—'}</span>
                    </div>
                    <div aria-live="polite" className="grid gap-1">
                      <span className="text-heading text-ink-muted">{t('called')}</span>
                      <span className="flex flex-wrap gap-3">
                        {d.called.length === 0 ? (
                          <span className="text-title text-ink-subtle">—</span>
                        ) : (
                          d.called.map((n) => (
                            <span key={n} className="rounded-lg bg-accent px-4 py-1 text-[2.5rem] font-semibold tabular text-primary-fg">{n}</span>
                          ))
                        )}
                      </span>
                    </div>
                    <div className="grid gap-1">
                      <span className="text-heading text-ink-muted">{t('next')}</span>
                      <span className="text-title tabular text-ink">{d.next.length === 0 ? '—' : d.next.join(' · ')}</span>
                      <span className="text-body text-ink-muted">{t('waiting', { count: d.waiting })}</span>
                    </div>
                  </>
                )}
              </section>
            );
          })}
        </div>
      )}
      <footer className="text-body text-ink-subtle">{t('footer')}</footer>
    </div>
  );
}
