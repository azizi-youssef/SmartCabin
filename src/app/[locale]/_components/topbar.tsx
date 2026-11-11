'use client';

import { Check, ChevronsUpDown, Languages, LogOut, UserRound } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';

import { Link, usePathname } from '@/i18n/navigation';
import { routing, type Locale } from '@/i18n/routing';
import { signOut } from '@/modules/identity/actions';
import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';

const LOCALE_NAMES: Record<Locale, string> = { fr: 'Français', ar: 'العربية' };

/** Language switch: same page in the other language; the choice persists (cookie). */
export function LocaleSwitcher() {
  const locale = useLocale() as Locale;
  const pathname = usePathname();
  const t = useTranslations('common');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={t('language')}>
          <Languages aria-hidden />
          <span className="hidden sm:inline">{LOCALE_NAMES[locale]}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {routing.locales.map((l) => (
          <DropdownMenuItem key={l} asChild>
            <Link href={pathname} locale={l} lang={l} hrefLang={l}>
              <Check aria-hidden className={cn(l === locale ? 'opacity-100' : 'opacity-0')} />
              {LOCALE_NAMES[l]}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface ClinicOption {
  slug: string;
  name: string;
}

/** Clinic switcher for multi-clinic users; a static name when there is only one clinic. */
export function ClinicSwitcher({ current, clinics, statusLabel }: { current: ClinicOption; clinics: ClinicOption[]; statusLabel?: string }) {
  const t = useTranslations('shell');
  const name = (
    <span className="grid min-w-0 text-start leading-tight">
      <span className="truncate text-body font-semibold text-ink">{current.name}</span>
      {statusLabel ? <span className="truncate text-caption text-ink-muted">{statusLabel}</span> : null}
    </span>
  );
  if (clinics.length < 2) return <div className="min-w-0">{name}</div>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="focus-ring -ms-1.5 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface-sunken">
        {name}
        <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-ink-subtle" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-60">
        <DropdownMenuLabel>{t('clinics')}</DropdownMenuLabel>
        {clinics.map((c) => (
          <DropdownMenuItem key={c.slug} asChild>
            <Link href={`/w/${c.slug}`}>
              <Check aria-hidden className={cn(c.slug === current.slug ? 'opacity-100' : 'opacity-0')} />
              <span className="truncate">{c.name}</span>
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Account menu: identity and sign-out (a Server Action). */
export function AccountMenu({ identity, roleLabel }: { identity: string; roleLabel?: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const [pending, startTransition] = useTransition();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t('shell.accountMenu')}>
          <UserRound aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-56">
        <DropdownMenuLabel className="grid gap-0.5">
          <span>{t('shell.signedInAs')}</span>
          <span dir="ltr" className="truncate text-small font-medium text-ink [unicode-bidi:plaintext]">
            {identity}
          </span>
          {roleLabel ? <span className="text-caption text-ink-muted">{roleLabel}</span> : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={pending}
          onSelect={(event) => {
            event.preventDefault();
            startTransition(() => signOut(locale));
          }}
        >
          <LogOut aria-hidden className="flip-rtl" />
          {t('common.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
