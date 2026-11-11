'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { UserPlus } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm, type FieldErrors } from 'react-hook-form';
import type { z } from 'zod';

import { useRouter } from '@/i18n/navigation';
import type { ErrorCode } from '@/shared/lib/errors';
import { Button } from '@/shared/ui/button';
import { Dialog, DialogContent, DialogTrigger } from '@/shared/ui/dialog';
import { Field, FieldGrid } from '@/shared/ui/field';
import { Checkbox, Input, Select } from '@/shared/ui/form-controls';
import { InlineAlert } from '@/shared/ui/states';
import { useToast } from '@/shared/ui/toast';

import { createPatient } from '../actions';
import { createPatientSchema, type CreatePatientInput } from '../schemas';

const FORM_ID = 'create-patient-form';

/**
 * Patient registration (React Hook Form + Zod, same schema as the Server Action).
 * Grouped in three short sections; errors appear under each field and are announced.
 */
export function CreatePatientDialog({ slug }: { slug: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [serverError, setServerError] = useState<ErrorCode | null>(null);

  const defaults: CreatePatientInput = {
    firstName: '',
    lastName: '',
    firstNameAr: '',
    lastNameAr: '',
    sex: '',
    dateOfBirth: '',
    phone: '',
    preferredLocale: locale === 'ar' ? 'ar' : 'fr',
    preferredChannel: 'sms',
    consentDataProcessing: false as unknown as true,
    consentSmsReminders: false,
  };

  const form = useForm<CreatePatientInput, unknown, z.output<typeof createPatientSchema>>({
    resolver: zodResolver(createPatientSchema),
    defaultValues: defaults,
    mode: 'onTouched',
  });
  const { register, handleSubmit, formState, reset, setError } = form;

  const err = (name: keyof CreatePatientInput, errors: FieldErrors<CreatePatientInput>) => {
    const message = errors[name]?.message;
    return message ? t(`patients.form.errors.${message}`) : undefined;
  };

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    const result = await createPatient(slug, values);
    if (!result.ok) {
      if (result.fields) {
        for (const [name, message] of Object.entries(result.fields)) setError(name as keyof CreatePatientInput, { message });
      }
      setServerError(result.code);
      return;
    }
    toast({ tone: 'success', title: t('patients.createdDone', { fileNumber: result.data.fileNumber }) });
    setOpen(false);
    reset(defaults);
    router.refresh();
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          reset(defaults);
          setServerError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="primary">
          <UserPlus aria-hidden />
          {t('patients.new')}
        </Button>
      </DialogTrigger>
      <DialogContent
        size="lg"
        title={t('patients.form.title')}
        description={t('patients.form.description')}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={formState.isSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form={FORM_ID} variant="primary" loading={formState.isSubmitting}>
              {t('patients.form.submit')}
            </Button>
          </>
        }
      >
        <form id={FORM_ID} noValidate onSubmit={onSubmit} className="grid gap-6">
          <fieldset className="grid gap-4">
            <legend className="mb-3 text-small font-semibold text-ink">{t('patients.form.identity')}</legend>
            <FieldGrid>
              <Field id="p-first" label={t('patients.form.firstName')} required error={err('firstName', formState.errors)}>
                <Input autoComplete="off" {...register('firstName')} />
              </Field>
              <Field id="p-last" label={t('patients.form.lastName')} required error={err('lastName', formState.errors)}>
                <Input autoComplete="off" {...register('lastName')} />
              </Field>
              <Field id="p-first-ar" label={t('patients.form.firstNameAr')} optionalLabel={t('common.optional')} error={err('firstNameAr', formState.errors)}>
                <Input dir="rtl" lang="ar" autoComplete="off" {...register('firstNameAr')} />
              </Field>
              <Field id="p-last-ar" label={t('patients.form.lastNameAr')} optionalLabel={t('common.optional')} error={err('lastNameAr', formState.errors)}>
                <Input dir="rtl" lang="ar" autoComplete="off" {...register('lastNameAr')} />
              </Field>
              <Field id="p-sex" label={t('patients.form.sex')} optionalLabel={t('common.optional')}>
                <Select {...register('sex')}>
                  <option value="">{t('patients.form.sexUnset')}</option>
                  <option value="female">{t('patients.form.sexFemale')}</option>
                  <option value="male">{t('patients.form.sexMale')}</option>
                </Select>
              </Field>
              <Field id="p-dob" label={t('patients.form.dateOfBirth')} optionalLabel={t('common.optional')} error={err('dateOfBirth', formState.errors)}>
                <Input type="date" className="tabular" max={new Date().toISOString().slice(0, 10)} {...register('dateOfBirth')} />
              </Field>
            </FieldGrid>
          </fieldset>

          <fieldset className="grid gap-4 border-t border-line pt-5">
            <legend className="float-start mb-3 w-full text-small font-semibold text-ink">{t('patients.form.contact')}</legend>
            <FieldGrid>
              <Field id="p-phone" label={t('patients.form.phone')} hint={t('patients.form.phoneHint')} error={err('phone', formState.errors)}>
                <Input type="tel" dir="ltr" inputMode="tel" autoComplete="off" placeholder="06 12 34 56 78" className="text-start" {...register('phone')} />
              </Field>
              <Field id="p-channel" label={t('patients.form.channel')}>
                <Select {...register('preferredChannel')}>
                  <option value="sms">{t('patients.form.channelSms')}</option>
                  <option value="email">{t('patients.form.channelEmail')}</option>
                  <option value="none">{t('patients.form.channelNone')}</option>
                </Select>
              </Field>
              <Field id="p-locale" label={t('patients.form.preferredLocale')}>
                <Select {...register('preferredLocale')}>
                  <option value="fr">Français</option>
                  <option value="ar">العربية</option>
                </Select>
              </Field>
            </FieldGrid>
          </fieldset>

          <fieldset className="grid gap-3 border-t border-line pt-5">
            <legend className="float-start mb-3 w-full text-small font-semibold text-ink">{t('patients.form.consents')}</legend>
            <div className="grid gap-1">
              <Checkbox label={t('patients.form.consentData')} aria-invalid={formState.errors.consentDataProcessing ? true : undefined} {...register('consentDataProcessing')} />
              {formState.errors.consentDataProcessing ? (
                <p role="alert" className="ps-6.5 text-small text-danger">
                  {t('patients.form.errors.consentRequired')}
                </p>
              ) : null}
            </div>
            <Checkbox label={t('patients.form.consentSms')} {...register('consentSmsReminders')} />
          </fieldset>

          {serverError ? <InlineAlert tone="danger">{t(`errors.${serverError}`)}</InlineAlert> : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
