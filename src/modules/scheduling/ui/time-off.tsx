'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { CalendarOff, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { useRouter } from '@/i18n/navigation';
import type { ErrorCode } from '@/shared/lib/errors';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Dialog, DialogContent, DialogTrigger } from '@/shared/ui/dialog';
import { Field, FieldGrid } from '@/shared/ui/field';
import { Input, Select, Textarea } from '@/shared/ui/form-controls';
import { InlineAlert } from '@/shared/ui/states';
import { useToast } from '@/shared/ui/toast';

import { addTimeOff, deleteTimeOff } from '../actions';
import { TIME_OFF_REASONS, timeOffSchema, type TimeOffInput } from '../schemas';

/** Records time off for a doctor, in the clinic's local date and time. Existing appointments stay. */
export function TimeOffDialog({ slug, doctorId, today }: { slug: string; doctorId: string; today: string }) {
  const t = useTranslations();
  const tf = useTranslations('forms.errors');
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const defaults: TimeOffInput = { startsAt: `${today}T08:00`, endsAt: `${today}T18:00`, reason: 'leave', note: '' };
  const form = useForm<TimeOffInput, unknown, z.output<typeof timeOffSchema>>({ resolver: zodResolver(timeOffSchema), defaultValues: defaults, mode: 'onTouched' });
  const err = (name: keyof TimeOffInput) => {
    const m = form.formState.errors[name]?.message;
    return typeof m === 'string' ? tf(m) : undefined;
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          form.reset(defaults);
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary">
          <CalendarOff aria-hidden />
          {t('schedules.addTimeOff')}
        </Button>
      </DialogTrigger>
      <DialogContent
        title={t('schedules.addTimeOffTitle')}
        description={t('schedules.timeOffHint')}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="time-off-form" variant="primary" loading={form.formState.isSubmitting}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <form
          id="time-off-form"
          noValidate
          className="grid gap-4"
          onSubmit={form.handleSubmit(async (values) => {
            setError(null);
            const result = await addTimeOff(slug, doctorId, values);
            if (!result.ok) {
              for (const [field, message] of Object.entries(result.fields ?? {})) form.setError(field as keyof TimeOffInput, { message });
              return setError(result.code);
            }
            toast({ tone: 'success', title: t('schedules.timeOffSaved') });
            setOpen(false);
            router.refresh();
          })}
        >
          <FieldGrid>
            <Field id="to-start" label={t('schedules.timeOffFrom')} required error={err('startsAt')}>
              <Input type="datetime-local" step={300} dir="ltr" {...form.register('startsAt')} />
            </Field>
            <Field id="to-end" label={t('schedules.timeOffTo')} required error={err('endsAt')}>
              <Input type="datetime-local" step={300} dir="ltr" {...form.register('endsAt')} />
            </Field>
            <Field id="to-reason" label={t('schedules.timeOffReason')} required>
              <Select {...form.register('reason')}>
                {TIME_OFF_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {t(`schedules.reason.${r}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </FieldGrid>
          <Field id="to-note" label={t('schedules.timeOffNote')} hint={t('schedules.timeOffNoteHint')} optionalLabel={t('common.optional')} error={err('note')}>
            <Textarea rows={2} {...form.register('note')} />
          </Field>
          {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteTimeOffButton({ slug, timeOffId, label }: { slug: string; timeOffId: string; label: string }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  return (
    <ConfirmDialog
      tone="danger"
      trigger={
        <Button size="icon-sm" variant="ghost" className="text-danger hover:bg-danger-bg hover:text-danger" aria-label={t('schedules.deleteTimeOffLabel', { period: label })}>
          <Trash2 aria-hidden />
        </Button>
      }
      title={t('schedules.deleteTimeOffTitle')}
      description={t('schedules.deleteTimeOffBody', { period: label })}
      confirmLabel={t('schedules.delete')}
      cancelLabel={t('common.cancel')}
      onConfirm={async () => {
        const result = await deleteTimeOff(slug, timeOffId);
        if (!result.ok) return t(`errors.${result.code}`);
        toast({ tone: 'success', title: t('schedules.timeOffDeleted') });
        router.refresh();
      }}
    />
  );
}
