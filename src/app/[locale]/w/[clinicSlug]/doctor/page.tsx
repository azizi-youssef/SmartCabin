import { Clock3, Stethoscope } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { ACTIVE_STATUSES, availableActions } from '@/modules/appointments/domain/status';
import { loadCheckinGrace, loadDayAppointments } from '@/modules/appointments/queries';
import { DayNav } from '@/modules/appointments/ui/day-nav';
import { AppointmentRowActions } from '@/modules/appointments/ui/row-actions';
import { AppointmentStatusBadge } from '@/modules/appointments/ui/status-badge';
import { localizedName } from '@/modules/catalog/names';
import { loadCatalog } from '@/modules/catalog/queries';
import { can, loadWorkspace } from '@/modules/tenancy/workspace';
import { cn } from '@/shared/lib/cn';
import { formatLocalDay, formatNumber, formatTime } from '@/shared/lib/format';
import { isLocalDay, today } from '@/shared/lib/time';
import { MetricStrip, PageHeader, Section } from '@/shared/ui/layout';
import { EmptyState, InlineAlert } from '@/shared/ui/states';

import { LoadFailure } from '../_lib/page-state';

export async function generateMetadata() {
  const t = await getTranslations('doctor');
  return { title: t('title') };
}

/**
 * Doctor workspace: the practitioner's own day — next patient first, then the agenda.
 * Scoped to the doctor records linked to the signed-in account (and by RLS for the doctor role).
 */
export default async function DoctorPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicSlug: string }>;
  searchParams: Promise<{ day?: string }>;
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

  const header = <PageHeader title={t('doctor.title')} meta={formatLocalDay(locale, day)} actions={<DayNav day={day} today={todayLocal} />} />;

  const catalog = await loadCatalog(ws.clinic.id);
  if (catalog.status !== 'ok') return (<>{header}<LoadFailure outcome={catalog} /></>);
  const myDoctorIds = catalog.data.doctors.filter((d) => d.userId === ws.session.userId).map((d) => d.id);
  if (myDoctorIds.length === 0) {
    return (
      <>
        {header}
        <div className="rounded-lg border border-line bg-surface">
          <EmptyState icon={Stethoscope} title={t('doctor.notLinked')} description={t('doctor.notLinkedHint')} />
        </div>
      </>
    );
  }

  const [appointments, grace] = await Promise.all([
    loadDayAppointments({ clinicId: ws.clinic.id, day, timeZone: tz, doctorIds: myDoctorIds }),
    loadCheckinGrace(ws.clinic.id),
  ]);
  if (appointments.status !== 'ok') return (<>{header}<LoadFailure outcome={appointments} /></>);

  const rows = appointments.data;
  const services = new Map(catalog.data.services.map((s) => [s.id, localizedName(locale, s.nameFr, s.nameAr)]));
  const now = new Date();
  const remaining = rows.filter((a) => (ACTIVE_STATUSES as readonly string[]).includes(a.status) && new Date(a.endsAt) > now);
  const nextUp = day === todayLocal ? remaining[0] : undefined;
  const canAct = can(ws, 'appointments.cancel') && ws.clinic.status !== 'suspended';

  return (
    <>
      {header}
      <MetricStrip
        label={t('doctor.metricsLabel')}
        metrics={[
          { id: 'planned', label: t('doctor.planned'), value: formatNumber(locale, rows.filter((a) => a.status !== 'cancelled').length) },
          { id: 'remaining', label: t('doctor.remaining'), value: formatNumber(locale, remaining.length) },
          { id: 'completed', label: t('doctor.completed'), value: formatNumber(locale, rows.filter((a) => a.status === 'completed').length), tone: 'success' },
          { id: 'absent', label: t('doctor.absent'), value: formatNumber(locale, rows.filter((a) => a.status === 'no_show').length) },
        ]}
      />

      {day === todayLocal ? (
        <Section id="next" title={t('doctor.nextTitle')}>
          {nextUp ? (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-accent-line bg-accent-soft px-4 py-3">
              <time dateTime={nextUp.startsAt} className="flex items-center gap-2 text-title tabular text-ink">
                <Clock3 aria-hidden className="size-5 text-accent" />
                {formatTime(locale, nextUp.startsAt, tz)}
              </time>
              <div className="grid min-w-0 flex-1 leading-tight">
                <span className="truncate text-heading text-ink">
                  {nextUp.patient ? `${nextUp.patient.firstName} ${nextUp.patient.lastName}` : t('reception.hiddenPatient')}
                </span>
                <span className="truncate text-small text-ink-muted">
                  {services.get(nextUp.serviceId)}
                  {nextUp.patient ? ` · ${t('doctor.patientFile', { fileNumber: nextUp.patient.fileNumber })}` : ''}
                </span>
              </div>
              <AppointmentStatusBadge status={nextUp.status} />
            </div>
          ) : (
            <div className="rounded-lg border border-line bg-surface">
              <EmptyState title={t('doctor.nextEmpty')} />
            </div>
          )}
        </Section>
      ) : null}

      <Section id="agenda" title={t('doctor.agendaTitle')}>
        {rows.length === 0 ? (
          <div className="rounded-lg border border-line bg-surface">
            <EmptyState title={t('doctor.empty')} />
          </div>
        ) : (
          <ol className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {rows.map((a) => {
              const muted = a.status === 'cancelled' || a.status === 'no_show';
              const name = a.patient ? `${a.patient.firstName} ${a.patient.lastName}` : t('reception.hiddenPatient');
              return (
                <li key={a.id} className={cn('grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-2.5', a.id === nextUp?.id && 'bg-accent-soft/60')}>
                  <span className="grid leading-tight tabular">
                    <Link href={`/w/${ws.clinic.slug}/appointments/${a.id}`} className={cn('focus-ring rounded-sm font-medium hover:underline', muted ? 'text-ink-subtle' : 'text-accent')}>
                      <time dateTime={a.startsAt}>{formatTime(locale, a.startsAt, tz)}</time>
                      <span className="sr-only"> — {t('appointment.open')}</span>
                    </Link>
                    <time dateTime={a.endsAt} className="text-small text-ink-subtle">{formatTime(locale, a.endsAt, tz)}</time>
                  </span>
                  <span className="grid min-w-0 leading-tight">
                    <span className={cn('truncate font-medium', muted ? 'text-ink-muted line-through decoration-ink-subtle' : 'text-ink')}>{name}</span>
                    <span className="truncate text-small text-ink-muted">{services.get(a.serviceId)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <AppointmentStatusBadge status={a.status} />
                    {canAct ? (
                      <AppointmentRowActions
                        timeZone={tz}
                        actions={{ ...availableActions(a, now, grace), confirm: false }}
                        appointment={{ id: a.id, version: a.version, doctorId: a.doctorId, serviceId: a.serviceId, day, patientName: name, timeLabel: formatTime(locale, a.startsAt, tz) }}
                      />
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </Section>
      <InlineAlert tone="info">{t('doctor.consultationNote')}</InlineAlert>
    </>
  );
}
