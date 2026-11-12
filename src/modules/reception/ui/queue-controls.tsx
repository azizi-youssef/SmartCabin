'use client';

import { ArrowUp, Clock, Flag, FlagOff, Undo2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition, type ReactNode } from 'react';

import { useRouter } from '@/i18n/navigation';
import type { ActionResult } from '@/shared/lib/result';
import { Button, type ButtonProps } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Dialog, DialogContent, DialogTrigger } from '@/shared/ui/dialog';
import { Field } from '@/shared/ui/field';
import { Input, Select } from '@/shared/ui/form-controls';
import { InlineAlert } from '@/shared/ui/states';
import { useToast } from '@/shared/ui/toast';

import {
  callNext,
  closeDay,
  completeConsultation,
  correctToCheckedIn,
  moveBefore,
  openDay,
  pauseDay,
  recallEntry,
  reportDelay,
  resumeDay,
  setPriority,
  startConsultation,
} from '../flow-actions';
import { PRIORITY_REASONS, type PriorityReason } from '../queue';

type FlowKind = 'callNext' | 'recall' | 'start' | 'complete' | 'openDay' | 'pauseDay' | 'resumeDay';

const RUN: Record<FlowKind, (id: string) => Promise<ActionResult<unknown>>> = {
  callNext,
  recall: recallEntry,
  start: startConsultation,
  complete: completeConsultation,
  openDay,
  pauseDay,
  resumeDay,
};

/** One queue command; the database decides whether it is allowed. */
export function FlowButton({
  kind,
  id,
  children,
  srLabel,
  variant = 'secondary',
  size = 'sm',
}: {
  kind: FlowKind;
  id: string;
  children: ReactNode;
  srLabel?: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
}) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant={variant}
      size={size}
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await RUN[kind](id);
          if (!result.ok) {
            toast({ tone: 'danger', title: t(`errors.${result.code}`) });
          } else if (kind === 'callNext') {
            const ticket = (result.data as { ticket: number | null }).ticket;
            toast({ tone: 'success', title: ticket === null ? t('queue.nobodyWaiting') : t('queue.calledToast', { ticket }) });
          } else {
            toast({ tone: 'success', title: t(`queue.done.${kind}`) });
          }
          router.refresh();
        })
      }
    >
      {children}
      {srLabel ? <span className="sr-only"> — {srLabel}</span> : null}
    </Button>
  );
}

export function CloseDayButton({ sessionId, waiting }: { sessionId: string; waiting: number }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  return (
    <ConfirmDialog
      tone="danger"
      trigger={<Button size="sm" variant="ghost" className="text-danger hover:bg-danger-bg hover:text-danger">{t('queue.closeDay')}</Button>}
      title={t('queue.closeDayTitle')}
      description={waiting > 0 ? t('queue.closeDayBodyWaiting', { count: waiting }) : t('queue.closeDayBody')}
      confirmLabel={t('queue.closeDay')}
      cancelLabel={t('common.cancel')}
      onConfirm={async () => {
        const result = await closeDay(sessionId);
        if (!result.ok) return t(`errors.${result.code}`);
        toast({ tone: 'success', title: t('queue.dayClosed') });
        router.refresh();
      }}
    />
  );
}

const DELAYS = [0, 10, 15, 20, 30, 45, 60, 90, 120] as const;

export function DelayDialog({ doctorId, current }: { doctorId: string; current: number }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [minutes, setMinutes] = useState(String(current));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setMinutes(String(current));
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          <Clock aria-hidden />
          {t('queue.reportDelay')}
        </Button>
      </DialogTrigger>
      <DialogContent
        title={t('queue.reportDelayTitle')}
        description={t('queue.reportDelayHint')}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await reportDelay({ doctorId, minutes: Number(minutes) });
                  if (!result.ok) return setError(t(`errors.${result.code}`));
                  toast({ tone: 'success', title: t('queue.delayReported') });
                  setOpen(false);
                  router.refresh();
                })
              }
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <Field id="delay-minutes" label={t('queue.delayMinutes')}>
            <Select value={minutes} onChange={(e) => setMinutes(e.target.value)}>
              {DELAYS.map((m) => (
                <option key={m} value={m}>{m === 0 ? t('queue.noDelay') : t('queue.delayOption', { minutes: m })}</option>
              ))}
            </Select>
          </Field>
          {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** BR-Q-05: priority is a human decision with a stated reason; removing it needs no reason. */
export function PriorityButton({ entryId, patientName, priority }: { entryId: string; patientName: string; priority: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const [reason, setReason] = useState<PriorityReason>('elderly');
  return (
    <ConfirmDialog
      trigger={
        <Button size="icon-sm" variant="ghost" aria-label={priority ? t('queue.removePriorityFor', { name: patientName }) : t('queue.setPriorityFor', { name: patientName })}>
          {priority ? <FlagOff aria-hidden /> : <Flag aria-hidden />}
        </Button>
      }
      title={priority ? t('queue.removePriorityTitle', { name: patientName }) : t('queue.setPriorityTitle', { name: patientName })}
      description={priority ? t('queue.removePriorityBody') : t('queue.setPriorityBody')}
      confirmLabel={priority ? t('queue.removePriority') : t('queue.setPriority')}
      cancelLabel={t('common.cancel')}
      onConfirm={async () => {
        const result = await setPriority(priority ? { entryId, priority: false } : { entryId, priority: true, reason });
        if (!result.ok) return t(`errors.${result.code}`);
        toast({ tone: 'success', title: t('queue.priorityUpdated') });
        router.refresh();
      }}
    >
      {priority ? null : (
        <Field id={`priority-reason-${entryId}`} label={t('queue.priorityReason')} required>
          <Select value={reason} onChange={(e) => setReason(e.target.value as PriorityReason)}>
            {PRIORITY_REASONS.map((r) => (
              <option key={r} value={r}>{t(`queue.priorityReasons.${r}`)}</option>
            ))}
          </Select>
        </Field>
      )}
    </ConfirmDialog>
  );
}

function ReasonConfirm({
  trigger,
  title,
  description,
  confirmLabel,
  idPrefix,
  run,
  successTitle,
  tone = 'default',
}: {
  trigger: ReactNode;
  title: string;
  description: string;
  confirmLabel: string;
  idPrefix: string;
  run: (reason: string) => Promise<ActionResult>;
  successTitle: string;
  tone?: 'default' | 'danger';
}) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const [reason, setReason] = useState('');
  return (
    <ConfirmDialog
      tone={tone}
      trigger={trigger}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      cancelLabel={t('common.cancel')}
      confirmDisabled={reason.trim().length < 3}
      onOpenChange={(open) => {
        if (!open) setReason('');
      }}
      onConfirm={async () => {
        const result = await run(reason.trim());
        if (!result.ok) return t(`errors.${result.code}`);
        toast({ tone: 'success', title: successTitle });
        router.refresh();
      }}
    >
      <Field id={`${idPrefix}-reason`} label={t('queue.reason')} hint={t('queue.reasonHint')} required>
        <Input maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </ConfirmDialog>
  );
}

/** BR-Q-06: moves an entry just before the one ahead of it, with a reason (logged). */
export function MoveUpButton({ entryId, beforeEntryId, patientName }: { entryId: string; beforeEntryId: string; patientName: string }) {
  const t = useTranslations();
  return (
    <ReasonConfirm
      idPrefix={`move-${entryId}`}
      trigger={<Button size="icon-sm" variant="ghost" aria-label={t('queue.moveUpFor', { name: patientName })}><ArrowUp aria-hidden /></Button>}
      title={t('queue.moveUpTitle', { name: patientName })}
      description={t('queue.moveUpBody')}
      confirmLabel={t('queue.moveUp')}
      successTitle={t('queue.moved')}
      run={(reason) => moveBefore({ entryId, beforeEntryId, reason })}
    />
  );
}

/** A13 (consultation started by mistake) or A14 (late arrival after a no-show), audited. */
export function CorrectionButton({ appointmentId, kind, patientName }: { appointmentId: string; kind: 'undoStart' | 'lateArrival'; patientName: string }) {
  const t = useTranslations();
  return (
    <ReasonConfirm
      idPrefix={`correct-${appointmentId}`}
      tone={kind === 'undoStart' ? 'danger' : 'default'}
      trigger={
        <Button size="sm" variant="ghost">
          <Undo2 aria-hidden className="flip-rtl" />
          <span className="sr-only xl:not-sr-only">{t(`queue.correction.${kind}`)}</span>
          <span className="sr-only"> — {patientName}</span>
        </Button>
      }
      title={t(`queue.correction.${kind}Title`, { name: patientName })}
      description={t(`queue.correction.${kind}Body`)}
      confirmLabel={t(`queue.correction.${kind}`)}
      successTitle={t('queue.corrected')}
      run={(reason) => correctToCheckedIn({ appointmentId, reason })}
    />
  );
}

/**
 * Keeps a queue screen current until realtime broadcasts arrive (module 8b): refreshes the server
 * data every `seconds` while the page is visible.
 */
export function AutoRefresh({ seconds = 20 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, seconds * 1000);
    return () => window.clearInterval(timer);
  }, [router, seconds]);
  return null;
}
