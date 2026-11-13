import { CalendarClock, MapPin, Stethoscope } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { doctorDisplayName } from '@/modules/catalog/names';
import { groupBySpecialty, relativeDay, specialtyFilter, type DirectoryDoctor } from '@/modules/directory/domain';
import { loadDirectory } from '@/modules/directory/queries';
import { getSessionState } from '@/shared/lib/auth/session';
import { cn } from '@/shared/lib/cn';
import { formatMoney, formatNumber, formatTime, formatWeekdayDay } from '@/shared/lib/format';
import { addDays, localDay, today } from '@/shared/lib/time';
import { Button } from '@/shared/ui/button';
import { EmptyState } from '@/shared/ui/states';

import { Brand } from '../_components/brand';
import { ServiceUnavailablePage } from '../_components/service-unavailable';
import { LocaleSwitcher } from '../_components/topbar';

export async function generateMetadata() {
  const t = await getTranslations('directory');
  return { title: t('title'), description: t('subtitle') };
}

type T = Awaited<ReturnType<typeof getTranslations>>;

function NextSlot({ doctor, locale, t }: { doctor: DirectoryDoctor; locale: Locale; t: T }) {
  if (!doctor.nextSlotAt) {
    return <p className="text-small text-ink-muted">{t('directory.noSlot')}</p>;
  }
  const tz = doctor.clinicTimezone;
  const local = today(tz);
  const when = relativeDay(localDay(new Date(doctor.nextSlotAt), tz), local, addDays(local, 1));
  const time = formatTime(locale, doctor.nextSlotAt, tz);
  const label = when === 'today'
    ? t('directory.nextToday', { time })
    : when === 'tomorrow'
      ? t('directory.nextTomorrow', { time })
      : t('directory.nextOn', { date: formatWeekdayDay(locale, doctor.nextSlotAt, tz), time });
  return (
    <p className="flex items-center gap-1.5 text-small text-ink">
      <CalendarClock aria-hidden className={cn('size-4 shrink-0', when ? 'text-success' : 'text-ink-subtle')} />
      <span>
        <span className="text-ink-muted">{t('directory.nextLabel')}</span>{' '}
        <time dateTime={doctor.nextSlotAt} className="font-medium">{label}</time>
      </span>
    </p>
  );
}

function DoctorCard({ doctor, locale, t }: { doctor: DirectoryDoctor; locale: Locale; t: T }) {
  const name = doctorDisplayName(locale, doctor.name, doctor.nameAr);
  const place = doctor.clinicAddress ? `${doctor.clinicAddress}, ${doctor.clinicCity}` : doctor.clinicCity;
  return (
    <article className="flex h-full flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex items-start gap-3">
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Stethoscope className="size-5" />
        </span>
        <div className="grid min-w-0 gap-0.5">
          <h3 className="text-heading text-ink">{name}</h3>
          <p className="text-small font-medium text-ink">{doctor.clinicName}</p>
          <p className="flex items-start gap-1 text-small text-ink-muted">
            <MapPin aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-subtle" />
            <span>{place}</span>
          </p>
        </div>
      </div>
      <NextSlot doctor={doctor} locale={locale} t={t} />
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        {doctor.minPriceMad ? (
          <span className="text-small text-ink-muted">
            {t('directory.priceFrom')} <span className="tabular font-medium text-ink">{formatMoney(locale, doctor.minPriceMad)}</span>
          </span>
        ) : <span />}
        <Button asChild variant={doctor.nextSlotAt ? 'primary' : 'secondary'}>
          <Link href={`/c/${doctor.clinicSlug}?medecin=${doctor.id}`}>
            {doctor.nextSlotAt ? t('directory.book') : t('directory.seeClinic')}
            <span className="sr-only"> — {name}</span>
          </Link>
        </Button>
      </div>
    </article>
  );
}

/**
 * Public doctor directory (BR-P-04): the doctors of the clinics that agreed to be listed,
 * grouped by specialty, each with the next free online slot and a link to book at that clinic.
 * Public profile data only, read anonymously and cached for a minute.
 */
export default async function DirectoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const [directory, session, query] = await Promise.all([loadDirectory(), getSessionState(), searchParams]);
  if (directory.status !== 'ok') return <ServiceUnavailablePage />;
  const signedInWithPhone = session.status === 'signed_in' && Boolean(session.session.phone);

  const groups = groupBySpecialty(directory.data, locale, t('directory.otherSpecialty'));
  const filter = specialtyFilter(query['specialite'], groups);
  const shown = filter === null ? groups : groups.filter((g) => (g.code ?? 'autres') === filter);
  const chip = (active: boolean) => cn(
    'focus-ring inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-small font-medium transition-colors',
    active ? 'border-primary bg-primary text-primary-fg' : 'border-line-strong bg-surface text-ink hover:bg-surface-sunken',
  );

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="sticky top-0 z-30 border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-4">
          <Link href="/medecins" className="focus-ring rounded-md"><Brand /></Link>
          <div className="ms-auto flex items-center gap-1">
            <LocaleSwitcher />
            {signedInWithPhone ? (
              <Link href="/me" className="focus-ring rounded-sm px-2 text-small font-medium text-accent hover:underline">{t('booking.myAppointments')}</Link>
            ) : null}
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto grid max-w-5xl gap-6 px-4 py-6">
        <section aria-labelledby="directory-title" className="grid gap-1">
          <p className="text-small text-ink-muted">{t('directory.eyebrow')}</p>
          <h1 id="directory-title" className="text-title text-ink">{t('directory.title')}</h1>
          <p className="max-w-prose text-body text-ink-muted">{t('directory.subtitle')}</p>
        </section>

        {groups.length === 0 ? (
          <div className="rounded-lg border border-line bg-surface">
            <EmptyState icon={Stethoscope} title={t('directory.emptyTitle')} description={t('directory.emptyBody')} />
          </div>
        ) : (
          <>
            <nav aria-label={t('directory.filterLabel')}>
              <ul className="flex flex-wrap gap-2">
                <li>
                  <Link href="/medecins" className={chip(filter === null)} aria-current={filter === null ? 'page' : undefined}>
                    {t('directory.all')}
                    <span className="tabular opacity-80">{formatNumber(locale, directory.data.length)}</span>
                  </Link>
                </li>
                {groups.map((g) => {
                  const code = g.code ?? 'autres';
                  return (
                    <li key={code}>
                      <Link href={`/medecins?specialite=${code}`} className={chip(filter === code)} aria-current={filter === code ? 'page' : undefined}>
                        {g.label}
                        <span className="tabular opacity-80">{formatNumber(locale, g.doctors.length)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>

            {shown.map((g) => {
              const id = `specialty-${g.code ?? 'autres'}`;
              return (
                <section key={id} aria-labelledby={id} className="grid gap-3">
                  <h2 id={id} className="flex items-baseline gap-2 text-heading text-ink">
                    {g.label}
                    <span className="text-small font-normal text-ink-muted">{t('directory.count', { count: g.doctors.length })}</span>
                  </h2>
                  <ul className="grid gap-3 sm:grid-cols-2">
                    {g.doctors.map((d) => (
                      <li key={d.id}><DoctorCard doctor={d} locale={locale} t={t} /></li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </>
        )}
        <p className="text-caption text-ink-subtle">{t('directory.note')}</p>
      </main>
    </div>
  );
}
