import { CalendarDays, CalendarPlus, ReceiptText, Users } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import { Suspense } from 'react';

import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { summarizeDay } from '@/modules/analytics/day-summary';
import { ACTIVE_STATUSES } from '@/modules/appointments/domain/status';
import { loadCheckinGrace, loadDayAppointments } from '@/modules/appointments/queries';
import { AppointmentStatusBadge } from '@/modules/appointments/ui/status-badge';
import { centsToDecimal, decimalToCents } from '@/modules/billing/money';
import { loadRevenue } from '@/modules/billing/queries';
import { doctorDisplayName, localizedName } from '@/modules/catalog/names';
import { loadCatalog } from '@/modules/catalog/queries';
import { AttentionPanel, PanelSkeleton, QueuePanel, WeekPanel, type DashboardScope } from '@/modules/dashboard/ui/panels';
import { can, loadWorkspace } from '@/modules/tenancy/workspace';
import { formatLongDate, formatMoney, formatNumber, formatPercent, formatTime } from '@/shared/lib/format';
import { requestNow, today } from '@/shared/lib/time';
import { Button } from '@/shared/ui/button';
import { CellStack, DataTable, type Column } from '@/shared/ui/data-table';
import { MetricStrip, PageHeader, Section, type Metric } from '@/shared/ui/layout';
import { EmptyState, InlineAlert } from '@/shared/ui/states';

import { LoadFailure } from './_lib/page-state';

export async function generateMetadata() {
  const t = await getTranslations('dashboard');
  return { title: t('title') };
}

/**
 * Clinic dashboard, by role: today's figures, what needs action ("À traiter"), the queues, the
 * last 7 days against the 7 before, and for finance roles the day's money. Everything is counted
 * from records under the caller's RLS; each panel loads on its own behind a placeholder.
 */
export default async function DashboardPage({ params }: { params: Promise<{ clinicSlug: string }> }) {
  const { clinicSlug } = await params;
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const result = await loadWorkspace(clinicSlug);
  if (result.status !== 'ok') return null; // the layout renders the state
  const ws = result.workspace;
  const tz = ws.clinic.timezone;
  const day = today(tz);
  const base = `/w/${ws.clinic.slug}`;
  const writable = ws.readOnlyReason === null;

  const seesAppointments = can(ws, 'appointments.view');
  const seesRevenue = can(ws, 'billing.reports');
  const [catalog, appointments, grace, revenue] = await Promise.all([
    loadCatalog(ws.clinic.id),
    seesAppointments ? loadDayAppointments({ clinicId: ws.clinic.id, day, timeZone: tz }) : null,
    seesAppointments ? loadCheckinGrace(ws.clinic.id) : null,
    seesRevenue ? loadRevenue(ws.clinic.id, `${day.slice(0, 7)}-01`, day) : null,
  ]);
  const doctorNames = new Map(catalog.status === 'ok' ? catalog.data.doctors.map((d) => [d.id, doctorDisplayName(locale, d.fullName, d.fullNameAr)]) : []);
  const scope: DashboardScope = { clinicId: ws.clinic.id, slug: ws.clinic.slug, timezone: tz, today: day, can: (p) => can(ws, p), doctorNames };

  const actions = (
    <>
      {writable && can(ws, 'appointments.book') ? (
        <Button asChild variant="primary">
          <Link href={`${base}/reception`}><CalendarPlus aria-hidden />{t('dashboard.actions.book')}</Link>
        </Button>
      ) : null}
      {can(ws, 'patients.view') ? (
        <Button asChild variant="secondary">
          <Link href={`${base}/patients`}><Users aria-hidden />{t('dashboard.actions.patients')}</Link>
        </Button>
      ) : null}
      {can(ws, 'invoices.view') ? (
        <Button asChild variant="secondary">
          <Link href={`${base}/billing`}><ReceiptText aria-hidden />{t('dashboard.actions.billing')}</Link>
        </Button>
      ) : null}
    </>
  );
  const header = <PageHeader title={t('dashboard.title')} meta={formatLongDate(locale, new Date(), tz)} actions={actions} />;

  // The day's money (K7, billing's definition): today, and net since the 1st of the month.
  const todayRevenue = revenue?.status === 'ok' ? revenue.data.find((d) => d.day === day) : undefined;
  const monthNet = revenue?.status === 'ok' ? centsToDecimal(revenue.data.reduce((sum, d) => sum + decimalToCents(d.netMad), 0)) : null;
  const moneyMetrics: Metric[] = revenue?.status === 'ok'
    ? [
        { id: 'collected', label: t('dashboard.collectedToday'), value: formatMoney(locale, todayRevenue?.netMad ?? '0'), hint: t('dashboard.invoicedToday', { amount: formatMoney(locale, todayRevenue?.invoicedMad ?? '0') }) },
        ...(seesAppointments ? [] : [{ id: 'month', label: t('dashboard.netMonth'), value: formatMoney(locale, monthNet ?? '0') }]),
      ]
    : [];

  const sidePanels = (unresolvedToday: number | null) => (
    <div className="grid content-start gap-6">
      <Suspense fallback={<PanelSkeleton title={t('dashboard.attention.title')} rows={3} />}>
        <AttentionPanel scope={scope} unresolvedToday={unresolvedToday} />
      </Suspense>
      {can(ws, 'analytics.operational') ? (
        <Suspense fallback={<PanelSkeleton title={t('dashboard.week.title')} rows={4} />}>
          <WeekPanel scope={scope} />
        </Suspense>
      ) : null}
    </div>
  );

  // Roles without appointments (accountant): the day's money and what needs action.
  if (!seesAppointments || !appointments) {
    return (
      <>
        {header}
        {moneyMetrics.length > 0 ? <MetricStrip label={t('dashboard.financeLabel')} metrics={moneyMetrics} /> : null}
        {revenue && revenue.status !== 'ok' ? <LoadFailure outcome={revenue} /> : null}
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {sidePanels(null)}
          {moneyMetrics.length === 0 ? (
            <div className="rounded-lg border border-line bg-surface">
              <EmptyState title={t('dashboard.noAppointmentsAccess')} description={t('dashboard.noAppointmentsAccessHint')} />
            </div>
          ) : null}
        </div>
      </>
    );
  }
  if (appointments.status !== 'ok') return (<>{header}<LoadFailure outcome={appointments} /></>);

  const summary = summarizeDay(appointments.data);
  const services = new Map(catalog.status === 'ok' ? catalog.data.services.map((s) => [s.id, localizedName(locale, s.nameFr, s.nameAr)]) : []);
  const now = requestNow().getTime();
  const next = appointments.data
    .filter((a) => (ACTIVE_STATUSES as readonly string[]).includes(a.status) && new Date(a.endsAt).getTime() > now)
    .slice(0, 8);
  // Confirmed, past the check-in grace, never checked in: to settle at reception (MD-09).
  const unresolvedToday = appointments.data.filter(
    (a) => a.status === 'confirmed' && new Date(a.startsAt).getTime() + (grace ?? 15) * 60_000 < now,
  ).length;
  const practitionerOnly = ws.role === 'doctor';

  type Row = (typeof next)[number];
  const columns: Column<Row>[] = [
    {
      id: 'time',
      header: t('columns.time'),
      className: 'w-20',
      cell: (a) => (
        <Link href={`${base}/appointments/${a.id}`} className="focus-ring rounded-sm font-medium text-accent hover:underline">
          <time dateTime={a.startsAt} className="tabular">{formatTime(locale, a.startsAt, tz)}</time>
          <span className="sr-only"> — {t('appointment.open')}</span>
        </Link>
      ),
    },
    {
      id: 'patient',
      header: t('columns.patient'),
      cell: (a) => (a.patient ? <CellStack primary={`${a.patient.firstName} ${a.patient.lastName}`} secondary={a.patient.fileNumber} /> : <span className="text-ink-subtle">{t('reception.hiddenPatient')}</span>),
    },
    { id: 'doctor', header: t('columns.doctor'), hideBelow: 'md', cell: (a) => doctorNames.get(a.doctorId) ?? '—' },
    { id: 'service', header: t('columns.service'), hideBelow: 'lg', cell: (a) => services.get(a.serviceId) ?? '—' },
    { id: 'status', header: t('columns.status'), className: 'w-36', cell: (a) => <AppointmentStatusBadge status={a.status} /> },
  ];

  return (
    <>
      {header}
      {practitionerOnly ? <InlineAlert tone="info">{t('dashboard.scopeOwn')}</InlineAlert> : null}
      <MetricStrip
        label={t('dashboard.metricsLabel')}
        metrics={[
          { id: 'total', label: t('dashboard.total'), value: formatNumber(locale, summary.total) },
          { id: 'upcoming', label: t('dashboard.upcoming'), value: formatNumber(locale, summary.upcoming) },
          { id: 'in-clinic', label: t('dashboard.inClinic'), value: formatNumber(locale, summary.inClinic) },
          { id: 'completed', label: t('dashboard.completed'), value: formatNumber(locale, summary.completed), tone: 'success' },
          { id: 'cancelled', label: t('dashboard.cancelled'), value: formatNumber(locale, summary.cancelled) },
          {
            id: 'no-show',
            label: t('dashboard.noShowRate'),
            value: summary.noShowRate === null ? '—' : formatPercent(locale, summary.noShowRate),
            hint: t('dashboard.noShowRateHint'),
            tone: summary.noShowRate !== null && summary.noShowRate > 0.15 ? 'danger' : 'default',
          },
          ...moneyMetrics,
        ]}
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-6">
          <Section id="next" title={t('dashboard.nextTitle')}>
            <DataTable
              caption={t('dashboard.nextTitle')}
              columns={columns}
              rows={next}
              getRowId={(a) => a.id}
              empty={<EmptyState icon={CalendarDays} title={t('dashboard.nextEmpty')} description={can(ws, 'appointments.book') ? t('dashboard.nextEmptyHint') : undefined} />}
            />
          </Section>
          {can(ws, 'queue.view') ? (
            <Suspense fallback={<PanelSkeleton title={t('dashboard.queue.title')} rows={2} />}>
              <QueuePanel scope={scope} />
            </Suspense>
          ) : null}
        </div>
        {sidePanels(unresolvedToday)}
      </div>
    </>
  );
}
