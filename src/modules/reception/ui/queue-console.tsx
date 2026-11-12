'use client';

import { BellRing, CheckCheck, Play, UserX } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import type { Locale } from '@/i18n/routing';
import { formatTime } from '@/shared/lib/format';
import { Badge } from '@/shared/ui/badge';
import { InlineAlert } from '@/shared/ui/states';

import { estimateRange, type DoctorSession, type QueueState } from '../queue';
import { CloseDayButton, CorrectionButton, DelayDialog, FlowButton, PriorityButton } from './queue-controls';

export interface ConsoleEntry {
  id: string;
  appointmentId: string;
  ticket: number;
  state: QueueState;
  priority: boolean;
  patientName: string;
  serviceName: string;
  checkedInAt: string;
  calledAt: string | null;
  consultationStartedAt: string | null;
  estimatedStartAt: string | null;
  /** p80 − median for this doctor and service (0 without statistics). */
  spreadMinutes: number;
}

export interface ConsoleAbilities {
  manage: boolean;
  call: boolean;
  start: boolean;
  complete: boolean;
  correct: boolean;
  prioritize: boolean;
}

const SESSION_TONE = { planned: 'neutral', open: 'success', paused: 'warning', closed: 'neutral' } as const;

/**
 * Doctor console (module 8a): the doctor's day, the current consultation, called patients and the
 * waiting list in queue order with estimated start ranges. Entries come in queue order; every
 * command is checked by the database.
 */
export function QueueConsole({
  doctorId,
  session,
  entries,
  timeZone,
  nowIso,
  abilities,
}: {
  doctorId: string;
  session: DoctorSession | null;
  entries: ConsoleEntry[];
  timeZone: string;
  nowIso: string;
  abilities: ConsoleAbilities;
}) {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const now = new Date(nowIso);
  const time = (iso: string) => formatTime(locale, iso, timeZone);
  const current = entries.find((e) => e.state === 'in_consultation');
  const called = entries.filter((e) => e.state === 'called');
  const waiting = entries.filter((e) => e.state === 'waiting');
  const status = session?.status ?? 'planned';
  const usable = status === 'planned' || status === 'open';

  return (
    <section aria-labelledby="console-title" className="grid gap-4 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="console-title" className="text-heading text-ink">{t('queue.consoleTitle')}</h2>
          <Badge tone={SESSION_TONE[status]} dot>{t(`queue.session.${status}`)}</Badge>
          {session && session.announcedDelayMinutes > 0 ? (
            <Badge tone="warning">{t('queue.delayBadge', { minutes: session.announcedDelayMinutes })}</Badge>
          ) : null}
        </div>
        {abilities.manage && status !== 'closed' ? (
          <div className="flex flex-wrap items-center gap-1">
            {status === 'planned' ? <FlowButton kind="openDay" id={doctorId}>{t('queue.openDay')}</FlowButton> : null}
            {status === 'open' && session ? <FlowButton kind="pauseDay" id={session.id} variant="ghost">{t('queue.pause')}</FlowButton> : null}
            {status === 'paused' && session ? <FlowButton kind="resumeDay" id={session.id}>{t('queue.resume')}</FlowButton> : null}
            <DelayDialog doctorId={doctorId} current={session?.announcedDelayMinutes ?? 0} />
            {session ? <CloseDayButton sessionId={session.id} waiting={called.length + waiting.length} /> : null}
          </div>
        ) : null}
      </div>

      {status === 'closed' ? <InlineAlert tone="info">{t('queue.closedNotice')}</InlineAlert> : null}
      {status === 'paused' ? <InlineAlert tone="warning">{t('queue.pausedNotice')}</InlineAlert> : null}

      <div className="grid gap-3 rounded-md border border-line bg-surface-muted p-3">
        <h3 className="text-small font-medium text-ink-muted">{t('queue.current')}</h3>
        {current ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="grid leading-tight">
              <span className="text-title text-ink">
                <span className="tabular">{t('reception.ticket', { ticket: current.ticket })}</span> · {current.patientName}
              </span>
              <span className="text-small text-ink-muted">
                {current.serviceName} · {t('queue.since', { time: time(current.consultationStartedAt ?? current.checkedInAt) })}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {abilities.correct ? <CorrectionButton appointmentId={current.appointmentId} kind="undoStart" patientName={current.patientName} /> : null}
              {abilities.complete ? (
                <FlowButton kind="complete" id={current.id} variant="primary" size="md" srLabel={current.patientName}>
                  <CheckCheck aria-hidden />
                  {t('queue.complete')}
                </FlowButton>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="text-small text-ink-muted">{t('queue.noCurrent')}</p>
        )}
      </div>

      {session && abilities.call && usable ? (
        <div>
          <FlowButton kind="callNext" id={session.id} variant="primary" size="md">
            <BellRing aria-hidden />
            {t('queue.callNext')}
          </FlowButton>
        </div>
      ) : null}

      {called.length > 0 ? (
        <div className="grid gap-2">
          <h3 className="text-small font-medium text-ink-muted">{t('queue.called')}</h3>
          <ul className="divide-y divide-line rounded-md border border-line">
            {called.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <span className="w-14 shrink-0 font-medium tabular text-ink">{t('reception.ticket', { ticket: e.ticket })}</span>
                <span className="grid min-w-0 flex-1 leading-tight">
                  <span className="truncate text-body text-ink">{e.patientName}</span>
                  <span className="text-small text-ink-muted">{t('queue.calledAt', { time: time(e.calledAt ?? e.checkedInAt) })}</span>
                </span>
                {abilities.call ? (
                  <FlowButton kind="recall" id={e.id} variant="ghost" srLabel={e.patientName}>
                    <UserX aria-hidden />
                    {t('queue.recall')}
                  </FlowButton>
                ) : null}
                {abilities.start && !current ? (
                  <FlowButton kind="start" id={e.id} srLabel={e.patientName}>
                    <Play aria-hidden className="flip-rtl" />
                    {t('queue.start')}
                  </FlowButton>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-2">
        <h3 className="text-small font-medium text-ink-muted">{t('queue.waiting', { count: waiting.length })}</h3>
        {waiting.length === 0 ? (
          <p className="text-small text-ink-muted">{t('reception.waitingEmpty')}</p>
        ) : (
          <ol className="divide-y divide-line rounded-md border border-line">
            {waiting.map((e, index) => {
              const range = estimateRange(e.estimatedStartAt, now, e.spreadMinutes);
              return (
                <li key={e.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <span className="w-6 shrink-0 text-small text-ink-subtle tabular">{index + 1}</span>
                  <span className="w-14 shrink-0 font-medium tabular text-ink">{t('reception.ticket', { ticket: e.ticket })}</span>
                  <span className="grid min-w-0 flex-1 leading-tight">
                    <span className="flex items-center gap-1.5 truncate text-body text-ink">
                      {e.patientName}
                      {e.priority ? <Badge tone="accent">{t('queue.priority')}</Badge> : null}
                    </span>
                    <span className="text-small text-ink-muted">
                      {e.serviceName}
                      {range ? <> · {t('queue.estimate', { from: time(range.low.toISOString()), to: time(range.high.toISOString()) })}</> : null}
                    </span>
                  </span>
                  {abilities.prioritize ? <PriorityButton entryId={e.id} patientName={e.patientName} priority={e.priority} /> : null}
                  {abilities.start && !current && usable ? (
                    <FlowButton kind="start" id={e.id} variant="ghost" srLabel={e.patientName}>
                      <Play aria-hidden className="flip-rtl" />
                      {t('queue.start')}
                    </FlowButton>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
        <p className="text-caption text-ink-subtle">{t('queue.estimateNote')}</p>
      </div>
    </section>
  );
}
