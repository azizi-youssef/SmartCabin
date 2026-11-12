import { BarChart3 } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { dayCount, minutesParts, PERIODS, periodRange, ratio, type Period } from '@/modules/analytics/kpi';
import { loadKpis, type KpiRow } from '@/modules/analytics/queries';
import { DoctorFilter } from '@/modules/appointments/ui/doctor-filter';
import { centsToDecimal, decimalToCents } from '@/modules/billing/money';
import { loadRevenue } from '@/modules/billing/queries';
import { doctorDisplayName, localizedName } from '@/modules/catalog/names';
import { loadCatalog } from '@/modules/catalog/queries';
import { can, loadWorkspace } from '@/modules/tenancy/workspace';
import { cn } from '@/shared/lib/cn';
import { formatLocalDay, formatMoney, formatNumber, formatPercent } from '@/shared/lib/format';
import { today } from '@/shared/lib/time';
import { DataTable, type Column } from '@/shared/ui/data-table';
import { MetricStrip, PageHeader, Section } from '@/shared/ui/layout';
import { EmptyState, ErrorState } from '@/shared/ui/states';

import { LoadFailure } from '../_lib/page-state';

export async function generateMetadata() {
  const t = await getTranslations('analytics');
  return { title: t('title') };
}

/** Day-by-day table only for short periods (a month at most). */
const MAX_DAILY_DAYS = 31;

/**
 * Operational statistics (K1–K6, K8; BUSINESS_RULES §8), computed by the database from records
 * under the caller's RLS: owners and admins see the clinic, a doctor their own agendas. Revenue
 * (K7) is billing's definition, summarized here for those who may see it.
 */
export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicSlug: string }>;
  searchParams: Promise<{ period?: string; doctor?: string }>;
}) {
  const [{ clinicSlug }, query] = await Promise.all([params, searchParams]);
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const result = await loadWorkspace(clinicSlug);
  if (result.status !== 'ok') return null;
  const ws = result.workspace;
  if (!can(ws, 'analytics.operational')) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <ErrorState title={t('states.forbiddenTitle')} description={t('states.forbiddenBody')} />
      </div>
    );
  }

  const tz = ws.clinic.timezone;
  const period: Period = (PERIODS as readonly string[]).includes(query.period ?? '') ? (query.period as Period) : '30d';
  const { from, to } = periodRange(period, today(tz));
  const catalog = await loadCatalog(ws.clinic.id);
  const practitionerOnly = ws.role === 'doctor';
  const doctors = catalog.status === 'ok'
    ? catalog.data.doctors
        .filter((d) => !practitionerOnly || d.userId === ws.session.userId)
        .map((d) => ({ id: d.id, name: doctorDisplayName(locale, d.fullName, d.fullNameAr) }))
    : [];
  const doctorId = doctors.some((d) => d.id === query.doctor) ? (query.doctor as string) : null;
  const daily = dayCount(from, to) <= MAX_DAILY_DAYS;
  const showRevenue = can(ws, 'analytics.financial') && can(ws, 'billing.reports') && !doctorId;

  const [total, byDoctor, byService, byDay, revenue] = await Promise.all([
    loadKpis({ clinicId: ws.clinic.id, from, to, group: 'total', doctorId }),
    doctorId ? null : loadKpis({ clinicId: ws.clinic.id, from, to, group: 'doctor' }),
    loadKpis({ clinicId: ws.clinic.id, from, to, group: 'service', doctorId }),
    daily ? loadKpis({ clinicId: ws.clinic.id, from, to, group: 'day', doctorId }) : null,
    showRevenue ? loadRevenue(ws.clinic.id, from, to) : null,
  ]);

  const base = `/w/${ws.clinic.slug}/analytics`;
  const periodLabel = from === to ? formatLocalDay(locale, from) : t('analytics.range', { from: formatLocalDay(locale, from, 'short'), to: formatLocalDay(locale, to, 'short') });
  const header = (
    <PageHeader
      title={t('analytics.title')}
      description={t('analytics.subtitle')}
      meta={periodLabel}
      actions={doctors.length > 1 ? <DoctorFilter doctors={doctors} value={doctorId ?? ''} params={period === '30d' ? {} : { period }} /> : null}
    />
  );
  const periodNav = (
    <nav aria-label={t('analytics.periodLabel')} className="flex flex-wrap gap-1">
      {PERIODS.map((p) => {
        const q = new URLSearchParams();
        if (p !== '30d') q.set('period', p);
        if (doctorId) q.set('doctor', doctorId);
        const qs = q.toString();
        const href = qs ? `${base}?${qs}` : base;
        return (
          <Link
            key={p}
            href={href}
            aria-current={p === period ? 'page' : undefined}
            className={cn(
              'focus-ring rounded-md px-3 py-1.5 text-small font-medium',
              p === period ? 'bg-primary text-primary-fg' : 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
            )}
          >
            {t(`analytics.periods.${p}`)}
          </Link>
        );
      })}
    </nav>
  );
  if (total.status !== 'ok') return (<>{header}{periodNav}<LoadFailure outcome={total} /></>);

  const k = total.data[0];
  const percent = (value: number | null) => (value === null ? '—' : formatPercent(locale, value));
  const minutes = (value: number | null) => {
    if (value === null) return '—';
    const parts = minutesParts(value);
    return parts.hours > 0 ? t('analytics.hoursMinutes', { hours: parts.hours, minutes: String(parts.minutes).padStart(2, '0') }) : t('analytics.minutes', { minutes: formatNumber(locale, value) });
  };
  const utilization = (r: KpiRow) => ratio(r.bookedMinutes, r.availableMinutes);

  const doctorNames = new Map(doctors.map((d) => [d.id, d.name]));
  const serviceNames = new Map(catalog.status === 'ok' ? catalog.data.services.map((s) => [s.id, localizedName(locale, s.nameFr, s.nameAr)]) : []);
  const totalCompleted = byService.status === 'ok' ? byService.data.reduce((n, s) => n + s.completed, 0) : 0;

  const doctorColumns: Column<KpiRow>[] = [
    { id: 'doctor', header: t('columns.doctor'), cell: (r) => doctorNames.get(r.key) ?? '—' },
    { id: 'appointments', header: t('analytics.k1'), align: 'end', cell: (r) => <span className="tabular">{formatNumber(locale, r.appointments)}</span> },
    { id: 'completed', header: t('analytics.k2'), align: 'end', hideBelow: 'sm', cell: (r) => <span className="tabular">{formatNumber(locale, r.completed)}</span> },
    { id: 'noShow', header: t('analytics.k4'), align: 'end', hideBelow: 'md', cell: (r) => <span className="tabular">{percent(ratio(r.noShow, r.noShowDenominator))}</span> },
    { id: 'wait', header: t('analytics.k5'), align: 'end', hideBelow: 'lg', cell: (r) => <span className="tabular">{minutes(r.waitMeanMinutes)}</span> },
    { id: 'utilization', header: t('analytics.k6'), align: 'end', cell: (r) => <span className="tabular">{percent(utilization(r))}</span> },
  ];
  const serviceColumns: Column<KpiRow>[] = [
    { id: 'service', header: t('columns.service'), cell: (r) => serviceNames.get(r.key) ?? '—' },
    { id: 'completed', header: t('analytics.k2'), align: 'end', cell: (r) => <span className="tabular">{formatNumber(locale, r.completed)}</span> },
    { id: 'share', header: t('analytics.share'), align: 'end', cell: (r) => <span className="tabular">{percent(ratio(r.completed, totalCompleted))}</span> },
    { id: 'appointments', header: t('analytics.k1'), align: 'end', hideBelow: 'md', cell: (r) => <span className="tabular">{formatNumber(locale, r.appointments)}</span> },
  ];
  const dayColumns: Column<KpiRow>[] = [
    { id: 'day', header: t('analytics.day'), cell: (r) => formatLocalDay(locale, r.key, 'short') },
    { id: 'appointments', header: t('analytics.k1'), align: 'end', cell: (r) => <span className="tabular">{formatNumber(locale, r.appointments)}</span> },
    { id: 'completed', header: t('analytics.k2'), align: 'end', hideBelow: 'sm', cell: (r) => <span className="tabular">{formatNumber(locale, r.completed)}</span> },
    { id: 'cancelled', header: t('analytics.k3'), align: 'end', hideBelow: 'md', cell: (r) => <span className="tabular">{formatNumber(locale, r.cancelled)}</span> },
    { id: 'noShow', header: t('analytics.noShows'), align: 'end', hideBelow: 'md', cell: (r) => <span className="tabular">{formatNumber(locale, r.noShow)}</span> },
    { id: 'utilization', header: t('analytics.k6'), align: 'end', cell: (r) => <span className="tabular">{percent(utilization(r))}</span> },
  ];

  const revenueTotals = revenue?.status === 'ok'
    ? {
        invoiced: centsToDecimal(revenue.data.reduce((n, d) => n + decimalToCents(d.invoicedMad), 0)),
        net: centsToDecimal(revenue.data.reduce((n, d) => n + decimalToCents(d.netMad), 0)),
      }
    : null;
  const empty = !k || (k.appointments === 0 && (k.availableMinutes ?? 0) === 0);

  return (
    <>
      {header}
      {periodNav}
      {empty || !k ? (
        <div className="rounded-lg border border-line bg-surface">
          <EmptyState icon={BarChart3} title={t('analytics.empty')} description={t('analytics.emptyHint')} />
        </div>
      ) : (
        <>
          <MetricStrip
            label={t('analytics.summaryLabel')}
            metrics={[
              { id: 'k1', label: t('analytics.k1'), value: formatNumber(locale, k.appointments), hint: t('analytics.k1Hint', { online: k.bySource['online'] ?? 0, walkIn: k.bySource['walk_in'] ?? 0 }) },
              { id: 'k2', label: t('analytics.k2'), value: formatNumber(locale, k.completed) },
              { id: 'k3', label: t('analytics.k3'), value: formatNumber(locale, k.cancelled), hint: t('analytics.k3Hint', { patient: k.cancelledByPatient, clinic: k.cancelledByClinic, left: k.leftBeforeConsultation }) },
              { id: 'k4', label: t('analytics.k4'), value: percent(ratio(k.noShow, k.noShowDenominator)), hint: t('analytics.k4Hint', { noShow: k.noShow, total: k.noShowDenominator }), tone: (ratio(k.noShow, k.noShowDenominator) ?? 0) > 0.15 ? 'danger' : 'default' },
              { id: 'k5', label: t('analytics.k5'), value: minutes(k.waitMeanMinutes), hint: k.waitCount > 0 ? t('analytics.k5Hint', { median: minutes(k.waitMedianMinutes), count: k.waitCount }) : t('analytics.noMeasure') },
              { id: 'k6', label: t('analytics.k6'), value: percent(utilization(k)), hint: t('analytics.k6Hint', { actual: percent(ratio(k.actualMinutes, k.availableMinutes)) }) },
            ]}
          />
          {revenueTotals ? (
            <p className="text-small text-ink-muted">
              {t('analytics.k7', { invoiced: formatMoney(locale, revenueTotals.invoiced), net: formatMoney(locale, revenueTotals.net) })}{' '}
              <Link href={`/w/${ws.clinic.slug}/revenue`} className="focus-ring rounded-sm text-accent hover:underline">{t('analytics.k7Link')}</Link>
            </p>
          ) : null}

          <div className="grid gap-6 xl:grid-cols-2">
            {byDoctor ? (
              <Section id="doctors" title={t('analytics.byDoctor')}>
                {byDoctor.status === 'ok'
                  ? <DataTable caption={t('analytics.byDoctor')} columns={doctorColumns} rows={byDoctor.data.filter((r) => doctorNames.has(r.key))} getRowId={(r) => r.key} empty={<EmptyState title={t('analytics.noRows')} />} />
                  : <LoadFailure outcome={byDoctor} />}
              </Section>
            ) : null}
            <Section id="services" title={t('analytics.byService')} description={t('analytics.byServiceHint')}>
              {byService.status === 'ok'
                ? <DataTable caption={t('analytics.byService')} columns={serviceColumns} rows={[...byService.data].sort((a, b) => b.completed - a.completed)} getRowId={(r) => r.key} empty={<EmptyState title={t('analytics.noRows')} />} />
                : <LoadFailure outcome={byService} />}
            </Section>
          </div>

          {byDay ? (
            <Section id="days" title={t('analytics.byDay')}>
              {byDay.status === 'ok'
                ? <DataTable caption={t('analytics.byDay')} columns={dayColumns} rows={byDay.data} getRowId={(r) => r.key} empty={<EmptyState title={t('analytics.noRows')} />} />
                : <LoadFailure outcome={byDay} />}
            </Section>
          ) : null}
          <p className="text-caption text-ink-subtle">{t('analytics.definitions')}</p>
        </>
      )}
    </>
  );
}
