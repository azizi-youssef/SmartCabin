'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { useRouter } from '@/i18n/navigation';
import type { ClinicStatus } from '@/modules/tenancy/workspace';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Field } from '@/shared/ui/field';
import { Textarea } from '@/shared/ui/form-controls';
import { useToast } from '@/shared/ui/toast';

import { setClinicStatus } from '../actions';

/** Status transitions offered for one clinic; each one is confirmed and explained. */
export function ClinicStatusActions({ clinic, next }: { clinic: { id: string; name: string; status: ClinicStatus }; next: ClinicStatus[] }) {
  const t = useTranslations('platform');
  const te = useTranslations('errors');
  const router = useRouter();
  const toast = useToast();
  const [reason, setReason] = useState('');

  async function apply(status: ClinicStatus, withReason?: string) {
    const result = await setClinicStatus({ clinicId: clinic.id, status, ...(withReason ? { reason: withReason } : {}) });
    if (!result.ok) return te(result.code);
    toast({ tone: 'success', title: t('done') });
    router.refresh();
  }

  return (
    <div className="flex items-center justify-end gap-1">
      {next.map((status) => {
        const pending = clinic.status === 'pending_approval';
        if (status === 'active') {
          return (
            <ConfirmDialog
              key={status}
              trigger={<Button size="sm" variant={pending ? 'primary' : 'secondary'}>{pending ? t('actions.active') : t('actions.reactivate')}</Button>}
              title={pending ? t('confirm.approveTitle', { name: clinic.name }) : t('confirm.reactivateTitle', { name: clinic.name })}
              description={pending ? t('confirm.approveBody') : t('confirm.reactivateBody')}
              confirmLabel={pending ? t('actions.active') : t('actions.reactivate')}
              cancelLabel={t('confirm.keep')}
              onConfirm={() => apply('active')}
            />
          );
        }
        if (status === 'suspended') {
          return (
            <ConfirmDialog
              key={status}
              tone="danger"
              trigger={<Button size="sm" variant="ghost">{t('actions.suspended')}</Button>}
              title={t('confirm.suspendTitle', { name: clinic.name })}
              description={t('confirm.suspendBody')}
              confirmLabel={t('actions.suspended')}
              cancelLabel={t('confirm.keep')}
              confirmDisabled={reason.trim().length < 3}
              onOpenChange={(open) => {
                if (!open) setReason('');
              }}
              onConfirm={() => apply('suspended', reason.trim())}
            >
              <Field id={`suspend-reason-${clinic.id}`} label={t('confirm.suspendReason')} required>
                <Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
            </ConfirmDialog>
          );
        }
        return (
          <ConfirmDialog
            key={status}
            tone="danger"
            trigger={<Button size="sm" variant="ghost" className="text-danger hover:bg-danger-bg hover:text-danger">{pending ? t('actions.reject') : t('actions.closed')}</Button>}
            title={pending ? t('confirm.rejectTitle', { name: clinic.name }) : t('confirm.closeTitle', { name: clinic.name })}
            description={pending ? t('confirm.rejectBody') : t('confirm.closeBody')}
            confirmLabel={pending ? t('actions.reject') : t('actions.closed')}
            cancelLabel={t('confirm.keep')}
            onConfirm={() => apply('closed')}
          />
        );
      })}
    </div>
  );
}
