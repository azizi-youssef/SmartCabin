import {
  Activity,
  ArrowUpRight,
  CalendarDays,
  Lock,
  ShieldCheck,
} from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { Link, redirect } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { SignInForm } from '@/modules/identity/ui/auth-forms';
import { getSessionState } from '@/shared/lib/auth/session';
import { InlineAlert, UnavailableState } from '@/shared/ui/states';

import { Brand } from '../../_components/brand';
import { LocaleSwitcher } from '../../_components/topbar';

export async function generateMetadata() {
  const t = await getTranslations('auth');
  return { title: t('signInTitle') };
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ link?: string }> }) {
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const { link } = await searchParams;
  const session = await getSessionState();
  if (session.status === 'signed_in') redirect({ href: '/', locale });

  const isArabic = locale === 'ar';

  return (
    <div className="relative flex min-h-dvh flex-col justify-between bg-canvas">
      {/* Halo lumineux d'ambiance très doux et discret en arrière-plan */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-96 bg-gradient-to-b from-teal-500/[0.04] via-transparent to-transparent"
      />

      {/* Barre de navigation supérieure */}
      <header className="relative z-10 w-full px-6 py-5 sm:px-10 lg:px-12">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <Link href="/" className="focus-ring rounded-md transition-opacity hover:opacity-90">
            <Brand className="h-9" />
          </Link>
          <div className="flex items-center gap-2">
            <LocaleSwitcher />
          </div>
        </div>
      </header>

      {/* Zone centrale : Carte de connexion centrée */}
      <main id="main" className="relative z-10 my-auto flex flex-1 items-center justify-center px-4 py-8 sm:py-12">
        <div className="w-full max-w-[460px]">
          {/* Carte principale */}
          <div className="rounded-2xl border border-line bg-surface p-7 sm:p-9 shadow-lg shadow-slate-200/50">
            {/* Titre et Sous-titre */}
            <div className="mb-6 grid gap-1.5">
              <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-[26px]">
                {isArabic ? 'تسجيل الدخول إلى عيادتك' : 'Connexion à votre clinique'}
              </h1>
              <p className="text-body text-ink-muted">
                {isArabic
                  ? 'الوصول إلى جدول المواعيد، ملفات المرضى، ونظام سمارت فلو.'
                  : 'Accédez à votre agenda, vos dossiers patients et la file d’attente SmartFlow.'}
              </p>
            </div>

            {link === 'invalid' ? (
              <div className="mb-5">
                <InlineAlert tone="warning">{t('auth.linkInvalid')}</InlineAlert>
              </div>
            ) : null}

            {session.status === 'unavailable' ? (
              <UnavailableState
                className="px-0 py-0"
                title={t('states.unavailableTitle')}
                description={t('auth.notConfigured')}
              />
            ) : (
              <div className="grid gap-5">
                {/* Formulaire de connexion (Email + MDP avec icônes et toggle oeil) */}
                <SignInForm />

                {/* Mot de passe oublié */}
                <div className="flex items-center justify-end">
                  <Link
                    href="/forgot-password"
                    className="focus-ring rounded-sm text-small font-medium text-accent transition-colors hover:text-accent-hover hover:underline"
                  >
                    {t('password.forgotLink')}
                  </Link>
                </div>

                {/* Séparateur */}
                <div className="relative my-1">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-line" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-surface px-3 text-ink-subtle">
                      {isArabic ? 'أو' : 'ou'}
                    </span>
                  </div>
                </div>

                {/* Carte d'accès Patient */}
                <Link
                  href="/patient/sign-in"
                  className="group relative flex items-center justify-between rounded-xl border border-line bg-surface-muted/60 p-3.5 transition-all duration-200 hover:border-accent hover:bg-surface hover:shadow-xs"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-accent">
                      <CalendarDays className="size-4.5" />
                    </div>
                    <div className="grid text-start">
                      <span className="text-small font-semibold text-ink group-hover:text-accent">
                        {isArabic ? 'هل أنت مريض؟' : 'Vous êtes patient ?'}
                      </span>
                      <span className="text-caption text-ink-muted">
                        {isArabic
                          ? 'حجز موعد أو متابعة دورك بالهاتف'
                          : 'Prendre rendez-vous ou suivre votre file d’attente'}
                      </span>
                    </div>
                  </div>
                  <ArrowUpRight className="size-4 text-ink-subtle transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-accent rtl:rotate-[-90deg] rtl:group-hover:-translate-x-0.5" />
                </Link>

                {/* Inscription nouveau cabinet */}
                <p className="pt-1 text-center text-small text-ink-muted">
                  <span className="me-1.5">
                    {isArabic ? 'عيادة جديدة؟' : 'Votre cabinet n’a pas encore de compte ?'}
                  </span>
                  <Link
                    href="/sign-up"
                    className="font-semibold text-accent transition-colors hover:text-accent-hover hover:underline"
                  >
                    {t('signUp.cta')}
                  </Link>
                </p>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Footer de réassurance & conformité */}
      <footer className="relative z-10 w-full px-6 py-6 sm:px-10">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-x-6 gap-y-2 text-caption text-ink-subtle">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="size-4 text-accent" />
            <span>{isArabic ? 'بيانات طبية محمية ومعزولة' : 'Données médicales isolées'}</span>
          </div>
          <span aria-hidden className="hidden sm:inline text-line-strong">•</span>
          <div className="flex items-center gap-1.5">
            <Lock className="size-3.5 text-accent" />
            <span>{isArabic ? 'مطابق لمعايير CNDP المغرب' : 'Conforme CNDP Maroc'}</span>
          </div>
          <span aria-hidden className="hidden sm:inline text-line-strong">•</span>
          <div className="flex items-center gap-1.5">
            <Activity className="size-3.5 text-accent" />
            <span>{isArabic ? 'جاهزية 99.9%' : 'Haute disponibilité'}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
