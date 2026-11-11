'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { MailCheck } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import type { ErrorCode } from '@/shared/lib/errors';
import { Button } from '@/shared/ui/button';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/form-controls';
import { EmptyState, InlineAlert } from '@/shared/ui/states';

import { requestPasswordReset, signUp, updatePassword } from '../actions';
import { emailOnlySchema, newPasswordSchema, signUpSchema, type NewPasswordInput, type SignUpInput } from '../schemas';

function useFieldError() {
  const t = useTranslations('forms.errors');
  return (message: string | undefined) => (message ? t(message) : undefined);
}

function EmailSentState({ title, body }: { title: string; body: string }) {
  return <EmptyState icon={MailCheck} className="px-0 py-0" title={title} description={body} />;
}

/** Clinic owner registration. Same confirmation whether or not the email already exists. */
export function SignUpForm() {
  const t = useTranslations();
  const locale = useLocale();
  const fieldError = useFieldError();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const form = useForm<SignUpInput, unknown, z.output<typeof signUpSchema>>({
    resolver: zodResolver(signUpSchema),
    defaultValues: { fullName: '', email: '', password: '' },
    mode: 'onTouched',
  });

  if (sent) return <EmailSentState title={t('signUp.sentTitle')} body={t('signUp.sentBody')} />;

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={form.handleSubmit(async (values) => {
        setError(null);
        const result = await signUp(locale, values);
        if (result.ok) setSent(true);
        else setError(result.code);
      })}
    >
      <Field id="su-name" label={t('signUp.fullName')} required error={fieldError(form.formState.errors.fullName?.message)}>
        <Input autoComplete="name" {...form.register('fullName')} />
      </Field>
      <Field id="su-email" label={t('auth.email')} required error={fieldError(form.formState.errors.email?.message)}>
        <Input type="email" autoComplete="email" dir="ltr" className="text-start" {...form.register('email')} />
      </Field>
      <Field id="su-password" label={t('auth.password')} hint={t('signUp.passwordHint')} required error={fieldError(form.formState.errors.password?.message)}>
        <Input type="password" autoComplete="new-password" dir="ltr" className="text-start" {...form.register('password')} />
      </Field>
      {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
      <Button type="submit" variant="primary" size="lg" loading={form.formState.isSubmitting}>
        {t('signUp.submit')}
      </Button>
    </form>
  );
}

export function ForgotPasswordForm() {
  const t = useTranslations();
  const locale = useLocale();
  const fieldError = useFieldError();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const form = useForm<z.input<typeof emailOnlySchema>>({ resolver: zodResolver(emailOnlySchema), defaultValues: { email: '' } });

  if (sent) return <EmailSentState title={t('password.sentTitle')} body={t('password.sentBody')} />;

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={form.handleSubmit(async (values) => {
        setError(null);
        const result = await requestPasswordReset(locale, values);
        if (result.ok) setSent(true);
        else setError(result.code);
      })}
    >
      <Field id="fp-email" label={t('auth.email')} required error={fieldError(form.formState.errors.email?.message)}>
        <Input type="email" autoComplete="email" dir="ltr" className="text-start" {...form.register('email')} />
      </Field>
      {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
      <Button type="submit" variant="primary" size="lg" loading={form.formState.isSubmitting}>
        {t('password.sendLink')}
      </Button>
    </form>
  );
}

export function NewPasswordForm() {
  const t = useTranslations();
  const locale = useLocale();
  const fieldError = useFieldError();
  const [error, setError] = useState<ErrorCode | null>(null);
  const form = useForm<NewPasswordInput, unknown, z.output<typeof newPasswordSchema>>({
    resolver: zodResolver(newPasswordSchema),
    defaultValues: { password: '', confirm: '' },
    mode: 'onTouched',
  });

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={form.handleSubmit(async (values) => {
        setError(null);
        const result = await updatePassword(locale, values);
        if (!result.ok) setError(result.code);
      })}
    >
      <Field id="np-password" label={t('password.newPassword')} hint={t('signUp.passwordHint')} required error={fieldError(form.formState.errors.password?.message)}>
        <Input type="password" autoComplete="new-password" dir="ltr" className="text-start" {...form.register('password')} />
      </Field>
      <Field id="np-confirm" label={t('password.confirm')} required error={fieldError(form.formState.errors.confirm?.message)}>
        <Input type="password" autoComplete="new-password" dir="ltr" className="text-start" {...form.register('confirm')} />
      </Field>
      {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
      <Button type="submit" variant="primary" size="lg" loading={form.formState.isSubmitting}>
        {t('password.save')}
      </Button>
    </form>
  );
}
