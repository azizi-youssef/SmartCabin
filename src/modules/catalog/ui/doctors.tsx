'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Pencil, Plus, Stethoscope } from 'lucide-react';
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

import { countFutureAppointments, createDoctor, saveDoctorServices, setDoctorActive, updateDoctor } from '../actions';
import { localizedName } from '../names';
import { doctorSchema, type DoctorInput } from '../schemas';

export interface SpecialtyOption {
  id: string;
  nameFr: string;
  nameAr: string;
}
export interface MemberOption {
  userId: string;
  label: string;
}
export interface DoctorFormValues {
  id?: string;
  fullName: string;
  fullNameAr: string | null;
  specialtyId: string | null;
  inpe: string | null;
  phone: string | null;
  userId: string | null;
  onlineBookable: boolean;
}

/** Create or edit a practitioner record. A login link is optional (doctors without an account are allowed). */
export function DoctorDialog({
  slug,
  doctor,
  specialties,
  members,
}: {
  slug: string;
  doctor?: DoctorFormValues;
  specialties: SpecialtyOption[];
  members: MemberOption[];
}) {
  const t = useTranslations();
  const tf = useTranslations('forms.errors');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const defaults: DoctorInput = {
    fullName: doctor?.fullName ?? '',
    fullNameAr: doctor?.fullNameAr ?? '',
    specialtyId: doctor?.specialtyId ?? '',
    inpe: doctor?.inpe ?? '',
    phone: doctor?.phone ?? '',
    userId: doctor?.userId ?? '',
    onlineBookable: doctor?.onlineBookable ?? false,
  };
  const form = useForm<DoctorInput, unknown, z.output<typeof doctorSchema>>({ resolver: zodResolver(doctorSchema), defaultValues: defaults, mode: 'onTouched' });
  const err = (name: keyof DoctorInput) => {
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
        {doctor ? (
          <Button size="sm" variant="ghost">
            <Pencil aria-hidden />
            <span className="sr-only xl:not-sr-only">{t('doctors.edit')}</span>
          </Button>
        ) : (
          <Button variant="primary">
            <Plus aria-hidden />
            {t('doctors.add')}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        title={doctor ? t('doctors.editTitle', { name: doctor.fullName }) : t('doctors.addTitle')}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="doctor-form" variant="primary" loading={form.formState.isSubmitting}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <form
          id="doctor-form"
          noValidate
          className="grid gap-4"
          onSubmit={form.handleSubmit(async (values) => {
            setError(null);
            const result = doctor?.id ? await updateDoctor(slug, doctor.id, values) : await createDoctor(slug, values);
            if (!result.ok) {
              for (const [field, message] of Object.entries(result.fields ?? {})) form.setError(field as keyof DoctorInput, { message });
              return setError(result.code);
            }
            toast({ tone: 'success', title: t('doctors.saved') });
            setOpen(false);
            router.refresh();
          })}
        >
          <FieldGrid>
            <Field id="dr-name" label={t('doctors.fullName')} required error={err('fullName')}>
              <Input {...form.register('fullName')} />
            </Field>
            <Field id="dr-name-ar" label={t('doctors.fullNameAr')} optionalLabel={t('common.optional')} error={err('fullNameAr')}>
              <Input dir="rtl" lang="ar" {...form.register('fullNameAr')} />
            </Field>
            <Field id="dr-specialty" label={t('doctors.specialty')} optionalLabel={t('common.optional')}>
              <Select {...form.register('specialtyId')}>
                <option value="">{t('common.selectPlaceholder')}</option>
                {specialties.map((s) => (
                  <option key={s.id} value={s.id}>
                    {localizedName(locale, s.nameFr, s.nameAr)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="dr-account" label={t('doctors.account')} hint={t('doctors.accountHint')}>
              <Select {...form.register('userId')}>
                <option value="">{t('doctors.noAccount')}</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="dr-phone" label={t('doctors.phone')} optionalLabel={t('common.optional')} error={err('phone')}>
              <Input type="tel" dir="ltr" className="text-start" {...form.register('phone')} />
            </Field>
            <Field id="dr-inpe" label={t('doctors.inpe')} hint={t('doctors.inpeHint')} optionalLabel={t('common.optional')} error={err('inpe')}>
              <Input dir="ltr" className="text-start" {...form.register('inpe')} />
            </Field>
          </FieldGrid>
          <Checkbox label={t('doctors.onlineBookable')} description={t('doctors.onlineBookableHint')} {...form.register('onlineBookable')} />
          {error ? <InlineAlert tone="danger">{error === 'DUPLICATE' ? t('doctors.accountTaken') : t(`errors.${error}`)}</InlineAlert> : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}

export interface ServiceOffer {
  serviceId: string;
  name: string;
  defaultDuration: number;
  defaultPrice: string;
  offered: boolean;
  durationMinutes: number | null;
  priceMad: string | null;
  onlineBookable: boolean;
}

/** Which services this doctor provides, with optional duration/price overrides. Saved atomically. */
export function DoctorServicesDialog({ doctorId, doctorName, offers }: { doctorId: string; doctorName: string; offers: ServiceOffer[] }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(offers);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [pending, setPending] = useState(false);
  const update = (id: string, patch: Partial<ServiceOffer>) => setRows((current) => current.map((r) => (r.serviceId === id ? { ...r, ...patch } : r)));
  const count = offers.filter((o) => o.offered).length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setRows(offers);
        setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          <Stethoscope aria-hidden />
          {t('doctors.servicesCount', { count })}
        </Button>
      </DialogTrigger>
      <DialogContent
        size="lg"
        title={t('doctors.servicesTitle', { name: doctorName })}
        description={t('doctors.servicesHint')}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={pending}
              onClick={async () => {
                setPending(true);
                setError(null);
                const result = await saveDoctorServices(
                  doctorId,
                  rows
                    .filter((r) => r.offered)
                    .map((r) => ({
                      serviceId: r.serviceId,
                      durationMinutes: r.durationMinutes ?? '',
                      priceMad: r.priceMad ?? '',
                      onlineBookable: r.onlineBookable,
                    })),
                );
                setPending(false);
                if (!result.ok) return setError(result.code);
                toast({ tone: 'success', title: t('doctors.saved') });
                setOpen(false);
                router.refresh();
              }}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        {rows.length === 0 ? (
          <p className="text-body text-ink-muted">{t('doctors.noServices')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-body">
              <thead>
                <tr className="border-b border-line text-caption text-ink-muted">
                  <th scope="col" className="py-2 pe-3 text-start font-medium">{t('columns.service')}</th>
                  <th scope="col" className="w-28 px-2 py-2 text-start font-medium">{t('doctors.duration')}</th>
                  <th scope="col" className="w-32 px-2 py-2 text-start font-medium">{t('doctors.price')}</th>
                  <th scope="col" className="w-24 ps-2 py-2 text-start font-medium">{t('doctors.online')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.serviceId} className="border-b border-line last:border-b-0">
                    <td className="py-2 pe-3">
                      <Checkbox label={r.name} checked={r.offered} onChange={(e) => update(r.serviceId, { offered: e.target.checked })} />
                    </td>
                    <td className="px-2 py-2">
                      <Input
                        type="number"
                        step={5}
                        min={5}
                        max={480}
                        aria-label={`${t('doctors.duration')} — ${r.name}`}
                        placeholder={String(r.defaultDuration)}
                        disabled={!r.offered}
                        className="tabular"
                        value={r.durationMinutes ?? ''}
                        onChange={(e) => update(r.serviceId, { durationMinutes: e.target.value ? Number(e.target.value) : null })}
                      />
                    </td>
                    <td className="px-2 py-2">
                      <Input
                        inputMode="decimal"
                        aria-label={`${t('doctors.price')} — ${r.name}`}
                        placeholder={r.defaultPrice}
                        disabled={!r.offered}
                        className="tabular"
                        value={r.priceMad ?? ''}
                        onChange={(e) => update(r.serviceId, { priceMad: e.target.value || null })}
                      />
                    </td>
                    <td className="ps-2 py-2">
                      <input
                        type="checkbox"
                        aria-label={`${t('doctors.online')} — ${r.name}`}
                        className="focus-ring size-4 accent-[var(--sc-teal-600)]"
                        disabled={!r.offered}
                        checked={r.onlineBookable}
                        onChange={(e) => update(r.serviceId, { onlineBookable: e.target.checked })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-small text-ink-muted">{t('doctors.overrideHint')}</p>
          </div>
        )}
        {error ? <InlineAlert tone="danger" className="mt-3">{t(`errors.${error}`)}</InlineAlert> : null}
      </DialogContent>
    </Dialog>
  );
}

/** Deactivation shows how many future appointments stay booked (they are not cancelled). */
export function DoctorStatusButton({ slug, doctorId, name, active }: { slug: string; doctorId: string; name: string; active: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const [future, setFuture] = useState<number | null>(null);

  if (!active) {
    return (
      <ConfirmDialog
        trigger={<Button size="sm" variant="ghost">{t('doctors.reactivate')}</Button>}
        title={t('doctors.reactivateTitle', { name })}
        description={t('doctors.reactivateBody')}
        confirmLabel={t('doctors.reactivate')}
        cancelLabel={t('common.cancel')}
        onConfirm={async () => {
          const result = await setDoctorActive(slug, doctorId, true);
          if (!result.ok) return t(`errors.${result.code}`);
          toast({ tone: 'success', title: t('doctors.saved') });
          router.refresh();
        }}
      />
    );
  }
  return (
    <ConfirmDialog
      tone="danger"
      trigger={<Button size="sm" variant="ghost" className="text-danger hover:bg-danger-bg hover:text-danger">{t('doctors.deactivate')}</Button>}
      title={t('doctors.deactivateTitle', { name })}
      description={
        future === null ? t('doctors.deactivateBody') : t('doctors.deactivateBodyCount', { count: future })
      }
      confirmLabel={t('doctors.deactivate')}
      cancelLabel={t('common.cancel')}
      onOpenChange={async (open) => {
        if (!open) return setFuture(null);
        const result = await countFutureAppointments(doctorId);
        if (result.ok) setFuture(result.data);
      }}
      onConfirm={async () => {
        const result = await setDoctorActive(slug, doctorId, false);
        if (!result.ok) return t(`errors.${result.code}`);
        toast({ tone: 'success', title: t('doctors.deactivated') });
        router.refresh();
      }}
    />
  );
}
