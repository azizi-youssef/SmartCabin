'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowRight, Eye, EyeOff, Lock, Mail } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import type { ErrorCode } from '@/shared/lib/errors';
import { Button } from '@/shared/ui/button';
import { Captcha, captchaEnabled } from '@/shared/ui/captcha';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/form-controls';
import { InlineAlert } from '@/shared/ui/states';

import { sendPhoneCode, signInWithPassword, startTotpEnrollment, verifyPhoneCode, verifyTotp, type TotpEnrollment } from '../actions';

const signInSchema = z.object({ email: z.email('invalid'), password: z.string().min(1, 'required') });

/** Staff sign-in. One generic error for unknown email or wrong password (no enumeration). */
export function SignInForm() {
  const t = useTranslations();
  const locale = useLocale();
  const [error, setError] = useState<ErrorCode | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const form = useForm<z.input<typeof signInSchema>>({ resolver: zodResolver(signInSchema), defaultValues: { email: '', password: '' } });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    const result = await signInWithPassword(locale, values, captchaToken ?? undefined);
    if (!result.ok) {
      setError(result.code);
      setCaptchaKey((k) => k + 1); // a CAPTCHA token is single use
    }
  });

  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-4.5">
      <Field id="email" label={t('auth.email')} required error={form.formState.errors.email ? t('errors.VALIDATION_FAILED') : undefined}>
        <div className="relative">
          <Mail aria-hidden className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
          <Input
            type="email"
            autoComplete="username"
            dir="ltr"
            placeholder={locale === 'ar' ? 'doctor@example.test' : 'docteur@example.test'}
            className="ps-9.5 text-start transition-all duration-200 focus:border-accent focus:ring-2 focus:ring-accent/20"
            {...form.register('email')}
          />
        </div>
      </Field>

      <Field id="password" label={t('auth.password')} required error={form.formState.errors.password ? t('patients.form.errors.required') : undefined}>
        <div className="relative">
          <Lock aria-hidden className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
          <Input
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            dir="ltr"
            placeholder="••••••••••••"
            className="pe-10 ps-9.5 text-start transition-all duration-200 focus:border-accent focus:ring-2 focus:ring-accent/20"
            {...form.register('password')}
          />
          <button
            type="button"
            onClick={() => setShowPassword((prev) => !prev)}
            aria-label={showPassword ? (locale === 'ar' ? 'إخفاء كلمة المرور' : 'Masquer le mot de passe') : (locale === 'ar' ? 'إظهار كلمة المرور' : 'Afficher le mot de passe')}
            className="focus-ring absolute end-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-subtle transition-colors hover:text-ink hover:bg-surface-sunken"
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </Field>

      <Captcha onToken={setCaptchaToken} resetKey={captchaKey} />

      {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}

      <Button
        type="submit"
        variant="primary"
        size="lg"
        loading={form.formState.isSubmitting}
        disabled={captchaEnabled() && !captchaToken}
        className="group relative mt-1 h-11 w-full justify-center overflow-hidden font-medium shadow-sm transition-all duration-200 hover:shadow-md active:scale-[0.99]"
      >
        <span>{t('auth.submit')}</span>
        <ArrowRight className="ms-2 size-4 transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5" />
      </Button>
    </form>
  );
}

/** 6-digit one-time code input (TOTP or SMS). */
function CodeInput({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field id={id} label={label} required>
      <Input
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        dir="ltr"
        className="h-11 text-center text-heading tracking-[0.4em] tabular"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      />
    </Field>
  );
}

/**
 * MFA: verify with an existing TOTP factor, or enroll one first (QR code from Supabase Auth).
 * Owners, admins, accountants and platform admins cannot reach clinic data without it.
 */
export function MfaForm({ verifiedFactorId }: { verifiedFactorId: string | null }) {
  const t = useTranslations();
  const locale = useLocale();
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<ErrorCode | null>(null);
  const [pending, startTransition] = useTransition();
  const factorId = verifiedFactorId ?? enrollment?.factorId ?? null;

  if (!factorId) {
    return (
      <div className="grid gap-4">
        <p className="text-body text-ink-muted">{t('auth.mfaEnrollIntro')}</p>
        {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
        <Button
          variant="primary"
          size="lg"
          loading={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await startTotpEnrollment();
              if (result.ok) setEnrollment(result.data);
              else setError(result.code);
            })
          }
        >
          {t('auth.mfaStart')}
        </Button>
      </div>
    );
  }

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await verifyTotp(locale, { factorId, code });
          if (!result.ok) setError(result.code);
        });
      }}
    >
      {enrollment ? (
        <div className="grid gap-3">
          <p className="text-body text-ink-muted">{t('auth.mfaScan')}</p>
          {/* eslint-disable-next-line @next/next/no-img-element -- data: URI SVG from Supabase Auth */}
          <img src={enrollment.qrCode} alt="" width={176} height={176} className="mx-auto size-44 rounded-md border border-line bg-white p-2" />
          <details className="text-small text-ink-muted">
            <summary className="cursor-pointer">{t('auth.mfaSecret')}</summary>
            <code dir="ltr" className="mt-1 block break-all rounded-sm bg-surface-sunken px-2 py-1 font-mono text-caption text-ink">
              {enrollment.secret}
            </code>
          </details>
        </div>
      ) : (
        <p className="text-body text-ink-muted">{t('auth.mfaChallengeIntro')}</p>
      )}
      <CodeInput id="mfa-code" label={t('auth.mfaCode')} value={code} onChange={setCode} />
      {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
      <Button type="submit" variant="primary" size="lg" loading={pending} disabled={code.length !== 6}>
        {t('auth.mfaVerify')}
      </Button>
    </form>
  );
}

/** Patient portal sign-in by SMS code. */
export function PhoneSignInForm() {
  const t = useTranslations();
  const locale = useLocale();
  const [phoneInput, setPhoneInput] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<ErrorCode | null>(null);
  const [pending, startTransition] = useTransition();
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);

  if (!sentTo) {
    return (
      <form
        noValidate
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          startTransition(async () => {
            const result = await sendPhoneCode({ phone: phoneInput, ...(captchaToken ? { captchaToken } : {}) });
            setCaptchaKey((k) => k + 1); // a CAPTCHA token is single use
            if (result.ok) setSentTo(result.data.phone);
            else setError(result.code);
          });
        }}
      >
        <Field id="phone" label={t('auth.phone')} hint={t('auth.phoneHint')} required>
          <Input type="tel" inputMode="tel" autoComplete="tel" dir="ltr" className="h-11 text-start" value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)} />
        </Field>
        <Captcha onToken={setCaptchaToken} resetKey={captchaKey} />
        {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
        <Button type="submit" variant="primary" size="lg" loading={pending} disabled={phoneInput.trim().length < 9 || (captchaEnabled() && !captchaToken)}>
          {t('auth.sendCode')}
        </Button>
      </form>
    );
  }

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await verifyPhoneCode(locale, { phone: sentTo, code });
          if (!result.ok) setError(result.code);
        });
      }}
    >
      <p className="text-body text-ink-muted">
        {t.rich('auth.codeSent', {
          number: sentTo,
          phone: (chunks) => (
            <span dir="ltr" className="font-medium text-ink tabular">
              {chunks}
            </span>
          ),
        })}
      </p>
      <CodeInput id="sms-code" label={t('auth.code')} value={code} onChange={setCode} />
      {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
      <Button type="submit" variant="primary" size="lg" loading={pending} disabled={code.length !== 6}>
        {t('auth.verifyCode')}
      </Button>
      <Button
        variant="link"
        size="sm"
        className="justify-self-center"
        onClick={() => {
          setSentTo(null);
          setCode('');
          setError(null);
        }}
      >
        {t('auth.changePhone')}
      </Button>
    </form>
  );
}
