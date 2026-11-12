import { MapPin, Phone } from 'lucide-react';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { loadPublicClinic } from '@/modules/portal/booking';
import { BookingWizard } from '@/modules/portal/ui/booking-wizard';
import { getSessionState } from '@/shared/lib/auth/session';
import { formatPhone } from '@/shared/lib/phone';
import { today } from '@/shared/lib/time';
import { EmptyState } from '@/shared/ui/states';

import { Brand } from '../../_components/brand';
import { ServiceUnavailablePage } from '../../_components/service-unavailable';
import { LocaleSwitcher } from '../../_components/topbar';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await getTranslations('booking');
  const clinic = /^[a-z0-9][a-z0-9-]{1,80}$/.test(slug) ? await loadPublicClinic(slug) : null;
  return { title: clinic?.status === 'ok' ? t('pageTitle', { clinic: clinic.data.displayName }) : t('title') };
}

/**
 * A clinic's public booking page (S7), reached by its link or QR code. Anyone can see the offer
 * and the free slots; booking asks for an SMS code, which opens (or creates) the patient's
 * account. Only clinic profile data and slot times are public: nothing about patients.
 */
export default async function ClinicBookingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await getTranslations();
  if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(slug)) notFound();
  const [clinic, session] = await Promise.all([loadPublicClinic(slug), getSessionState()]);
  if (clinic.status === 'unavailable') return <ServiceUnavailablePage />;
  if (clinic.status === 'error') {
    if (clinic.code === 'NOT_FOUND') notFound();
    return <ServiceUnavailablePage />;
  }
  const c = clinic.data;
  const signedInWithPhone = session.status === 'signed_in' && Boolean(session.session.phone);

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="sticky top-0 z-30 border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-2 px-4">
          <Brand />
          <div className="ms-auto flex items-center gap-1">
            <LocaleSwitcher />
            {signedInWithPhone ? (
              <Link href="/me" className="focus-ring rounded-sm px-2 text-small font-medium text-accent hover:underline">{t('booking.myAppointments')}</Link>
            ) : null}
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto grid max-w-2xl gap-6 px-4 py-6">
        <section aria-labelledby="clinic-title" className="grid gap-1">
          <p className="text-small text-ink-muted">{t('booking.eyebrow')}</p>
          <h1 id="clinic-title" className="text-title text-ink">{c.displayName}</h1>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-small text-ink-muted">
            <span className="inline-flex items-center gap-1"><MapPin aria-hidden className="size-4" />{c.addressLine ? `${c.addressLine}, ${c.city}` : c.city}</span>
            {c.phone ? (
              <a href={`tel:${c.phone}`} className="focus-ring inline-flex items-center gap-1 rounded-sm hover:text-ink" dir="ltr">
                <Phone aria-hidden className="size-4" />{formatPhone(c.phone)}
              </a>
            ) : null}
          </p>
        </section>
        {c.onlineBookingOpen && c.offerings.length > 0 ? (
          <BookingWizard
            clinic={{ id: c.id, slug: c.slug, timezone: c.timezone, autoConfirm: c.autoConfirm, maxHorizonDays: c.maxHorizonDays, cancelCutoffHours: c.cancelCutoffHours, offerings: c.offerings }}
            today={today(c.timezone)}
            signedIn={signedInWithPhone}
          />
        ) : (
          <div className="rounded-lg border border-line bg-surface">
            <EmptyState title={t('booking.closedTitle')} description={c.phone ? t('booking.closedBodyPhone', { phone: formatPhone(c.phone) }) : t('booking.closedBody')} />
          </div>
        )}
        <p className="text-caption text-ink-subtle">{t('booking.privacy')}</p>
      </main>
    </div>
  );
}
