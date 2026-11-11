import { CalendarDays } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
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
import { loadDayQueue } from '@/modules/reception/queries';
import { minutesSince, unresolvedAppointments, waitingOrder, type QueueEntry } from '@/modules/reception/queue';
import { CheckInButton, MarkLeftButton } from '@/modules/reception/ui/reception-actions';
import { WalkInDialog } from '@/modules/reception/ui/walk-in-dialog';
import { can, loadWorkspace } from '@/modules/tenancy/workspace';
import { formatLocalDay, formatTime } from '@/shared/lib/format';
import { formatPhone } from '@/shared/lib/phone';
import { isLocalDay, today } from '@/shared/lib/time';
import { Badge } from '@/shared/ui/badge';
import { CellStack, DataTable, type Column } from '@/shared/ui/data-table';
import { PageHeader, Section } from '@/shared/ui/layout';
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
  const [appointments, grace, queue] = await Promise.all([
    loadDayAppointments({ clinicId: ws.clinic.id, day, timeZone: tz, ...(doctorFilter ? { doctorIds: [doctorFilter] } : {}) }),
    loadCheckinGrace(ws.clinic.id),
    can(ws, 'queue.view') ? loadDayQueue(ws.clinic.id, day) : Promise.resolve(null),
  ]);

  const urlParams: Record<string, string> = { day, ...(doctorFilter ? { doctor: doctorFilter } : {}) };
  const activeDoctors = catalog.status === 'ok' ? catalog.data.doctors.filter((d) => d.active) : [];
  const doctorOptions = activeDoctors.map((d) => ({ id: d.id, name: doctorDisplayName(locale, d.fullName, d.fullNameAr) }));
  const canBook = can(ws, 'appointments.book') && ws.clinic.status !== 'suspended';
  const writable = ws.clinic.status !== 'suspended';
  const isToday = day === todayLocal;
  const canCheckIn = writable && isToday && can(ws, 'queue.check_in');
  const canMarkLeft = writable && can(ws, 'queue.mark_left');
  const bookingCatalog =
    catalog.status === 'ok'
      ? {
          doctors: doctorOptions,
          services: catalog.data.services.filter((s) => s.active).map((s) => ({ id: s.id, name: localizedName(locale, s.nameFr, s.nameAr) })),
          offerings: catalog.data.offerings.filter((o) => o.active),
        }
      : null;

  const header = (
    <PageHeader
      title={t('reception.title')}
      meta={formatLocalDay(locale, day)}
      actions={
        bookingCatalog ? (
          <>
            {canCheckIn ? <WalkInDialog slug={ws.clinic.slug} catalog={bookingCatalog} /> : null}
            {canBook ? (
              <BookingDialog slug={ws.clinic.slug} timeZone={tz} defaultDay={day} canOverbook={can(ws, 'appointments.overbook')} catalog={bookingCatalog} />
            ) : null}
          </>
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
  const entries: QueueEntry[] = queue?.status === 'ok' ? queue.data : [];
  // The latest entry describes the appointment (tickets increase within a day).
  const entryByAppointment = new Map<string, QueueEntry>();
  for (const e of entries) {
    const previous = entryByAppointment.get(e.appointmentId);
    if (!previous || e.ticketNumber > previous.ticketNumber) entryByAppointment.set(e.appointmentId, e);
  }
  const appointmentById = new Map(appointments.data.map((a) => [a.id, a]));
  const nameOf = (a: Row | undefined) => (a?.patient ? `${a.patient.firstName} ${a.patient.lastName}` : t('reception.hiddenPatient'));

  const columns: Column<Row>[] = [
    {
      id: 'time',
      header: t('columns.time'),
      className: 'w-28',
      cell: (a) => (
        <span className="grid leading-tight">
          <Link href={`/w/${ws.clinic.slug}/appointments/${a.id}`} className="focus-ring rounded-sm font-medium text-accent hover:underline">
            <time dateTime={a.startsAt}>{formatTime(locale, a.startsAt, tz)}</time>
            <span className="sr-only"> — {t('appointment.open')}</span>
          </Link>
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
          {entryByAppointment.get(a.id) && a.status === 'checked_in' ? (
            <Badge tone="accent">{t('reception.ticket', { ticket: entryByAppointment.get(a.id)?.ticketNumber ?? 0 })}</Badge>
          ) : null}
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
      cell: (a) => {
        const entry = entryByAppointment.get(a.id);
        const open = entry && (entry.state === 'waiting' || entry.state === 'called');
        return (
          <span className="flex items-center justify-end gap-1">
            {canCheckIn && a.status === 'confirmed' ? (
              <CheckInButton appointmentId={a.id} version={a.version} patientName={nameOf(a)} timeLabel={formatTime(locale, a.startsAt, tz)} />
            ) : null}
            {canMarkLeft && entry && open && a.status === 'checked_in' ? (
              <MarkLeftButton queueEntryId={entry.id} patientName={nameOf(a)} ticket={entry.ticketNumber} />
            ) : null}
            {canBook ? (
              <AppointmentRowActions
                timeZone={tz}
                actions={availableActions(a, now, grace)}
                appointment={{
                  id: a.id,
                  version: a.version,
                  doctorId: a.doctorId,
                  serviceId: a.serviceId,
                  day,
                  patientName: nameOf(a),
                  timeLabel: formatTime(locale, a.startsAt, tz),
                }}
              />
            ) : null}
          </span>
        );
      },
    },
  ];

  // Waiting room (today): per doctor, entries not yet seen, in queue order.
  const waiting = waitingOrder(entries);
  const waitingDoctors = activeDoctors.filter((d) => waiting.some((e) => e.doctorId === d.id) && (!doctorFilter || d.id === doctorFilter));
  // MD-09 end-of-day list: confirmed but never checked in, grace period over.
  const unresolved = day <= todayLocal ? unresolvedAppointments(appointments.data, now, grace) : [];

  return (
    <>
      {header}
      {isToday && queue ? (
        <Section id="waiting-room" title={t('reception.waitingRoom')} description={t('reception.waitingRoomHint')} className="mb-6">
          {queue.status !== 'ok' ? (
            <LoadFailure outcome={queue} />
          ) : waitingDoctors.length === 0 ? (
            <p className="rounded-lg border border-line bg-surface px-4 py-3 text-small text-ink-muted">{t('reception.waitingEmpty')}</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {waitingDoctors.map((d) => {
                const list = waiting.filter((e) => e.doctorId === d.id);
                const doctorName = doctorDisplayName(locale, d.fullName, d.fullNameAr);
                return (
                  <section key={d.id} aria-labelledby={`wr-${d.id}`} className="rounded-lg border border-line bg-surface">
                    <h3 id={`wr-${d.id}`} className="flex items-baseline justify-between gap-2 border-b border-line px-4 py-2.5 text-body font-medium text-ink">
                      <span>{doctorName}</span>
                      <span className="text-small font-normal text-ink-muted">{t('reception.waitingCount', { count: list.length })}</span>
                    </h3>
                    <ol className="divide-y divide-line">
                      {list.map((e) => {
                        const a = appointmentById.get(e.appointmentId);
                        return (
                          <li key={e.id} className="flex items-center gap-3 px-4 py-2">
                            <span className="w-14 shrink-0 font-medium tabular text-ink">{t('reception.ticket', { ticket: e.ticketNumber })}</span>
                            <span className="grid min-w-0 flex-1 leading-tight">
                              <span className="truncate text-body text-ink">{nameOf(a)}</span>
                              <span className="text-small text-ink-muted">
                                {t('reception.waitingSince', { time: formatTime(locale, e.checkedInAt, tz), minutes: minutesSince(e.checkedInAt, now) })}
                              </span>
                            </span>
                            {canMarkLeft ? <MarkLeftButton queueEntryId={e.id} patientName={nameOf(a)} ticket={e.ticketNumber} /> : null}
                          </li>
                        );
                      })}
                    </ol>
                  </section>
                );
              })}
            </div>
          )}
        </Section>
      ) : null}
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
      {unresolved.length > 0 ? (
        <Section id="end-of-day" title={t('reception.endOfDay', { count: unresolved.length })} description={t('reception.endOfDayHint')} className="mt-6">
          <DataTable caption={t('reception.endOfDay', { count: unresolved.length })} columns={columns} rows={unresolved} getRowId={(a) => a.id} />
        </Section>
      ) : null}
    </>
  );
}
