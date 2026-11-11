import { CalendarDays } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { summarizeDay } from '@/modules/analytics/day-summary';
import { ACTIVE_STATUSES } from '@/modules/appointments/domain/status';
import { loadDayAppointments } from '@/modules/appointments/queries';
import { AppointmentStatusBadge } from '@/modules/appointments/ui/status-badge';
import { doctorDisplayName, localizedName } from '@/modules/catalog/names';
import { loadCatalog } from '@/modules/catalog/queries';
import { can, loadWorkspace } from '@/modules/tenancy/workspace';
import { formatLongDate, formatNumber, formatPercent, formatTime } from '@/shared/lib/format';
import { requestNow, today } from '@/shared/lib/time';
import { Button } from '@/shared/ui/button';
import { CellStack, DataTable, type Column } from '@/shared/ui/data-table';
import { MetricStrip, PageHeader, Section } from '@/shared/ui/layout';
import { EmptyState, InlineAlert } from '@/shared/ui/states';

import { LoadFailure } from './_lib/page-state';

export async function generateMetadata() {
  const t = await getTranslations('dashboard');
  return { title: t('title') };
}

/** Clinic dashboard: today's figures and the next appointments — all counted from real records. */
export default async function DashboardPage({ params }: { params: Promise<{ clinicSlug: string }> }) {
  const { clinicSlug } = await params;
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const result = await loadWorkspace(clinicSlug);
  if (result.status !== 'ok') return null; // the layout renders the state
  const ws = result.workspace;
  const tz = ws.clinic.timezone;
  const day = today(tz);

  const header = <PageHeader title={t('dashboard.title')} meta={formatLongDate(locale, new Date(), tz)} />;

  if (!can(ws, 'appointments.view')) {
    return (
      <>
        {header}
        <div className="rounded-lg border border-line bg-surface">
          <EmptyState title={t('dashboard.noAppointmentsAccess')} description={t('dashboard.noAppointmentsAccessHint')} />
        </div>
      </>
    );
  }

  const [appointments, catalog] = await Promise.all([
    loadDayAppointments({ clinicId: ws.clinic.id, day, timeZone: tz }),
    loadCatalog(ws.clinic.id),
  ]);
  if (appointments.status !== 'ok') return (<>{header}<LoadFailure outcome={appointments} /></>);
  if (catalog.status !== 'ok') return (<>{header}<LoadFailure outcome={catalog} /></>);

  const summary = summarizeDay(appointments.data);
  const doctors = new Map(catalog.data.doctors.map((d) => [d.id, doctorDisplayName(locale, d.fullName, d.fullNameAr)]));
  const services = new Map(catalog.data.services.map((s) => [s.id, localizedName(locale, s.nameFr, s.nameAr)]));
  const now = requestNow().getTime();
  const next = appointments.data
    .filter((a) => (ACTIVE_STATUSES as readonly string[]).includes(a.status) && new Date(a.endsAt).getTime() > now)
    .slice(0, 8);
  const practitionerOnly = ws.role === 'doctor';

  type Row = (typeof next)[number];
  const columns: Column<Row>[] = [
    { id: 'time', header: t('columns.time'), className: 'w-20', cell: (a) => <time dateTime={a.startsAt} className="font-medium">{formatTime(locale, a.startsAt, tz)}</time> },
    {
      id: 'patient',
      header: t('columns.patient'),
      cell: (a) => (a.patient ? <CellStack primary={`${a.patient.firstName} ${a.patient.lastName}`} secondary={a.patient.fileNumber} /> : <span className="text-ink-subtle">{t('reception.hiddenPatient')}</span>),
    },
    { id: 'doctor', header: t('columns.doctor'), hideBelow: 'md', cell: (a) => doctors.get(a.doctorId) ?? '—' },
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
        ]}
      />
      <Section
        id="next"
        title={t('dashboard.nextTitle')}
        actions={
          can(ws, 'appointments.book') ? (
            <Button asChild variant="secondary" size="sm">
              <Link href={`/w/${ws.clinic.slug}/reception`}>{t('dashboard.openReception')}</Link>
            </Button>
          ) : null
        }
      >
        <DataTable
          caption={t('dashboard.nextTitle')}
          columns={columns}
          rows={next}
          getRowId={(a) => a.id}
          empty={<EmptyState icon={CalendarDays} title={t('dashboard.nextEmpty')} />}
        />
      </Section>
    </>
  );
}
