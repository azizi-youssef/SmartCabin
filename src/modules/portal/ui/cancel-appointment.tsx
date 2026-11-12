'use client';

import { useTranslations } from 'next-intl';

import { useRouter } from '@/i18n/navigation';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { useToast } from '@/shared/ui/toast';

import { cancelMyAppointment } from '../booking-actions';

/** A6 by the patient, before the clinic's cutoff (the database checks it again). */
export function CancelMyAppointment({ appointmentId, label }: { appointmentId: string; label: string }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  return (
    <ConfirmDialog
      trigger={<Button size="sm" variant="danger-outline">{t('portal.cancel')}</Button>}
      title={t('portal.cancelTitle')}
      description={t('portal.cancelBody', { appointment: label })}
      confirmLabel={t('portal.cancel')}
      cancelLabel={t('portal.keep')}
      tone="danger"
      onConfirm={async () => {
        const result = await cancelMyAppointment({ appointmentId });
        if (!result.ok) return t(`errors.${result.code}`);
        toast({ tone: 'success', title: t('portal.cancelled') });
        router.refresh();
      }}
    />
  );
}
