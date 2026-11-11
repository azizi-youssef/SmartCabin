'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Pencil, Plus } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { useRouter } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import type { ErrorCode } from '@/shared/lib/errors';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Dialog, DialogContent, DialogTrigger } from '@/shared/ui/dialog';
import { Field, FieldGrid } from '@/shared/ui/field';
import { Checkbox, Input, Select } from '@/shared/ui/form-controls';
import { InlineAlert } from '@/shared/ui/states';
import { useToast } from '@/shared/ui/toast';

import { createService, setServiceArchived, updateService } from '../actions';
import { localizedName } from '../names';
import { serviceSchema, type ServiceInput } from '../schemas';
import type { SpecialtyOption } from './doctors';

export interface ServiceFormValues {
  id?: string;
  nameFr: string | null;
  nameAr: string | null;
  specialtyId: string | null;
  durationMinutes: number;
  priceMad: string;
  onlineBookable: boolean;
}

/**
 * Create or edit a clinic service: bilingual name, default duration (5-minute steps) and price in
 * MAD. A doctor may override duration and price for the services they offer (doctors page).
 */
export function ServiceDialog({ slug, service, specialties }: { slug: string; service?: ServiceFormValues; specialties: SpecialtyOption[] }) {
  const t = useTranslations();
  const tf = useTranslations('forms.errors');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const defaults: ServiceInput = {
    nameFr: service?.nameFr ?? '',
    nameAr: service?.nameAr ?? '',
    specialtyId: service?.specialtyId ?? '',
    durationMinutes: service?.durationMinutes ?? 20,
    priceMad: service?.priceMad ?? '',
    onlineBookable: service?.onlineBookable ?? false,
  };
  const form = useForm<ServiceInput, unknown, z.output<typeof serviceSchema>>({ resolver: zodResolver(serviceSchema), defaultValues: defaults, mode: 'onTouched' });
  const err = (name: keyof ServiceInput) => {
    const m = form.formState.errors[name]?.message;
    return typeof m === 'string' ? tf(m) : undefined;
  };
  const label = service ? localizedName(locale, service.nameFr, service.nameAr) : '';

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
        {service ? (
          <Button size="sm" variant="ghost">
            <Pencil aria-hidden />
            <span className="sr-only xl:not-sr-only">{t('services.edit')}</span>
            <span className="sr-only xl:hidden"> {label}</span>
          </Button>
        ) : (
          <Button variant="primary">
            <Plus aria-hidden />
            {t('services.add')}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        title={service ? t('services.editTitle', { name: label }) : t('services.addTitle')}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="service-form" variant="primary" loading={form.formState.isSubmitting}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <form
          id="service-form"
          noValidate
          className="grid gap-4"
          onSubmit={form.handleSubmit(async (values) => {
            setError(null);
            const result = service?.id ? await updateService(slug, service.id, values) : await createService(slug, values);
            if (!result.ok) {
              for (const [field, message] of Object.entries(result.fields ?? {})) form.setError(field as keyof ServiceInput, { message });
              return setError(result.code);
            }
            toast({ tone: 'success', title: t('services.saved') });
            setOpen(false);
            router.refresh();
          })}
        >
          <FieldGrid>
            <Field id="sv-name-fr" label={t('services.nameFr')} hint={t('services.nameHint')} error={err('nameFr')}>
              <Input lang="fr" dir="ltr" {...form.register('nameFr')} />
            </Field>
            <Field id="sv-name-ar" label={t('services.nameAr')} error={err('nameAr')}>
              <Input lang="ar" dir="rtl" {...form.register('nameAr')} />
            </Field>
            <Field id="sv-duration" label={t('services.duration')} hint={t('services.durationHint')} required error={err('durationMinutes')}>
              <Input type="number" inputMode="numeric" min={5} max={480} step={5} dir="ltr" className="text-start" {...form.register('durationMinutes')} />
            </Field>
            <Field id="sv-price" label={t('services.price')} hint={t('services.priceHint')} required error={err('priceMad')}>
              <Input inputMode="decimal" dir="ltr" className="text-start" {...form.register('priceMad')} />
            </Field>
            <Field id="sv-specialty" label={t('doctors.specialty')} optionalLabel={t('common.optional')}>
              <Select {...form.register('specialtyId')}>
                <option value="">{t('common.selectPlaceholder')}</option>
                {specialties.map((s) => (
                  <option key={s.id} value={s.id}>
                    {localizedName(locale, s.nameFr, s.nameAr)}
                  </option>
                ))}
              </Select>
            </Field>
          </FieldGrid>
          <Checkbox label={t('services.onlineBookable')} description={t('services.onlineBookableHint')} {...form.register('onlineBookable')} />
          {error ? <InlineAlert tone="danger">{error === 'DUPLICATE' ? t('services.duplicate') : t(`errors.${error}`)}</InlineAlert> : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Archive (never delete: past appointments and invoices reference services) or restore. */
export function ServiceArchiveButton({ slug, serviceId, name, active }: { slug: string; serviceId: string; name: string; active: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  return (
    <ConfirmDialog
      tone={active ? 'danger' : 'default'}
      trigger={
        <Button size="sm" variant="ghost" className={active ? 'text-danger hover:bg-danger-bg hover:text-danger' : undefined}>
          {active ? t('services.archive') : t('services.restore')}
          <span className="sr-only"> {name}</span>
        </Button>
      }
      title={active ? t('services.archiveTitle', { name }) : t('services.restoreTitle', { name })}
      description={active ? t('services.archiveBody') : t('services.restoreBody')}
      confirmLabel={active ? t('services.archive') : t('services.restore')}
      cancelLabel={t('common.cancel')}
      onConfirm={async () => {
        const result = await setServiceArchived(slug, serviceId, active);
        if (!result.ok) return t(`errors.${result.code}`);
        toast({ tone: 'success', title: t('services.saved') });
        router.refresh();
      }}
    />
  );
}
