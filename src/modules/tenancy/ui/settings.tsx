'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { CalendarOff, ShieldCheck, Trash2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { useForm, type FieldErrors } from 'react-hook-form';
import type { z } from 'zod';

import { useRouter } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import type { ErrorCode } from '@/shared/lib/errors';
import { formatLocalDay } from '@/shared/lib/format';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Field, FieldGrid } from '@/shared/ui/field';
import { Checkbox, Input, Select } from '@/shared/ui/form-controls';
import { EmptyState, InlineAlert } from '@/shared/ui/states';
import { useToast } from '@/shared/ui/toast';

import type { BookingPolicy, ClinicProfile, Closure } from '../queries';
import {
  bookingPolicySchema,
  clinicProfileSchema,
  closureSchema,
  type BookingPolicyInput,
  type ClinicProfileInput,
  type ClosureInput,
} from '../schemas';
import { acceptClinicDpa, addClosure, removeClosure, updateBookingPolicy, updateClinicProfile } from '../settings-actions';

function useFieldError(errors: FieldErrors) {
  const tf = useTranslations('forms.errors');
  return (name: string) => {
    const message = errors[name]?.message;
    return typeof message === 'string' ? tf(message) : undefined;
  };
}

function SaveBar({ pending, dirty, error }: { pending: boolean; dirty: boolean; error: ErrorCode | null }) {
  const t = useTranslations();
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-4">
      {error ? <InlineAlert tone="danger" className="me-auto">{t(`errors.${error}`)}</InlineAlert> : null}
      <Button type="submit" variant="primary" loading={pending} disabled={!dirty}>
        {t('common.save')}
      </Button>
    </div>
  );
}

export function ClinicProfileForm({ slug, profile, disabled }: { slug: string; profile: ClinicProfile; disabled: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<ErrorCode | null>(null);
  const defaults: ClinicProfileInput = {
    displayName: profile.displayName,
    legalName: profile.legalName ?? '',
    city: profile.city,
    addressLine: profile.addressLine ?? '',
    phone: profile.phone ?? '',
    email: profile.email ?? '',
    ice: profile.ice ?? '',
    defaultLocale: profile.defaultLocale,
  };
  const form = useForm<ClinicProfileInput, unknown, z.output<typeof clinicProfileSchema>>({ resolver: zodResolver(clinicProfileSchema), defaultValues: defaults, mode: 'onTouched' });
  const err = useFieldError(form.formState.errors);

  return (
    <form
      noValidate
      className="grid gap-4 rounded-lg border border-line bg-surface p-5"
      onSubmit={form.handleSubmit(async (values) => {
        setError(null);
        const result = await updateClinicProfile(slug, values);
        if (!result.ok) return setError(result.code);
        toast({ tone: 'success', title: t('settings.saved') });
        form.reset(values);
        router.refresh();
      })}
    >
      <fieldset disabled={disabled} className="grid gap-4">
        <FieldGrid>
          <Field id="cp-name" label={t('settings.profile.displayName')} required error={err('displayName')}>
            <Input {...form.register('displayName')} />
          </Field>
          <Field id="cp-legal" label={t('settings.profile.legalName')} optionalLabel={t('common.optional')} error={err('legalName')}>
            <Input {...form.register('legalName')} />
          </Field>
          <Field id="cp-city" label={t('onboarding.city')} required error={err('city')}>
            <Input {...form.register('city')} />
          </Field>
          <Field id="cp-address" label={t('settings.profile.address')} optionalLabel={t('common.optional')} error={err('addressLine')}>
            <Input {...form.register('addressLine')} />
          </Field>
          <Field id="cp-phone" label={t('onboarding.phone')} optionalLabel={t('common.optional')} error={err('phone')}>
            <Input type="tel" dir="ltr" className="text-start" {...form.register('phone')} />
          </Field>
          <Field id="cp-email" label={t('auth.email')} optionalLabel={t('common.optional')} error={err('email')}>
            <Input type="email" dir="ltr" className="text-start" {...form.register('email')} />
          </Field>
          <Field id="cp-ice" label={t('settings.profile.ice')} hint={t('settings.profile.iceHint')} optionalLabel={t('common.optional')} error={err('ice')}>
            <Input dir="ltr" inputMode="numeric" className="text-start tabular" {...form.register('ice')} />
          </Field>
          <Field id="cp-locale" label={t('onboarding.defaultLocale')}>
            <Select {...form.register('defaultLocale')}>
              <option value="fr">Français</option>
              <option value="ar">العربية</option>
            </Select>
          </Field>
        </FieldGrid>
      </fieldset>
      {!disabled ? <SaveBar pending={form.formState.isSubmitting} dirty={form.formState.isDirty} error={error} /> : null}
    </form>
  );
}

export function BookingPolicyForm({ slug, policy, disabled }: { slug: string; policy: BookingPolicy; disabled: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<ErrorCode | null>(null);
  const defaults: BookingPolicyInput = { ...policy, smsSenderName: policy.smsSenderName ?? '' };
  const form = useForm<BookingPolicyInput, unknown, z.output<typeof bookingPolicySchema>>({ resolver: zodResolver(bookingPolicySchema), defaultValues: defaults, mode: 'onTouched' });
  const err = useFieldError(form.formState.errors);
  const number = (name: keyof BookingPolicyInput, label: string, hint?: string) => (
    <Field id={`bp-${name}`} label={label} hint={hint} error={err(name)}>
      <Input type="number" inputMode="numeric" className="tabular" {...form.register(name)} />
    </Field>
  );

  return (
    <form
      noValidate
      className="grid gap-4 rounded-lg border border-line bg-surface p-5"
      onSubmit={form.handleSubmit(async (values) => {
        setError(null);
        const result = await updateBookingPolicy(slug, values);
        if (!result.ok) return setError(result.code);
        toast({ tone: 'success', title: t('settings.saved') });
        form.reset(values);
        router.refresh();
      })}
    >
      <fieldset disabled={disabled} className="grid gap-5">
        <div className="grid gap-3">
          <Checkbox label={t('settings.policy.onlineBooking')} description={t('settings.policy.onlineBookingHint')} {...form.register('onlineBookingEnabled')} />
          <Checkbox label={t('settings.policy.autoConfirm')} description={t('settings.policy.autoConfirmHint')} {...form.register('autoConfirmOnline')} />
          <Checkbox label={t('settings.policy.directory')} description={t('settings.policy.directoryHint')} {...form.register('listedInDirectory')} />
        </div>
        <FieldGrid className="lg:grid-cols-3">
          {number('minLeadMinutes', t('settings.policy.minLead'))}
          {number('maxHorizonDays', t('settings.policy.horizon'))}
          {number('patientCancelCutoffHours', t('settings.policy.cancelCutoff'))}
          {number('maxActiveOnlineBookings', t('settings.policy.maxActive'))}
          {number('reminderHoursBefore', t('settings.policy.reminder'))}
          {number('checkinGraceMinutes', t('settings.policy.grace'), t('settings.policy.graceHint'))}
          {number('turnApproachingPositions', t('settings.policy.turnApproaching'))}
          <Field id="bp-sender" label={t('settings.policy.sender')} hint={t('settings.policy.senderHint')} optionalLabel={t('common.optional')} error={err('smsSenderName')}>
            <Input dir="ltr" className="text-start" maxLength={11} {...form.register('smsSenderName')} />
          </Field>
        </FieldGrid>
      </fieldset>
      {!disabled ? <SaveBar pending={form.formState.isSubmitting} dirty={form.formState.isDirty} error={error} /> : null}
    </form>
  );
}

export function ClosuresManager({ slug, closures, canManage }: { slug: string; closures: Closure[]; canManage: boolean }) {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<ErrorCode | null>(null);
  const form = useForm<ClosureInput, unknown, z.output<typeof closureSchema>>({ resolver: zodResolver(closureSchema), defaultValues: { from: '', to: '', reason: '' } });
  const err = useFieldError(form.formState.errors);
  const [, startTransition] = useTransition();

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      {closures.length === 0 ? (
        <EmptyState icon={CalendarOff} title={t('settings.closures.empty')} description={t('settings.closures.emptyHint')} />
      ) : (
        <ul className="divide-y divide-line">
          {closures.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <span className="grid leading-tight">
                <span className="font-medium text-ink">{c.reason}</span>
                <span className="text-small text-ink-muted">
                  {c.from === c.to ? formatLocalDay(locale, c.from) : `${formatLocalDay(locale, c.from, 'short')} → ${formatLocalDay(locale, c.to, 'short')}`}
                </span>
              </span>
              {canManage ? (
                <ConfirmDialog
                  tone="danger"
                  trigger={
                    <Button size="icon-sm" variant="ghost" aria-label={t('settings.closures.remove', { reason: c.reason })}>
                      <Trash2 aria-hidden />
                    </Button>
                  }
                  title={t('settings.closures.removeTitle')}
                  description={t('settings.closures.removeBody', { reason: c.reason })}
                  confirmLabel={t('settings.closures.removeConfirm')}
                  cancelLabel={t('common.cancel')}
                  onConfirm={async () => {
                    const result = await removeClosure(slug, c.id);
                    if (!result.ok) return t(`errors.${result.code}`);
                    toast({ tone: 'success', title: t('settings.saved') });
                    startTransition(() => router.refresh());
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <form
          noValidate
          className="grid gap-3 border-t border-line bg-surface-muted p-4"
          onSubmit={form.handleSubmit(async (values) => {
            setError(null);
            const result = await addClosure(slug, values);
            if (!result.ok) return setError(result.code);
            toast({ tone: 'success', title: t('settings.closures.added') });
            form.reset();
            router.refresh();
          })}
        >
          <div className="grid gap-3 sm:grid-cols-[10rem_10rem_minmax(0,1fr)_auto] sm:items-end">
            <Field id="cl-from" label={t('settings.closures.from')} required error={err('from')}>
              <Input type="date" className="tabular" {...form.register('from')} />
            </Field>
            <Field id="cl-to" label={t('settings.closures.to')} required error={err('to')}>
              <Input type="date" className="tabular" {...form.register('to')} />
            </Field>
            <Field id="cl-reason" label={t('settings.closures.reason')} required error={err('reason')}>
              <Input placeholder={t('settings.closures.reasonPlaceholder')} {...form.register('reason')} />
            </Field>
            <Button type="submit" variant="secondary" loading={form.formState.isSubmitting}>
              {t('settings.closures.add')}
            </Button>
          </div>
          <p className="text-small text-ink-muted">{t('settings.closures.note')}</p>
          {error ? <InlineAlert tone="danger">{error === 'DUPLICATE' ? t('settings.closures.overlap') : t(`errors.${error}`)}</InlineAlert> : null}
        </form>
      ) : null}
    </div>
  );
}

export function DpaPanel({ slug, status, canAccept }: { slug: string; status: { version: string; acceptedAt: string | null }; canAccept: boolean }) {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const router = useRouter();
  const toast = useToast();
  if (status.acceptedAt) {
    return (
      <InlineAlert tone="success" title={t('settings.dpa.accepted')}>
        {t('settings.dpa.acceptedOn', { version: status.version, date: formatLocalDay(locale, status.acceptedAt.slice(0, 10), 'short') })}
      </InlineAlert>
    );
  }
  return (
    <div className="grid gap-3 rounded-lg border border-warning-line bg-warning-bg p-4">
      <p className="flex items-start gap-2 text-body text-ink">
        <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        {t('settings.dpa.required', { version: status.version })}
      </p>
      {canAccept ? (
        <ConfirmDialog
          trigger={<Button variant="primary" className="justify-self-start">{t('settings.dpa.accept')}</Button>}
          title={t('settings.dpa.confirmTitle')}
          description={t('settings.dpa.confirmBody', { version: status.version })}
          confirmLabel={t('settings.dpa.accept')}
          cancelLabel={t('common.cancel')}
          onConfirm={async () => {
            const result = await acceptClinicDpa(slug);
            if (!result.ok) return t(`errors.${result.code}`);
            toast({ tone: 'success', title: t('settings.dpa.accepted') });
            router.refresh();
          }}
        />
      ) : (
        <p className="text-small text-ink-muted">{t('settings.dpa.ownerOnly')}</p>
      )}
    </div>
  );
}
