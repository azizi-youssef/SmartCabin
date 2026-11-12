import { ArrowLeft } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import { z } from 'zod';

import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { loadPlatformClinics, loadPlatformOverview, loadPlatformPlans, nextClinicStatuses } from '@/modules/platform';
import { ClinicStatusActions } from '@/modules/platform/ui/clinic-status-actions';
import { MarkPaidForm, SubscriptionForm } from '@/modules/platform/ui/subscription-form';
import { SUBSCRIPTION_TONE } from '@/modules/subscriptions/domain';
import { formatLongDate, formatNumber } from '@/shared/lib/format';
import { today } from '@/shared/lib/time';
import { Badge } from '@/shared/ui/badge';
import { DetailList, MetricStrip, PageHeader, Section } from '@/shared/ui/layout';
import { ErrorState, InlineAlert, UnavailableState } from '@/shared/ui/states';

export async function generateMetadata() {
  const t = await getTranslations('platformClinic');
  return { title: t('title') };
}

const PLATFORM_TIME_ZONE = 'Africa/Casablanca';

/** "YYYY-MM-DD" of the last included day of a period that ends at the given instant. */
function lastDay(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  return today(timeZone, new Date(new Date(iso).getTime() - 1));
}

function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * One clinic for the platform: status, subscription (plan, status, period, payments) and
 * activity counts. Organization metadata and counts only — no patient-level data (RBAC §4).
 */
export default async function PlatformClinicPage({ params }: { params: Promise<{ clinicId: string }> }) {
  const { clinicId } = await params;
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const notFound = (
    <div className="rounded-lg border border-line bg-surface">
      <ErrorState title={t('states.notFoundTitle')} description={t('states.notFoundBody')} />
    </div>
  );
  if (!z.uuid().safeParse(clinicId).success) return notFound;

  const [clinics, overview, plans] = await Promise.all([loadPlatformClinics(), loadPlatformOverview(), loadPlatformPlans()]);
  if (clinics.status === 'unavailable' || overview.status === 'unavailable' || plans.status === 'unavailable') {
    return <div className="rounded-lg border border-line bg-surface"><UnavailableState title={t('states.unavailableTitle')} description={t('states.unavailableBody')} /></div>;
  }
  if (clinics.status === 'error' || overview.status === 'error' || plans.status === 'error') {
    return <div className="rounded-lg border border-line bg-surface"><ErrorState title={t('states.errorTitle')} description={t('platform.forbidden')} /></div>;
  }
  const clinic = clinics.data.find((c) => c.id === clinicId);
  if (!clinic) return notFound;
  const o = overview.data.get(clinicId);
  const tz = PLATFORM_TIME_ZONE;
  const todayLocal = today(tz);
  const periodStart = o?.periodEnd ? '' : todayLocal;
  const planOptions = plans.data
    .filter((p) => p.isActive || p.code === o?.planCode)
    .map((p) => ({ code: p.code, label: `${locale === 'ar' ? p.nameAr : p.nameFr} (${p.code})` }));

  const details = [
    { label: t('subscription.plan'), value: o?.planCode ? `${locale === 'ar' ? o.planNameAr : o.planNameFr} (${o.planCode})` : '—' },
    {
      label: t('subscription.statusLabel'),
      value: o?.subscriptionStatus ? <Badge tone={SUBSCRIPTION_TONE[o.subscriptionStatus]} dot>{t(`subscription.status.${o.subscriptionStatus}`)}</Badge> : '—',
    },
    ...(o?.periodEnd ? [{ label: t('platformClinic.paidThrough'), value: formatLongDate(locale, new Date(new Date(o.periodEnd).getTime() - 1), tz) }] : []),
    ...(o?.subscriptionStatus === 'trialing'
      ? [{ label: t('subscription.trialEnds'), value: o.trialEndsAt ? formatLongDate(locale, new Date(new Date(o.trialEndsAt).getTime() - 1), tz) : t('subscription.noTrialEnd') }]
      : []),
    { label: t('columns.city'), value: clinic.city },
    { label: t('columns.createdAt'), value: formatLongDate(locale, clinic.createdAt, tz) },
  ];

  return (
    <>
      <PageHeader
        title={clinic.displayName}
        description={<span dir="ltr">{clinic.slug}</span>}
        meta={
          <Link href="/platform" className="focus-ring inline-flex items-center gap-1 rounded-sm text-small text-ink-muted hover:text-ink">
            <ArrowLeft aria-hidden className="size-4 flip-rtl" />
            {t('platformClinic.back')}
          </Link>
        }
        actions={<ClinicStatusActions clinic={{ id: clinic.id, name: clinic.displayName, status: clinic.status }} next={nextClinicStatuses(clinic.status)} />}
      />
      {o?.openRequestPlanCode ? <InlineAlert tone="warning">{t('platformClinic.openRequest', { plan: o.openRequestPlanCode })}</InlineAlert> : null}
      <MetricStrip
        label={t('platformClinic.activity')}
        metrics={[
          { id: 'appointments', label: t('platform.appointments30d'), value: formatNumber(locale, o?.appointments30d ?? 0) },
          { id: 'completed', label: t('platformClinic.completed30d'), value: formatNumber(locale, o?.completed30d ?? 0) },
          { id: 'online', label: t('platformClinic.online30d'), value: formatNumber(locale, o?.onlineBookings30d ?? 0) },
          { id: 'sms', label: t('platformClinic.smsThisMonth'), value: formatNumber(locale, o?.smsThisMonth ?? 0) },
          { id: 'members', label: t('columns.members'), value: formatNumber(locale, o?.activeMembers ?? clinic.activeMembers) },
          { id: 'doctors', label: t('columns.doctors'), value: formatNumber(locale, o?.activeDoctors ?? clinic.activeDoctors) },
          { id: 'patients', label: t('platformClinic.patients'), value: formatNumber(locale, o?.patientsTotal ?? 0) },
        ]}
      />
      <p className="text-caption text-ink-subtle">{t('platformClinic.countsOnly')}</p>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Section id="subscription" title={t('platformClinic.subscription')}>
          <div className="rounded-lg border border-line bg-surface p-4"><DetailList items={details} /></div>
        </Section>
        <Section id="manage" title={t('platformClinic.manage')} description={t('platformClinic.manageHint')}>
          <div className="grid gap-6 rounded-lg border border-line bg-surface p-4">
            <SubscriptionForm
              clinicId={clinic.id}
              plans={planOptions}
              current={{
                planCode: o?.planCode ?? null,
                status: o?.subscriptionStatus ?? null,
                periodStart: periodStart || todayLocal,
                periodEnd: lastDay(o?.periodEnd ?? null, tz) || addDays(todayLocal, 29),
                trialEndsOn: lastDay(o?.trialEndsAt ?? null, tz),
              }}
            />
            <div className="grid gap-2 border-t border-line pt-4">
              <h3 className="text-heading text-ink">{t('platformClinic.payment')}</h3>
              <p className="text-small text-ink-muted">{t('platformClinic.paymentHint')}</p>
              <MarkPaidForm clinicId={clinic.id} defaultUntil={addDays(lastDay(o?.periodEnd ?? null, tz) || todayLocal, 30)} />
            </div>
          </div>
        </Section>
      </div>
    </>
  );
}
