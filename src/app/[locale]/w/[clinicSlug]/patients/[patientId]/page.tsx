import { CalendarDays } from 'lucide-react';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { APPOINTMENT_STATUSES, type AppointmentStatus } from '@/modules/appointments/domain/status';
import { AppointmentStatusBadge } from '@/modules/appointments/ui/status-badge';
import { doctorDisplayName, localizedName } from '@/modules/catalog/names';
import { loadCatalog } from '@/modules/catalog/queries';
import { loadConsents, loadDuplicates, loadMergedSources, loadPatient, loadPatientAppointments, type PatientAppointment } from '@/modules/patients/queries';
import { CONSENT_PURPOSES } from '@/modules/patients/schemas';
import { ArchiveButton, ConsentToggle, EditPatientDialog, MergeButton } from '@/modules/patients/ui/patient-detail';
import { can, loadWorkspace } from '@/modules/tenancy/workspace';
import { formatDateTime, formatLocalDay, formatShortDate } from '@/shared/lib/format';
import { formatPhone } from '@/shared/lib/phone';
import { Badge } from '@/shared/ui/badge';
import { DataTable, type Column } from '@/shared/ui/data-table';
import { DetailList, PageHeader, Section } from '@/shared/ui/layout';
import { EmptyState, ErrorState, InlineAlert } from '@/shared/ui/states';

import { LoadFailure } from '../../_lib/page-state';

export async function generateMetadata() {
  const t = await getTranslations('patientDetail');
  return { title: t('title') };
}

/**
 * Patient file: administrative identity, consents (with history), appointments, duplicates.
 * Opening it writes `patient.viewed` to the audit log (through get_patient).
 */
export default async function PatientDetailPage({ params }: { params: Promise<{ clinicSlug: string; patientId: string }> }) {
  const { clinicSlug, patientId } = await params;
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const result = await loadWorkspace(clinicSlug);
  if (result.status !== 'ok') return null;
  const ws = result.workspace;
  if (!can(ws, 'patients.view')) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <ErrorState title={t('states.forbiddenTitle')} description={t('states.forbiddenBody')} />
      </div>
    );
  }
  if (!/^[0-9a-f-]{36}$/.test(patientId)) notFound();

  const patient = await loadPatient(patientId);
  if (patient.status === 'error' && patient.code === 'NOT_FOUND') notFound();
  if (patient.status !== 'ok') return <LoadFailure outcome={patient} />;
  const p = patient.data;
  const tz = ws.clinic.timezone;
  const sources = await loadMergedSources(ws.clinic.id, p.id);
  const ids = [p.id, ...sources];
  const [consents, appointments, catalog, duplicates] = await Promise.all([
    loadConsents(ids),
    can(ws, 'appointments.view') ? loadPatientAppointments(ws.clinic.id, ids) : Promise.resolve(null),
    loadCatalog(ws.clinic.id),
    can(ws, 'patients.merge') && p.status === 'active' ? loadDuplicates(p.id) : Promise.resolve(null),
  ]);
  const editable = ws.clinic.status !== 'suspended' && p.status !== 'merged';
  const name = `${p.firstName} ${p.lastName}`;
  const doctors = new Map(catalog.status === 'ok' ? catalog.data.doctors.map((d) => [d.id, doctorDisplayName(locale, d.fullName, d.fullNameAr)]) : []);
  const services = new Map(catalog.status === 'ok' ? catalog.data.services.map((s) => [s.id, localizedName(locale, s.nameFr, s.nameAr)]) : []);
  const statusTone = { active: 'success', archived: 'neutral', merged: 'warning' } as const;

  const appointmentColumns: Column<PatientAppointment>[] = [
    { id: 'when', header: t('columns.when'), className: 'w-44', cell: (a) => <time dateTime={a.startsAt} className="tabular">{formatDateTime(locale, a.startsAt, tz)}</time> },
    { id: 'doctor', header: t('columns.doctor'), hideBelow: 'md', cell: (a) => doctors.get(a.doctorId) ?? '—' },
    { id: 'service', header: t('columns.service'), hideBelow: 'lg', cell: (a) => services.get(a.serviceId) ?? '—' },
    {
      id: 'status',
      header: t('columns.status'),
      className: 'w-36',
      cell: (a) => ((APPOINTMENT_STATUSES as readonly string[]).includes(a.status) ? <AppointmentStatusBadge status={a.status as AppointmentStatus} /> : a.status),
    },
  ];

  return (
    <>
      <nav aria-label={t('patientDetail.breadcrumb')} className="text-small">
        <Link href={`/w/${ws.clinic.slug}/patients`} className="focus-ring rounded-sm text-accent hover:underline">
          {t('patients.title')}
        </Link>
      </nav>
      <PageHeader
        title={name}
        meta={
          <span className="flex flex-wrap items-center gap-2">
            <span className="tabular">{t('patientDetail.file', { fileNumber: p.fileNumber })}</span>
            <Badge tone={statusTone[p.status]} dot>{t(`patientDetail.status.${p.status}`)}</Badge>
          </span>
        }
        actions={
          editable ? (
            <>
              {can(ws, 'patients.update') && p.status === 'active' ? (
                <EditPatientDialog
                  patientId={p.id}
                  values={{
                    firstName: p.firstName,
                    lastName: p.lastName,
                    firstNameAr: p.firstNameAr ?? '',
                    lastNameAr: p.lastNameAr ?? '',
                    sex: p.sex ?? '',
                    dateOfBirth: p.dateOfBirth ?? '',
                    phone: p.phone ?? '',
                    preferredLocale: p.preferredLocale,
                    preferredChannel: p.preferredChannel === 'whatsapp' ? 'sms' : p.preferredChannel,
                  }}
                />
              ) : null}
              {can(ws, 'patients.archive') ? <ArchiveButton patientId={p.id} archived={p.status === 'archived'} /> : null}
            </>
          ) : null
        }
      />
      {p.status === 'merged' && p.mergedIntoId ? (
        <InlineAlert tone="warning" title={t('patientDetail.mergedNotice')}>
          <Link href={`/w/${ws.clinic.slug}/patients/${p.mergedIntoId}`} className="text-accent underline">
            {t('patientDetail.openSurvivor')}
          </Link>
        </InlineAlert>
      ) : null}
      {sources.length > 0 ? <InlineAlert tone="info">{t('patientDetail.includesMerged', { count: sources.length })}</InlineAlert> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="grid content-start gap-6">
          <Section id="identity" title={t('patientDetail.identity')}>
            <div className="rounded-lg border border-line bg-surface p-4">
              <DetailList
                items={[
                  { label: t('patients.form.firstNameAr'), value: p.firstNameAr || p.lastNameAr ? <span lang="ar" dir="rtl">{`${p.firstNameAr ?? ''} ${p.lastNameAr ?? ''}`.trim()}</span> : '—' },
                  { label: t('patients.form.sex'), value: p.sex ? t(p.sex === 'female' ? 'patients.form.sexFemale' : 'patients.form.sexMale') : '—' },
                  { label: t('patients.form.dateOfBirth'), value: p.dateOfBirth ? formatLocalDay(locale, p.dateOfBirth) : '—' },
                  { label: t('patients.form.phone'), value: p.phone ? <span dir="ltr" className="tabular">{formatPhone(p.phone)}</span> : '—' },
                  { label: t('patients.form.channel'), value: t(`patientDetail.channel.${p.preferredChannel}`) },
                  { label: t('patients.form.preferredLocale'), value: p.preferredLocale === 'ar' ? 'العربية' : 'Français' },
                  { label: t('columns.createdAt'), value: formatShortDate(locale, p.createdAt, tz) },
                ]}
              />
            </div>
          </Section>

          <Section id="consents" title={t('patientDetail.consents')} description={t('patientDetail.consentsHint')}>
            {consents.status !== 'ok' ? (
              <LoadFailure outcome={consents} />
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
                {CONSENT_PURPOSES.map((purpose) => {
                  const current = consents.data.find((c) => c.purpose === purpose);
                  return (
                    <li key={purpose} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <span className="grid leading-tight">
                        <span className="text-body text-ink">{t(`patientDetail.consentPurpose.${purpose}`)}</span>
                        <span className="text-small text-ink-muted">
                          {current
                            ? t(current.granted ? 'patientDetail.grantedOn' : 'patientDetail.withdrawnOn', { date: formatShortDate(locale, current.recordedAt, tz) })
                            : t('patientDetail.notRecorded')}
                        </span>
                      </span>
                      {editable && can(ws, 'consents.record') && purpose !== 'data_processing' ? (
                        <ConsentToggle slug={ws.clinic.slug} patientId={p.id} purpose={purpose} granted={current?.granted ?? null} />
                      ) : current ? (
                        <Badge tone={current.granted ? 'success' : 'neutral'}>{current.granted ? t('patientDetail.granted') : t('patientDetail.withdrawn')}</Badge>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        </div>

        <div className="grid content-start gap-6">
          {appointments ? (
            <Section id="appointments" title={t('patientDetail.appointments')}>
              {appointments.status !== 'ok' ? (
                <LoadFailure outcome={appointments} />
              ) : (
                <DataTable
                  caption={t('patientDetail.appointments')}
                  columns={appointmentColumns}
                  rows={appointments.data}
                  getRowId={(a) => a.id}
                  empty={<EmptyState icon={CalendarDays} title={t('patientDetail.noAppointments')} />}
                />
              )}
            </Section>
          ) : null}

          {duplicates && duplicates.status === 'ok' && duplicates.data.length > 0 ? (
            <Section id="duplicates" title={t('patientDetail.duplicates')} description={t('patientDetail.duplicatesHint')}>
              <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
                {duplicates.data.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                    <span className="grid leading-tight">
                      <Link href={`/w/${ws.clinic.slug}/patients/${d.id}`} className="focus-ring rounded-sm font-medium text-ink hover:underline">
                        {d.name}
                      </Link>
                      <span className="text-small text-ink-muted tabular">
                        {d.fileNumber} · {t(`patientDetail.duplicateReason.${d.reason}`)}
                      </span>
                    </span>
                    {editable ? <MergeButton sourceId={d.id} sourceLabel={`${d.name} (${d.fileNumber})`} targetId={p.id} targetLabel={`${name} (${p.fileNumber})`} /> : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>
      </div>
    </>
  );
}
