import { ArrowLeft } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import { z } from 'zod';

import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { availableActions } from '@/modules/appointments/domain/status';
import { loadAppointmentInvoice } from '@/modules/billing/queries';
import { NewInvoiceButton } from '@/modules/billing/ui/invoice-actions';
import { loadAppointmentFile, loadCheckinGrace, type AppointmentEvent } from '@/modules/appointments/queries';
import { AppointmentRowActions } from '@/modules/appointments/ui/row-actions';
import { AppointmentStatusBadge } from '@/modules/appointments/ui/status-badge';
import { doctorDisplayName, localizedName } from '@/modules/catalog/names';
import { loadCatalog } from '@/modules/catalog/queries';
import { loadAppointmentMessages } from '@/modules/notifications/queries';
import { MessageLog } from '@/modules/notifications/ui/message-log';
import { can, loadWorkspace } from '@/modules/tenancy/workspace';
import { formatDateTime, formatLongDate, formatMoney, formatTime } from '@/shared/lib/format';
import { formatPhone } from '@/shared/lib/phone';
import { localDay, requestNow } from '@/shared/lib/time';
import { Badge } from '@/shared/ui/badge';
import { DetailList, PageHeader, Section } from '@/shared/ui/layout';
import { ErrorState } from '@/shared/ui/states';

import { LoadFailure } from '../../_lib/page-state';

export async function generateMetadata() {
  const t = await getTranslations('appointment');
  return { title: t('title') };
}

/**
 * Appointment file: what was booked, by whom, its current status, the actions still possible,
 * the append-only history and, with notifications.view_log, the messages planned for the patient.
 * The visit reason is shown only with appointments.view_reason (the database withholds it otherwise).
 */
export default async function AppointmentPage({ params }: { params: Promise<{ clinicSlug: string; appointmentId: string }> }) {
  const { clinicSlug, appointmentId } = await params;
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const result = await loadWorkspace(clinicSlug);
  if (result.status !== 'ok') return null;
  const ws = result.workspace;
  const notFound = (
    <div className="rounded-lg border border-line bg-surface">
      <ErrorState title={t('states.notFoundTitle')} description={t('states.notFoundBody')} />
    </div>
  );
  if (!can(ws, 'appointments.view')) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <ErrorState title={t('states.forbiddenTitle')} description={t('states.forbiddenBody')} />
      </div>
    );
  }
  if (!z.uuid().safeParse(appointmentId).success) return notFound;

  const canViewMessages = can(ws, 'notifications.view_log');
  const [file, catalog, grace, messages, invoice] = await Promise.all([
    loadAppointmentFile(ws.clinic.id, appointmentId),
    loadCatalog(ws.clinic.id),
    loadCheckinGrace(ws.clinic.id),
    canViewMessages ? loadAppointmentMessages(ws.clinic.id, appointmentId) : null,
    can(ws, 'invoices.view') ? loadAppointmentInvoice(ws.clinic.id, appointmentId) : null,
  ]);
  if (file.status === 'error' && file.code === 'NOT_FOUND') return notFound;
  if (file.status !== 'ok') return <LoadFailure outcome={file} />;
  const { appointment: a, history } = file.data;

  const tz = ws.clinic.timezone;
  const slug = ws.clinic.slug;
  const day = localDay(new Date(a.startsAt), tz);
  const doctor = catalog.status === 'ok' ? catalog.data.doctors.find((d) => d.id === a.doctorId) : undefined;
  const service = catalog.status === 'ok' ? catalog.data.services.find((s) => s.id === a.serviceId) : undefined;
  const patientName = a.patient ? `${a.patient.firstName} ${a.patient.lastName}` : t('reception.hiddenPatient');
  const timeRange = `${formatTime(locale, a.startsAt, tz)}–${formatTime(locale, a.endsAt, tz)}`;
  const canBook = can(ws, 'appointments.book');
  const backHref = canBook ? `/w/${slug}/reception?day=${day}&doctor=${a.doctorId}` : `/w/${slug}/doctor?day=${day}`;
  const editable = ws.clinic.status !== 'suspended' && canBook;
  // One open invoice per appointment: link to it, or offer to bill (not pending or cancelled).
  const openInvoice = invoice?.status === 'ok' ? invoice.data : null;
  const billable = ws.clinic.status !== 'suspended' && can(ws, 'invoices.create') && invoice?.status === 'ok'
    && !openInvoice && a.status !== 'pending' && a.status !== 'cancelled';

  const actorLabel = (e: Pick<AppointmentEvent, 'actorType' | 'actorName'>) =>
    e.actorType === 'user' ? (e.actorName ?? t('appointment.actor.user')) : t(`appointment.actor.${e.actorType}`);

  const describe = (e: AppointmentEvent) => {
    switch (e.eventType) {
      case 'created':
        return t('appointment.event.created');
      case 'status_changed':
        return t('appointment.event.status_changed', {
          from: e.fromStatus ? t(`appointmentStatus.${e.fromStatus}`) : '—',
          to: e.toStatus ? t(`appointmentStatus.${e.toStatus}`) : '—',
        });
      case 'rescheduled':
        return t('appointment.event.rescheduled', {
          from: e.previousStartsAt ? formatDateTime(locale, e.previousStartsAt, tz) : '—',
          to: e.newStartsAt ? formatDateTime(locale, e.newStartsAt, tz) : '—',
        });
      default:
        return t('appointment.event.details_changed');
    }
  };

  const details = [
    {
      label: t('columns.patient'),
      value: a.patient ? (
        <span className="grid">
          {can(ws, 'patients.view') ? (
            <Link href={`/w/${slug}/patients/${a.patient.id}`} className="focus-ring rounded-sm font-medium text-accent hover:underline">
              {patientName}
            </Link>
          ) : (
            <span className="font-medium">{patientName}</span>
          )}
          <span className="text-small text-ink-muted tabular">
            {a.patient.fileNumber}
            {a.patient.phone ? <span dir="ltr"> · {formatPhone(a.patient.phone)}</span> : null}
          </span>
        </span>
      ) : (
        <span className="text-ink-subtle">{patientName}</span>
      ),
    },
    { label: t('columns.doctor'), value: doctor ? doctorDisplayName(locale, doctor.fullName, doctor.fullNameAr) : '—' },
    { label: t('columns.service'), value: service ? localizedName(locale, service.nameFr, service.nameAr) : '—' },
    { label: t('appointment.date'), value: formatLongDate(locale, a.startsAt, tz) },
    { label: t('appointment.time'), value: <span className="tabular" dir="ltr">{timeRange}</span> },
    { label: t('appointment.source'), value: t(`source.${a.source}`) },
    { label: t('appointment.price'), value: <span className="tabular">{formatMoney(locale, a.priceMad)}</span> },
    { label: t('appointment.bookedBy'), value: a.bookedByName ?? <span className="text-ink-subtle">—</span> },
    ...(can(ws, 'appointments.view_reason')
      ? [{ label: t('appointment.visitReason'), value: a.patientReason ?? <span className="text-ink-subtle">{t('appointment.visitReasonEmpty')}</span> }]
      : []),
    ...(a.isOverbooked ? [{ label: t('appointment.overbookReason'), value: a.overbookReason ?? '—' }] : []),
    ...(a.status === 'cancelled'
      ? [{
          label: t('appointment.cancellation'),
          value: t('appointment.cancellationValue', {
            reason: a.cancellationReason ? t(`cancellationReason.${a.cancellationReason}`) : '—',
            actor: a.cancellationActor ? t(`appointment.cancelledBy.${a.cancellationActor}`) : '—',
          }),
        }]
      : []),
  ];

  return (
    <>
      <PageHeader
        title={patientName}
        description={t('appointment.subtitle', { date: formatLongDate(locale, a.startsAt, tz), time: timeRange })}
        meta={
          <span className="flex flex-wrap items-center gap-2">
            <Link href={backHref} className="focus-ring inline-flex items-center gap-1 rounded-sm text-small text-ink-muted hover:text-ink">
              <ArrowLeft aria-hidden className="size-4 flip-rtl" />
              {t('appointment.backToDay')}
            </Link>
            <AppointmentStatusBadge status={a.status} />
            {a.isOverbooked ? <Badge tone="warning">{t('reception.overbooked')}</Badge> : null}
          </span>
        }
        actions={
          <>
            {openInvoice ? (
              <Link href={`/w/${slug}/billing/${openInvoice.id}`} className="focus-ring rounded-sm text-small font-medium text-accent hover:underline">
                {openInvoice.number ? t('billing.invoiceNumber', { number: openInvoice.number }) : t('billing.openDraft')}
              </Link>
            ) : null}
            {billable ? <NewInvoiceButton slug={slug} appointmentId={a.id} label={t('billing.bill')} /> : null}
            {editable ? (
              <AppointmentRowActions
                timeZone={tz}
                actions={availableActions(a, requestNow(), grace)}
                appointment={{ id: a.id, version: a.version, doctorId: a.doctorId, serviceId: a.serviceId, day, patientName, timeLabel: formatTime(locale, a.startsAt, tz) }}
              />
            ) : null}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Section id="details" title={t('appointment.details')}>
          <div className="rounded-lg border border-line bg-surface p-4">
            <DetailList items={details} />
          </div>
        </Section>

        <Section id="history" title={t('appointment.history')} description={t('appointment.historyHint')}>
          {history.length === 0 ? (
            <p className="text-small text-ink-muted">{t('appointment.historyEmpty')}</p>
          ) : (
            <ol className="grid gap-0 rounded-lg border border-line bg-surface">
              {history.map((e, i) => (
                <li key={`${e.occurredAt}-${i}`} className="grid gap-0.5 border-b border-line px-4 py-3 last:border-b-0">
                  <span className="text-body text-ink">{describe(e)}</span>
                  {e.reason ? <span className="text-small text-ink-muted">{t('appointment.eventReason', { reason: e.reason })}</span> : null}
                  <span className="text-caption text-ink-subtle">
                    <time dateTime={e.occurredAt} className="tabular">{formatDateTime(locale, e.occurredAt, tz)}</time>
                    {' · '}
                    {actorLabel(e)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Section>

        {messages ? (
          <Section id="messages" title={t('appointment.messages')} description={t('appointment.messagesHint')}>
            <MessageLog messages={messages} timeZone={tz} />
          </Section>
        ) : null}
      </div>
    </>
  );
}
