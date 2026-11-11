'use client';

import { Ban, CalendarClock, Check, UserX } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { useRouter } from '@/i18n/navigation';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Field } from '@/shared/ui/field';
import { Select, Textarea } from '@/shared/ui/form-controls';
import { useToast } from '@/shared/ui/toast';

import { cancelAppointment, confirmAppointment, markNoShow } from '../actions';
import { STAFF_CANCELLATION_REASONS, type StaffCancellationReason } from '../domain/status';
import { RescheduleDialog } from './booking-dialog';

export interface RowAppointment {
  id: string;
  version: number;
  doctorId: string;
  serviceId: string;
  day: string;
  patientName: string;
  timeLabel: string;
}

/**
 * Contextual actions for one appointment. Only actions that are valid for its status are shown
 * (computed by `availableActions`), and every consequential one asks for confirmation.
 */
export function AppointmentRowActions({
  appointment,
  actions,
  timeZone,
}: {
  appointment: RowAppointment;
  actions: { confirm: boolean; reschedule: boolean; cancel: boolean; noShow: boolean };
  timeZone: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [rescheduling, setRescheduling] = useState(false);
  const [reason, setReason] = useState<StaffCancellationReason | ''>('');
  const [note, setNote] = useState('');

  if (!actions.confirm && !actions.cancel && !actions.noShow && !actions.reschedule) return null;

  function errorText(code: string): string {
    return t(`errors.${code}`);
  }

  function confirm() {
    startTransition(async () => {
      const result = await confirmAppointment({ id: appointment.id, version: appointment.version });
      if (result.ok) toast({ tone: 'success', title: t('reception.confirmDone') });
      else toast({ tone: 'danger', title: errorText(result.code) });
      router.refresh();
    });
  }

  return (
    <div className="flex items-center justify-end gap-1">
      {actions.confirm ? (
        <Button size="sm" variant="secondary" onClick={confirm} loading={pending}>
          <Check aria-hidden />
          {t('reception.confirm')}
        </Button>
      ) : null}

      {actions.reschedule ? (
        <>
          <Button size="sm" variant="ghost" onClick={() => setRescheduling(true)}>
            <CalendarClock aria-hidden />
            <span className="hidden xl:inline">{t('reception.reschedule')}</span>
            <span className="sr-only xl:hidden">{t('reception.reschedule')}</span>
          </Button>
          {rescheduling ? (
            <RescheduleDialog appointment={appointment} timeZone={timeZone} open={rescheduling} onOpenChange={setRescheduling} />
          ) : null}
        </>
      ) : null}

      {actions.noShow ? (
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="ghost">
              <UserX aria-hidden />
              <span className="hidden xl:inline">{t('reception.noShow')}</span>
              <span className="sr-only xl:hidden">{t('reception.noShow')}</span>
            </Button>
          }
          title={t('reception.noShowTitle')}
          description={t('reception.noShowBody', { patient: appointment.patientName, time: appointment.timeLabel })}
          confirmLabel={t('reception.noShow')}
          cancelLabel={t('reception.noShowKeep')}
          onConfirm={async () => {
            const result = await markNoShow({ id: appointment.id, version: appointment.version });
            if (!result.ok) return errorText(result.code);
            toast({ tone: 'success', title: t('reception.noShowDone') });
            router.refresh();
          }}
        />
      ) : null}

      {actions.cancel ? (
        <ConfirmDialog
          tone="danger"
          trigger={
            <Button size="sm" variant="ghost" className="text-danger hover:bg-danger-bg hover:text-danger">
              <Ban aria-hidden />
              <span className="sr-only">{t('reception.cancel')}</span>
            </Button>
          }
          title={t('reception.cancelTitle')}
          description={t('reception.cancelBody', { patient: appointment.patientName, time: appointment.timeLabel })}
          confirmLabel={t('reception.cancel')}
          cancelLabel={t('reception.cancelKeep')}
          confirmDisabled={!reason}
          onOpenChange={(open) => {
            if (!open) {
              setReason('');
              setNote('');
            }
          }}
          onConfirm={async () => {
            if (!reason) return t('errors.VALIDATION_FAILED');
            const result = await cancelAppointment({ id: appointment.id, version: appointment.version, reason, note });
            if (!result.ok) return errorText(result.code);
            toast({ tone: 'success', title: t('reception.cancelDone') });
            router.refresh();
          }}
        >
          <Field id={`cancel-reason-${appointment.id}`} label={t('reception.cancelReason')} required>
            <Select value={reason} onChange={(e) => setReason(e.target.value as StaffCancellationReason)}>
              <option value="">{t('common.selectPlaceholder')}</option>
              {STAFF_CANCELLATION_REASONS.map((r) => (
                <option key={r} value={r}>
                  {t(`cancellationReason.${r}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={`cancel-note-${appointment.id}`} label={t('reception.cancelNote')} optionalLabel={t('common.optional')}>
            <Textarea rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </ConfirmDialog>
      ) : null}

    </div>
  );
}
