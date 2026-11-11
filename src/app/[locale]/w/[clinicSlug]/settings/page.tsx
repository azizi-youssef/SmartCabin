import { getTranslations } from 'next-intl/server';

import { loadBookingPolicy, loadClinicProfile, loadClosures, loadDpaStatus } from '@/modules/tenancy/queries';
import { BookingPolicyForm, ClinicProfileForm, ClosuresManager, DpaPanel } from '@/modules/tenancy/ui/settings';
import { can, loadWorkspace } from '@/modules/tenancy/workspace';
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

  const [profile, policy, closures, dpa] = await Promise.all([
    loadClinicProfile(ws.clinic.id),
    loadBookingPolicy(ws.clinic.id),
    loadClosures(ws.clinic.id),
    loadDpaStatus(ws.clinic.id),
  ]);
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
      <Section id="closures" title={t('settings.closures.title')} description={t('settings.closures.hint')}>
        {closures.status !== 'ok' ? <LoadFailure outcome={closures} /> : <ClosuresManager slug={ws.clinic.slug} closures={closures.data} canManage={can(ws, 'clinic.closures.manage') && !suspended} />}
      </Section>
    </>
  );
}
