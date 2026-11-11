import { CalendarDays } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import type { Locale } from '@/i18n/routing';
import { availableActions } from '@/modules/appointments/domain/status';
import { loadCheckinGrace, loadDayAppointments } from '@/modules/appointments/queries';
import { BookingDialog } from '@/modules/appointments/ui/booking-dialog';
import { DayNav } from '@/modules/appointments/ui/day-nav';
import { DoctorFilter } from '@/modules/appointments/ui/doctor-filter';
import { AppointmentRowActions } from '@/modules/appointments/ui/row-actions';
import { AppointmentStatusBadge } from '@/modules/appointments/ui/status-badge';
import { doctorDisplayName, localizedName } from '@/modules/catalog/names';
import { loadCatalog } from '@/modules/catalog/queries';
import { can, loadWorkspace } from '@/modules/tenancy/workspace';
import { formatLocalDay, formatTime } from '@/shared/lib/format';
import { formatPhone } from '@/shared/lib/phone';
import { isLocalDay, today } from '@/shared/lib/time';
import { Badge } from '@/shared/ui/badge';
import { CellStack, DataTable, type Column } from '@/shared/ui/data-table';
import { PageHeader } from '@/shared/ui/layout';
import { EmptyState, ErrorState } from '@/shared/ui/states';

import { LoadFailure } from '../_lib/page-state';

export async function generateMetadata() {
  const t = await getTranslations('reception');
  return { title: t('title') };
}

/**
 * Reception workspace: the day's appointments for the whole clinic, with the actions the front
 * desk actually performs (book, confirm, move, cancel, mark absent). Rows come from the database.
 */
export default async function ReceptionPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicSlug: string }>;
  searchParams: Promise<{ day?: string; doctor?: string }>;
}) {
  const [{ clinicSlug }, query] = await Promise.all([params, searchParams]);
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const result = await loadWorkspace(clinicSlug);
  if (result.status !== 'ok') return null;
  const ws = result.workspace;
  const tz = ws.clinic.timezone;
  const todayLocal = today(tz);
  const day = isLocalDay(query.day) ? query.day : todayLocal;

  if (!can(ws, 'appointments.view')) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <ErrorState title={t('states.forbiddenTitle')} description={t('states.forbiddenBody')} />
      </div>
    );
  }

  const catalog = await loadCatalog(ws.clinic.id);
  const doctorFilter = catalog.status === 'ok' && catalog.data.doctors.some((d) => d.id === query.doctor) ? (query.doctor ?? '') : '';
  const [appointments, grace] = await Promise.all([
    loadDayAppointments({ clinicId: ws.clinic.id, day, timeZone: tz, ...(doctorFilter ? { doctorIds: [doctorFilter] } : {}) }),
    loadCheckinGrace(ws.clinic.id),
  ]);

  const urlParams: Record<string, string> = { day, ...(doctorFilter ? { doctor: doctorFilter } : {}) };
  const activeDoctors = catalog.status === 'ok' ? catalog.data.doctors.filter((d) => d.active) : [];
  const doctorOptions = activeDoctors.map((d) => ({ id: d.id, name: doctorDisplayName(locale, d.fullName, d.fullNameAr) }));
  const canBook = can(ws, 'appointments.book') && ws.clinic.status !== 'suspended';

  const header = (
    <PageHeader
      title={t('reception.title')}
      meta={formatLocalDay(locale, day)}
      actions={
        canBook && catalog.status === 'ok' ? (
          <BookingDialog
            slug={ws.clinic.slug}
            timeZone={tz}
            defaultDay={day}
            canOverbook={can(ws, 'appointments.overbook')}
            catalog={{
              doctors: doctorOptions,
              services: catalog.data.services.filter((s) => s.active).map((s) => ({ id: s.id, name: localizedName(locale, s.nameFr, s.nameAr) })),
              offerings: catalog.data.offerings.filter((o) => o.active),
            }}
          />
        ) : null
      }
    />
  );

  if (catalog.status !== 'ok') return (<>{header}<LoadFailure outcome={catalog} /></>);
  if (appointments.status !== 'ok') return (<>{header}<LoadFailure outcome={appointments} /></>);

  const doctors = new Map(catalog.data.doctors.map((d) => [d.id, doctorDisplayName(locale, d.fullName, d.fullNameAr)]));
  const services = new Map(catalog.data.services.map((s) => [s.id, localizedName(locale, s.nameFr, s.nameAr)]));
  const now = new Date();
  type Row = (typeof appointments.data)[number];

  const columns: Column<Row>[] = [
    {
      id: 'time',
      header: t('columns.time'),
      className: 'w-28',
      cell: (a) => (
        <span className="grid leading-tight">
          <time dateTime={a.startsAt} className="font-medium text-ink">{formatTime(locale, a.startsAt, tz)}</time>
          <time dateTime={a.endsAt} className="text-small text-ink-muted">{formatTime(locale, a.endsAt, tz)}</time>
        </span>
      ),
    },
    {
      id: 'patient',
      header: t('columns.patient'),
      cell: (a) =>
        a.patient ? (
          <CellStack
            primary={`${a.patient.firstName} ${a.patient.lastName}`}
            secondary={
              <span className="tabular">
                {a.patient.fileNumber}
                {a.patient.phone ? <span dir="ltr"> · {formatPhone(a.patient.phone)}</span> : null}
              </span>
            }
          />
        ) : (
          <span className="text-ink-subtle">{t('reception.hiddenPatient')}</span>
        ),
    },
    { id: 'doctor', header: t('columns.doctor'), hideBelow: 'md', cell: (a) => doctors.get(a.doctorId) ?? '—' },
    { id: 'service', header: t('columns.service'), hideBelow: 'lg', cell: (a) => services.get(a.serviceId) ?? '—' },
    {
      id: 'status',
      header: t('columns.status'),
      className: 'w-40',
      cell: (a) => (
        <span className="flex flex-wrap items-center gap-1">
          <AppointmentStatusBadge status={a.status} />
          {a.isOverbooked ? <Badge tone="warning">{t('reception.overbooked')}</Badge> : null}
          {a.source !== 'staff' ? <span className="text-caption text-ink-subtle">{t(`source.${a.source}`)}</span> : null}
        </span>
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">{t('columns.actions')}</span>,
      align: 'end',
      className: 'w-px whitespace-nowrap',
      cell: (a) =>
        canBook ? (
          <AppointmentRowActions
            timeZone={tz}
            actions={availableActions(a, now, grace)}
            appointment={{
              id: a.id,
              version: a.version,
              doctorId: a.doctorId,
              serviceId: a.serviceId,
              day,
              patientName: a.patient ? `${a.patient.firstName} ${a.patient.lastName}` : t('reception.hiddenPatient'),
              timeLabel: formatTime(locale, a.startsAt, tz),
            }}
          />
        ) : null,
    },
  ];

  return (
    <>
      {header}
      <DataTable
        caption={`${t('reception.title')} — ${formatLocalDay(locale, day)}`}
        columns={columns}
        rows={appointments.data}
        getRowId={(a) => a.id}
        rowClassName={(a) => (a.status === 'cancelled' || a.status === 'no_show' ? 'text-ink-muted' : undefined)}
        toolbar={
          <>
            <DayNav day={day} today={todayLocal} params={doctorFilter ? { doctor: doctorFilter } : {}} />
            <div className="ms-auto">
              <DoctorFilter doctors={doctorOptions} value={doctorFilter} params={urlParams} />
            </div>
          </>
        }
        footer={
          <>
            <span>{t('reception.count', { count: appointments.data.length })}</span>
            <span>{t('reception.queueNote')}</span>
          </>
        }
        empty={
          <EmptyState
            icon={CalendarDays}
            title={doctorFilter ? t('reception.emptyFiltered') : t('reception.empty')}
            description={canBook ? t('reception.emptyHint') : undefined}
          />
        }
      />
    </>
  );
}
