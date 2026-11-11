'use client';

import { DoorOpen, LogIn } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { useRouter } from '@/i18n/navigation';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/form-controls';
import { useToast } from '@/shared/ui/toast';

import { checkIn, markLeft } from '../actions';

/** Records the patient's arrival (A8): the database assigns the ticket and the queue position. */
export function CheckInButton({ appointmentId, version, patientName, timeLabel }: { appointmentId: string; version: number; patientName: string; timeLabel: string }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await checkIn({ id: appointmentId, version });
          if (result.ok) toast({ tone: 'success', title: t('reception.checkInDone', { ticket: result.data.ticket }) });
          else toast({ tone: 'danger', title: t(`errors.${result.code}`) });
          router.refresh();
        })
      }
    >
      <LogIn aria-hidden className="flip-rtl" />
      {t('reception.checkIn')}
      <span className="sr-only"> — {patientName}, {timeLabel}</span>
    </Button>
  );
}

/** Closes a waiting entry as "left before consultation" (A11); the appointment is cancelled. */
export function MarkLeftButton({ queueEntryId, patientName, ticket }: { queueEntryId: string; patientName: string; ticket: number }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const [note, setNote] = useState('');
  return (
    <ConfirmDialog
      tone="danger"
      trigger={
        <Button size="sm" variant="ghost" className="text-danger hover:bg-danger-bg hover:text-danger">
          <DoorOpen aria-hidden className="flip-rtl" />
          <span className="sr-only xl:not-sr-only">{t('reception.left')}</span>
          <span className="sr-only"> — {patientName}, {t('reception.ticket', { ticket })}</span>
        </Button>
      }
      title={t('reception.leftTitle', { name: patientName })}
      description={t('reception.leftBody')}
      confirmLabel={t('reception.left')}
      cancelLabel={t('common.cancel')}
      onOpenChange={(open) => {
        if (!open) setNote('');
      }}
      onConfirm={async () => {
        const result = await markLeft({ queueEntryId, ...(note.trim() ? { note: note.trim() } : {}) });
        if (!result.ok) return t(`errors.${result.code}`);
        toast({ tone: 'success', title: t('reception.leftDone') });
        router.refresh();
      }}
    >
      <Field id={`left-note-${queueEntryId}`} label={t('reception.leftNote')} optionalLabel={t('common.optional')}>
        <Input maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </ConfirmDialog>
  );
}
