import { getLocale, getTranslations } from 'next-intl/server';

import type { Locale } from '@/i18n/routing';
import { doctorDisplayName } from '@/modules/catalog/names';
import { loadCatalog } from '@/modules/catalog/queries';
import { loadDisplayScreens } from '@/modules/reception/queries';
import { BookingLinkPanel } from '@/modules/portal/ui/booking-link';
import { DisplayScreens } from '@/modules/reception/ui/display-screens';

import { loadBookingPolicy, loadClinicProfile, loadClosures, loadDpaStatus } from '@/modules/tenancy/queries';
import { BookingPolicyForm, ClinicProfileForm, ClosuresManager, DpaPanel } from '@/modules/tenancy/ui/settings';
import { can, loadWorkspace } from '@/modules/tenancy/workspace';
import { siteUrl } from '@/shared/lib/site';
import { PageHeader, Section } from '@/shared/ui/layout';
import { ErrorState } from '@/shared/ui/states';

import { LoadFailure } from '../_lib/page-state';

export async function generateMetadata() {
  const t = await getTranslations('settings');
  return { title: t('title') };
}

/** Clinic settings: compliance, profile, booking policy, closures. */
export default async function SettingsPage({ params }: { params: Promise<{ clinicSlug: string }> }) {
  const { clinicSlug } = await params;
  const t = await getTranslations();
  const locale = (await getLocale()) as Locale;
  const result = await loadWorkspace(clinicSlug);
  if (result.status !== 'ok') return null;
  const ws = result.workspace;
  const canView = can(ws, 'clinic.settings.update') || can(ws, 'clinic.profile.update') || can(ws, 'clinic.closures.manage');
  if (!canView) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <ErrorState title={t('states.forbiddenTitle')} description={t('states.forbiddenBody')} />
      </div>
    );
  }

  const canDisplays = can(ws, 'queue.displays.manage');
  const [profile, policy, closures, dpa, screens, catalog] = await Promise.all([
    loadClinicProfile(ws.clinic.id),
    loadBookingPolicy(ws.clinic.id),
    loadClosures(ws.clinic.id),
    loadDpaStatus(ws.clinic.id),
    canDisplays ? loadDisplayScreens(ws.clinic.id) : Promise.resolve(null),
    canDisplays ? loadCatalog(ws.clinic.id) : Promise.resolve(null),
  ]);
  const doctorNames = new Map(
    catalog?.status === 'ok' ? catalog.data.doctors.map((d) => [d.id, doctorDisplayName(locale, d.fullName, d.fullNameAr)]) : [],
  );
  const suspended = ws.clinic.status === 'suspended';

  return (
    <>
      <PageHeader title={t('settings.title')} description={t('settings.subtitle')} />
      {dpa.status === 'ok' && dpa.data ? (
        <Section id="dpa" title={t('settings.dpa.title')}>
          <DpaPanel slug={ws.clinic.slug} status={dpa.data} canAccept={can(ws, 'legal.accept_clinic_dpa')} />
        </Section>
      ) : null}
      {can(ws, 'clinic.profile.update') ? (
        <Section id="profile" title={t('settings.profile.title')} description={t('settings.profile.hint')}>
          {profile.status !== 'ok' ? <LoadFailure outcome={profile} /> : profile.data ? <ClinicProfileForm slug={ws.clinic.slug} profile={profile.data} disabled={suspended} /> : null}
        </Section>
      ) : null}
      {can(ws, 'clinic.settings.update') ? (
        <Section id="policy" title={t('settings.policy.title')} description={t('settings.policy.hint')}>
          {policy.status !== 'ok' ? <LoadFailure outcome={policy} /> : policy.data ? <BookingPolicyForm slug={ws.clinic.slug} policy={policy.data} disabled={suspended} /> : null}
        </Section>
      ) : null}
      {can(ws, 'clinic.settings.update') && policy.status === 'ok' && policy.data ? (
        <Section id="booking-link" title={t('settings.bookingLink.title')} description={t('settings.bookingLink.hint')}>
          <BookingLinkPanel url={`${siteUrl()}/${locale}/c/${ws.clinic.slug}`} enabled={policy.data.onlineBookingEnabled && ws.clinic.status === 'active'} />
        </Section>
      ) : null}
      <Section id="closures" title={t('settings.closures.title')} description={t('settings.closures.hint')}>
        {closures.status !== 'ok' ? <LoadFailure outcome={closures} /> : <ClosuresManager slug={ws.clinic.slug} closures={closures.data} canManage={can(ws, 'clinic.closures.manage') && !suspended} />}
      </Section>
      {screens ? (
        <Section id="displays" title={t('displays.title')} description={t('displays.hint')} className="mt-6">
          {screens.status !== 'ok' ? (
            <LoadFailure outcome={screens} />
          ) : (
            <DisplayScreens
              slug={ws.clinic.slug}
              timeZone={ws.clinic.timezone}
              canManage={!suspended}
              doctors={catalog?.status === 'ok' ? catalog.data.doctors.filter((d) => d.active).map((d) => ({ id: d.id, name: doctorNames.get(d.id) ?? d.fullName })) : []}
              screens={screens.data.map((s) => ({
                id: s.id,
                name: s.name,
                doctorNames: s.doctorIds ? s.doctorIds.map((id) => doctorNames.get(id) ?? '—') : null,
                createdAt: s.createdAt,
                revokedAt: s.revokedAt,
                lastSeenAt: s.lastSeenAt,
              }))}
            />
          )}
        </Section>
      ) : null}
    </>
  );
}
