'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Check, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import type { z } from 'zod';

import { createClinicSchema, slugify, SLUG_PATTERN, type CreateClinicInput } from '@/modules/identity/schemas';
import type { ErrorCode } from '@/shared/lib/errors';
import { Button } from '@/shared/ui/button';
import { Field, FieldGrid } from '@/shared/ui/field';
import { Checkbox, Input, Select } from '@/shared/ui/form-controls';
import { InlineAlert } from '@/shared/ui/states';

import { checkSlug, createClinic } from '../onboarding-actions';

export interface LegalDocumentRef {
  kind: string;
  version: string;
}

/**
 * Clinic creation. The address slug is proposed from the name and checked live; the
 * database checks it again (and the legal acceptance) when the clinic is created.
 */
export function OnboardingForm({ documents }: { documents: LegalDocumentRef[] }) {
  const t = useTranslations();
  const locale = useLocale();
  const tf = useTranslations('forms.errors');
  const [error, setError] = useState<ErrorCode | null>(null);
  const [slugEdited, setSlugEdited] = useState(false);
  const [availability, setAvailability] = useState<{ slug: string; available: boolean } | null>(null);
  const [checking, startCheck] = useTransition();

  const form = useForm<CreateClinicInput, unknown, z.output<typeof createClinicSchema>>({
    resolver: zodResolver(createClinicSchema),
    defaultValues: { displayName: '', slug: '', city: 'Nador', phone: '', defaultLocale: locale === 'ar' ? 'ar' : 'fr', acceptTerms: false as unknown as true },
    mode: 'onTouched',
  });
  const [name, slug] = useWatch({ control: form.control, name: ['displayName', 'slug'] });

  useEffect(() => {
    if (!slugEdited) form.setValue('slug', slugify(name ?? ''), { shouldValidate: false });
  }, [name, slugEdited, form]);

  useEffect(() => {
    const value = (slug ?? '').trim().toLowerCase();
    if (!SLUG_PATTERN.test(value)) return;
    const timer = setTimeout(() => {
      startCheck(async () => {
        const result = await checkSlug(value);
        if (result.ok) setAvailability({ slug: value, available: result.data.available });
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [slug]);

  const err = (key: keyof CreateClinicInput) => {
    const message = form.formState.errors[key]?.message;
    return message ? tf(message) : undefined;
  };
  const current = availability && availability.slug === (slug ?? '').trim().toLowerCase() ? availability : null;

  return (
    <form
      noValidate
      className="grid gap-5"
      onSubmit={form.handleSubmit(async (values) => {
        setError(null);
        const result = await createClinic(locale, values);
        if (!result.ok) {
          for (const [field, message] of Object.entries(result.fields ?? {})) form.setError(field as keyof CreateClinicInput, { message });
          setError(result.code);
        }
      })}
    >
      <Field id="ob-name" label={t('onboarding.displayName')} hint={t('onboarding.displayNameHint')} required error={err('displayName')}>
        <Input autoComplete="organization" {...form.register('displayName')} />
      </Field>
      <Field id="ob-slug" label={t('onboarding.slug')} hint={t('onboarding.slugHint')} required error={err('slug')}>
        <Input
          dir="ltr"
          className="text-start font-mono"
          autoComplete="off"
          {...form.register('slug', { onChange: () => setSlugEdited(true) })}
        />
      </Field>
      {current && !err('slug') ? (
        <p className={current.available ? 'flex items-center gap-1.5 text-small text-success' : 'flex items-center gap-1.5 text-small text-danger'} aria-live="polite">
          {current.available ? <Check aria-hidden className="size-4" /> : <X aria-hidden className="size-4" />}
          {current.available ? t('onboarding.slugAvailable') : t('onboarding.slugTaken')}
          {checking ? '…' : null}
        </p>
      ) : null}
      <FieldGrid>
        <Field id="ob-city" label={t('onboarding.city')} required error={err('city')}>
          <Input autoComplete="address-level2" {...form.register('city')} />
        </Field>
        <Field id="ob-phone" label={t('onboarding.phone')} optionalLabel={t('common.optional')} error={err('phone')}>
          <Input type="tel" dir="ltr" className="text-start" placeholder="05 36 12 34 56" {...form.register('phone')} />
        </Field>
        <Field id="ob-locale" label={t('onboarding.defaultLocale')}>
          <Select {...form.register('defaultLocale')}>
            <option value="fr">Français</option>
            <option value="ar">العربية</option>
          </Select>
        </Field>
      </FieldGrid>
      <div className="grid gap-1 rounded-md border border-line bg-surface-muted p-3">
        <Checkbox
          label={t('onboarding.acceptTerms')}
          description={documents.map((d) => `${t(`onboarding.document.${d.kind}`)} (${d.version})`).join(' · ')}
          aria-invalid={form.formState.errors.acceptTerms ? true : undefined}
          {...form.register('acceptTerms')}
        />
        {form.formState.errors.acceptTerms ? (
          <p role="alert" className="ps-6.5 text-small text-danger">
            {tf('termsRequired')}
          </p>
        ) : null}
      </div>
      {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
      <Button type="submit" variant="primary" size="lg" loading={form.formState.isSubmitting}>
        {t('onboarding.submit')}
      </Button>
    </form>
  );
}
