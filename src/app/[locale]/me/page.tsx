import { CalendarDays, Clock3, Stethoscope } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { Link, redirect } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { AppointmentStatusBadge } from '@/modules/appointments/ui/status-badge';
import { localizedName } from '@/modules/catalog/names';
import { loadMyAppointments, type PortalAppointment } from '@/modules/portal';
import { loadMemberships } from '@/modules/tenancy/workspace';
import { formatLongDate, formatTime } from '@/shared/lib/format';
import { formatPhone } from '@/shared/lib/phone';
import { requestNow } from '@/shared/lib/time';
import { Button } from '@/shared/ui/button';
import { Section } from '@/shared/ui/layout';
import { EmptyState, ErrorState, InlineAlert, UnavailableState } from '@/shared/ui/states';

import { PortalFrame } from '../_components/portal-frame';
import { ServiceUnavailablePage } from '../_components/service-unavailable';

export async function generateMetadata() {
  const t = await getTranslations('portal');
  return { title: t('title') };
}

function AppointmentItem({ a, locale, t }: { a: PortalAppointment; locale: Locale; t: (key: string, values?: Record<string, string>) => string }) {
  return (
    <li className="grid gap-2 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-0.5">
          <p className="text-heading text-ink">{formatLongDate(locale, a.startsAt, a.clinicTimezone)}</p>
          <p className="flex items-center gap-1.5 text-body text-ink">
            <Clock3 aria-hidden className="size-4 text-ink-subtle" />
            <time dateTime={a.startsAt} className="tabular">
              {formatTime(locale, a.startsAt, a.clinicTimezone)}
            </time>
          </p>
        </div>
        <AppointmentStatusBadge status={a.status} />
      </div>
      <p className="flex items-center gap-1.5 text-small text-ink-muted">
        <Stethoscope aria-hidden className="size-4 text-ink-subtle" />
        <span>
          {a.clinicName} · {t('with', { doctor: a.doctorName })} · {localizedName(locale, a.serviceNameFr, a.serviceNameAr)}
        </span>
      </p>
      <p className="text-small text-ink-muted">{a.relationship === 'self' ? t('forSelf') : t('forRelative', { name: a.patientFirstName })}</p>
    </li>
  );
}

/**
 * Patient portal (mobile-first). Lists only appointments of the records the clinic explicitly
 * linked to this account. Online booking arrives with the portal slice (S7).
 */
export default async function PortalPage() {
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const memberships = await loadMemberships();
  if (memberships.status === 'anonymous') redirect({ href: '/patient/sign-in', locale });
  if (memberships.status !== 'ok') return <ServiceUnavailablePage />;

  const isStaff = memberships.memberships.length > 0;
  const appointments = await loadMyAppointments();
  const tp = (key: string, values?: Record<string, string>) => t(`portal.${key}`, values);
  const identity = memberships.session.phone ? formatPhone(memberships.session.phone.startsWith('+') ? memberships.session.phone : `+${memberships.session.phone}`) : (memberships.session.email ?? '');

  const now = requestNow().getTime();
  const upcoming = appointments.status === 'ok' ? appointments.data.filter((a) => new Date(a.endsAt).getTime() >= now) : [];
  const past = appointments.status === 'ok' ? appointments.data.filter((a) => new Date(a.endsAt).getTime() < now).reverse() : [];

  return (
    <PortalFrame identity={identity}>
      <header className="grid gap-1">
        <h1 className="text-title text-ink">{t('portal.title')}</h1>
        <p className="text-body text-ink-muted">{t('portal.subtitle')}</p>
      </header>

      {isStaff ? (
        <InlineAlert tone="info" title={t('portal.staffAccount')}>
          <Button asChild variant="link" size="sm">
            <Link href="/">{t('portal.goWorkspace')}</Link>
          </Button>
        </InlineAlert>
      ) : null}

      {appointments.status === 'unavailable' ? (
        <div className="rounded-lg border border-line bg-surface">
          <UnavailableState title={t('states.unavailableTitle')} description={t('states.unavailableBody')} />
        </div>
      ) : appointments.status === 'error' ? (
        <div className="rounded-lg border border-line bg-surface">
          <ErrorState title={t('states.errorTitle')} description={t(`errors.${appointments.code}`)} />
        </div>
      ) : (
        <>
          <Section id="upcoming" title={t('portal.upcoming')}>
            {upcoming.length === 0 ? (
              <div className="rounded-lg border border-line bg-surface">
                <EmptyState icon={CalendarDays} title={t('portal.empty')} description={t('portal.emptyHint')} />
              </div>
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
                {upcoming.map((a) => (
                  <AppointmentItem key={a.id} a={a} locale={locale} t={tp} />
                ))}
              </ul>
            )}
          </Section>
          {past.length > 0 ? (
            <Section id="past" title={t('portal.past')}>
              <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
                {past.map((a) => (
                  <AppointmentItem key={a.id} a={a} locale={locale} t={tp} />
                ))}
              </ul>
            </Section>
          ) : null}
        </>
      )}
      <p className="text-small text-ink-muted">{t('portal.onlineBookingNote')}</p>
    </PortalFrame>
  );
}
