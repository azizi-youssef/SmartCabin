import { ArrowLeft, CalendarClock, CalendarOff } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { loadCatalog } from '@/modules/catalog/queries';
import { loadDoctorAvailability, type BookingConflict, type TimeOff } from '@/modules/scheduling/queries';
import { currentRegular, weeklyMinutes, type DoctorSchedule } from '@/modules/scheduling/schemas';
import { DeleteScheduleButton, OverrideDialog, RegularHoursForm } from '@/modules/scheduling/ui/schedule-forms';
import { DeleteTimeOffButton, TimeOffDialog } from '@/modules/scheduling/ui/time-off';
import { can, loadWorkspace } from '@/modules/tenancy/workspace';
import { formatDateTime, formatLocalDay } from '@/shared/lib/format';
import { localDay, requestNow, today as todayIn } from '@/shared/lib/time';
import { DataTable, type Column } from '@/shared/ui/data-table';
import { PageHeader, Section } from '@/shared/ui/layout';
import { EmptyState, ErrorState, InlineAlert } from '@/shared/ui/states';

import { LoadFailure } from '../../_lib/page-state';

export async function generateMetadata() {
  const t = await getTranslations('schedules');
  return { title: t('doctorTitle') };
}

/**
 * One doctor's availability: regular weekly hours, dated overrides (e.g. Ramadan), time off, and
 * the future appointments that no longer fit (BR-B-12: they are listed, never moved).
 */
export default async function DoctorSchedulePage({ params }: { params: Promise<{ clinicSlug: string; doctorId: string }> }) {
  const { clinicSlug, doctorId } = await params;
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const result = await loadWorkspace(clinicSlug);
  if (result.status !== 'ok') return null;
  const ws = result.workspace;
  if (!can(ws, 'schedules.view')) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <ErrorState title={t('states.forbiddenTitle')} description={t('states.forbiddenBody')} />
      </div>
    );
  }

  const catalog = await loadCatalog(ws.clinic.id);
  if (catalog.status !== 'ok') return <LoadFailure outcome={catalog} />;
  const doctor = catalog.data.doctors.find((d) => d.id === doctorId);
  if (!doctor || (ws.role === 'doctor' && doctor.userId !== ws.session.userId)) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <ErrorState title={t('states.notFoundTitle')} description={t('states.notFoundBody')} />
      </div>
    );
  }

  const tz = ws.clinic.timezone;
  const now = requestNow();
  const today = todayIn(tz, now);
  const availability = await loadDoctorAvailability(ws.clinic.id, doctor.id, now);
  if (availability.status !== 'ok') return <LoadFailure outcome={availability} />;
  const { schedules, timeOff, conflicts } = availability.data;

  const slug = ws.clinic.slug;
  const writable = ws.clinic.status !== 'suspended';
  const canEdit = writable && can(ws, 'schedules.manage');
  const canTimeOff = writable && can(ws, 'time_off.manage');
  const canOpenAgenda = can(ws, 'appointments.book');
  const regular = currentRegular(schedules, today);
  const otherRegular = schedules.filter((s) => s.kind === 'regular' && s.id !== regular?.id);
  const overrides = schedules.filter((s) => s.kind === 'override' && (s.validUntil ?? s.validFrom) >= today);
  const hours = (minutes: number) =>
    minutes % 60 === 0 ? t('schedules.weeklyHours', { hours: minutes / 60 }) : t('schedules.weeklyHoursMinutes', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
  const period = (from: string, until: string | null) =>
    until ? t('schedules.periodRange', { from: formatLocalDay(locale, from, 'short'), to: formatLocalDay(locale, until, 'short') }) : t('schedules.periodFrom', { from: formatLocalDay(locale, from, 'short') });
  const timeOffLabel = (o: TimeOff) => t('schedules.periodRange', { from: formatDateTime(locale, o.startsAt, tz), to: formatDateTime(locale, o.endsAt, tz) });

  const conflictColumns: Column<BookingConflict>[] = [
    { id: 'when', header: t('columns.when'), cell: (c) => <span className="tabular">{formatDateTime(locale, c.startsAt, tz)}</span> },
    { id: 'reason', header: t('schedules.conflictReason'), cell: (c) => t(`schedules.conflict.${c.reason}`) },
    {
      id: 'open',
      header: <span className="sr-only">{t('columns.actions')}</span>,
      align: 'end',
      className: 'w-px whitespace-nowrap',
      cell: (c) =>
        canOpenAgenda ? (
          <Link
            href={`/w/${slug}/reception?day=${localDay(new Date(c.startsAt), tz)}&doctor=${doctor.id}`}
            className="focus-ring rounded-sm text-small font-medium text-accent hover:underline"
          >
            {t('schedules.openAgenda')}
          </Link>
        ) : null,
    },
  ];

  const overrideColumns: Column<DoctorSchedule>[] = [
    { id: 'name', header: t('schedules.overrideName'), cell: (s) => <span className="font-medium">{s.name}</span> },
    { id: 'period', header: t('schedules.period'), cell: (s) => period(s.validFrom, s.validUntil) },
    {
      id: 'hours',
      header: t('schedules.hoursColumn'),
      hideBelow: 'md',
      cell: (s) => (s.windows.length === 0 ? <span className="text-ink-muted">{t('schedules.closedAllPeriod')}</span> : hours(weeklyMinutes(s.windows))),
    },
    {
      id: 'actions',
      header: <span className="sr-only">{t('columns.actions')}</span>,
      align: 'end',
      className: 'w-px whitespace-nowrap',
      cell: (s) =>
        canEdit ? (
          <span className="flex items-center justify-end gap-1">
            <OverrideDialog slug={slug} doctorId={doctor.id} override={s} regularWindows={regular?.windows ?? []} today={today} />
            <DeleteScheduleButton slug={slug} scheduleId={s.id} name={s.name} />
          </span>
        ) : null,
    },
  ];

  const timeOffColumns: Column<TimeOff>[] = [
    { id: 'period', header: t('schedules.period'), cell: (o) => <span className="tabular">{timeOffLabel(o)}</span> },
    { id: 'reason', header: t('schedules.timeOffReason'), cell: (o) => t(`schedules.reason.${o.reason}`) },
    { id: 'note', header: t('schedules.timeOffNote'), hideBelow: 'md', cell: (o) => o.note ?? <span className="text-ink-subtle">—</span> },
    {
      id: 'actions',
      header: <span className="sr-only">{t('columns.actions')}</span>,
      align: 'end',
      className: 'w-px whitespace-nowrap',
      cell: (o) => (canTimeOff ? <DeleteTimeOffButton slug={slug} timeOffId={o.id} label={timeOffLabel(o)} /> : null),
    },
  ];

  return (
    <>
      <PageHeader
        title={doctor.fullName}
        description={t('schedules.doctorSubtitle')}
        meta={
          <Link href={`/w/${slug}/schedules`} className="focus-ring inline-flex items-center gap-1 rounded-sm text-small text-ink-muted hover:text-ink">
            <ArrowLeft aria-hidden className="size-4 flip-rtl" />
            {t('schedules.backToList')}
          </Link>
        }
      />

      {conflicts.length > 0 ? (
        <Section id="conflicts" title={t('schedules.conflictsTitle', { count: conflicts.length })} className="mb-6">
          <InlineAlert tone="warning">
            {t('schedules.conflictsBody')}
          </InlineAlert>
          <DataTable className="mt-3" caption={t('schedules.conflictsTitle', { count: conflicts.length })} columns={conflictColumns} rows={conflicts} getRowId={(c) => c.appointmentId} />
        </Section>
      ) : null}

      <Section
        id="regular"
        title={t('schedules.regularTitle')}
        description={regular ? t('schedules.regularHint', { period: period(regular.validFrom, regular.validUntil) }) : t('schedules.regularEmpty')}
        className="mb-6"
      >
        <RegularHoursForm
          key={`${regular?.id ?? 'new'}:${JSON.stringify(regular?.windows ?? [])}`}
          slug={slug}
          doctorId={doctor.id}
          schedule={regular}
          defaultName={t('schedules.regularDefaultName')}
          today={today}
          editable={canEdit}
        />
        {otherRegular.length > 0 ? (
          <p className="mt-3 text-small text-ink-muted">
            {t('schedules.otherVersions', { list: otherRegular.map((s) => period(s.validFrom, s.validUntil)).join(' · ') })}
          </p>
        ) : null}
      </Section>

      <Section
        id="overrides"
        title={t('schedules.overridesTitle')}
        description={t('schedules.overridesHint')}
        actions={canEdit ? <OverrideDialog slug={slug} doctorId={doctor.id} regularWindows={regular?.windows ?? []} today={today} /> : null}
        className="mb-6"
      >
        <DataTable
          caption={t('schedules.overridesTitle')}
          columns={overrideColumns}
          rows={overrides}
          getRowId={(s) => s.id}
          empty={<EmptyState icon={CalendarClock} title={t('schedules.noOverrides')} description={t('schedules.noOverridesHint')} />}
        />
      </Section>

      <Section
        id="time-off"
        title={t('schedules.timeOffTitle')}
        description={t('schedules.timeOffSectionHint')}
        actions={canTimeOff ? <TimeOffDialog slug={slug} doctorId={doctor.id} today={today} /> : null}
      >
        <DataTable
          caption={t('schedules.timeOffTitle')}
          columns={timeOffColumns}
          rows={timeOff}
          getRowId={(o) => o.id}
          empty={<EmptyState icon={CalendarOff} title={t('schedules.noTimeOff')} description={t('schedules.noTimeOffHint')} />}
        />
      </Section>
    </>
  );
}
