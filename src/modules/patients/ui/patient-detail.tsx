'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Archive, ArchiveRestore, GitMerge, Pencil } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { useRouter } from '@/i18n/navigation';
import type { ErrorCode } from '@/shared/lib/errors';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Dialog, DialogContent, DialogTrigger } from '@/shared/ui/dialog';
import { Field, FieldGrid } from '@/shared/ui/field';
import { Input, Select } from '@/shared/ui/form-controls';
import { InlineAlert } from '@/shared/ui/states';
import { useToast } from '@/shared/ui/toast';

import { mergePatients, recordConsent, setPatientArchived, updatePatient } from '../actions';
import { updatePatientSchema, type UpdatePatientInput } from '../schemas';

export function EditPatientDialog({ patientId, values }: { patientId: string; values: UpdatePatientInput }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const form = useForm<UpdatePatientInput, unknown, z.output<typeof updatePatientSchema>>({
    resolver: zodResolver(updatePatientSchema),
    defaultValues: values,
    mode: 'onTouched',
  });
  const err = (name: keyof UpdatePatientInput) => {
    const m = form.formState.errors[name]?.message;
    return typeof m === 'string' ? t(`patients.form.errors.${m}`) : undefined;
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          form.reset(values);
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Pencil aria-hidden />
          {t('patientDetail.edit')}
        </Button>
      </DialogTrigger>
      <DialogContent
        size="lg"
        title={t('patientDetail.editTitle')}
        description={t('patients.form.description')}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="edit-patient" variant="primary" loading={form.formState.isSubmitting}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <form
          id="edit-patient"
          noValidate
          className="grid gap-4"
          onSubmit={form.handleSubmit(async (v) => {
            setError(null);
            const result = await updatePatient(patientId, v);
            if (!result.ok) return setError(result.code);
            toast({ tone: 'success', title: t('patientDetail.saved') });
            setOpen(false);
            router.refresh();
          })}
        >
          <FieldGrid>
            <Field id="ep-first" label={t('patients.form.firstName')} required error={err('firstName')}>
              <Input {...form.register('firstName')} />
            </Field>
            <Field id="ep-last" label={t('patients.form.lastName')} required error={err('lastName')}>
              <Input {...form.register('lastName')} />
            </Field>
            <Field id="ep-first-ar" label={t('patients.form.firstNameAr')} optionalLabel={t('common.optional')} error={err('firstNameAr')}>
              <Input dir="rtl" lang="ar" {...form.register('firstNameAr')} />
            </Field>
            <Field id="ep-last-ar" label={t('patients.form.lastNameAr')} optionalLabel={t('common.optional')} error={err('lastNameAr')}>
              <Input dir="rtl" lang="ar" {...form.register('lastNameAr')} />
            </Field>
            <Field id="ep-sex" label={t('patients.form.sex')} optionalLabel={t('common.optional')}>
              <Select {...form.register('sex')}>
                <option value="">{t('patients.form.sexUnset')}</option>
                <option value="female">{t('patients.form.sexFemale')}</option>
                <option value="male">{t('patients.form.sexMale')}</option>
              </Select>
            </Field>
            <Field id="ep-dob" label={t('patients.form.dateOfBirth')} optionalLabel={t('common.optional')} error={err('dateOfBirth')}>
              <Input type="date" className="tabular" {...form.register('dateOfBirth')} />
            </Field>
            <Field id="ep-phone" label={t('patients.form.phone')} hint={t('patients.form.phoneHint')} error={err('phone')}>
              <Input type="tel" dir="ltr" className="text-start" {...form.register('phone')} />
            </Field>
            <Field id="ep-channel" label={t('patients.form.channel')}>
              <Select {...form.register('preferredChannel')}>
                <option value="sms">{t('patients.form.channelSms')}</option>
                <option value="email">{t('patients.form.channelEmail')}</option>
                <option value="none">{t('patients.form.channelNone')}</option>
              </Select>
            </Field>
            <Field id="ep-locale" label={t('patients.form.preferredLocale')}>
              <Select {...form.register('preferredLocale')}>
                <option value="fr">Français</option>
                <option value="ar">العربية</option>
              </Select>
            </Field>
          </FieldGrid>
          {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Records a new consent decision; withdrawing asks for confirmation. History is kept. */
export function ConsentToggle({ slug, patientId, purpose, granted }: { slug: string; patientId: string; purpose: string; granted: boolean | null }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const label = t(`patientDetail.consentPurpose.${purpose}`);

  if (granted) {
    return (
      <ConfirmDialog
        trigger={<Button size="sm" variant="ghost">{t('patientDetail.withdraw')}</Button>}
        title={t('patientDetail.withdrawTitle')}
        description={t('patientDetail.withdrawBody', { purpose: label })}
        confirmLabel={t('patientDetail.withdraw')}
        cancelLabel={t('common.cancel')}
        onConfirm={async () => {
          const result = await recordConsent(slug, patientId, purpose, false);
          if (!result.ok) return t(`errors.${result.code}`);
          toast({ tone: 'success', title: t('patientDetail.consentSaved') });
          router.refresh();
        }}
      />
    );
  }
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await recordConsent(slug, patientId, purpose, true);
          toast(result.ok ? { tone: 'success', title: t('patientDetail.consentSaved') } : { tone: 'danger', title: t(`errors.${result.code}`) });
          router.refresh();
        })
      }
    >
      {t('patientDetail.grant')}
    </Button>
  );
}

export function ArchiveButton({ patientId, archived }: { patientId: string; archived: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  return (
    <ConfirmDialog
      tone={archived ? 'default' : 'danger'}
      trigger={
        <Button variant="ghost">
          {archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
          {archived ? t('patientDetail.unarchive') : t('patientDetail.archive')}
        </Button>
      }
      title={archived ? t('patientDetail.unarchiveTitle') : t('patientDetail.archiveTitle')}
      description={archived ? t('patientDetail.unarchiveBody') : t('patientDetail.archiveBody')}
      confirmLabel={archived ? t('patientDetail.unarchive') : t('patientDetail.archive')}
      cancelLabel={t('common.cancel')}
      onConfirm={async () => {
        const result = await setPatientArchived(patientId, !archived);
        if (!result.ok) return t(`errors.${result.code}`);
        toast({ tone: 'success', title: t('patientDetail.saved') });
        router.refresh();
      }}
    />
  );
}

/** Merges a duplicate INTO the record being viewed (the viewed record survives). */
export function MergeButton({ sourceId, sourceLabel, targetId, targetLabel }: { sourceId: string; sourceLabel: string; targetId: string; targetLabel: string }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  return (
    <ConfirmDialog
      tone="danger"
      trigger={
        <Button size="sm" variant="ghost">
          <GitMerge aria-hidden />
          {t('patientDetail.merge')}
        </Button>
      }
      title={t('patientDetail.mergeTitle')}
      description={t('patientDetail.mergeBody', { source: sourceLabel, target: targetLabel })}
      confirmLabel={t('patientDetail.merge')}
      cancelLabel={t('common.cancel')}
      onConfirm={async () => {
        const result = await mergePatients(sourceId, targetId);
        if (!result.ok) return t(`errors.${result.code}`);
        toast({ tone: 'success', title: t('patientDetail.merged') });
        router.refresh();
      }}
    />
  );
}
