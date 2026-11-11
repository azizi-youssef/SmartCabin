import { Search, Users } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { PATIENT_PAGE_SIZE, sanitizeSearch, searchPatients } from '@/modules/patients/queries';
import { CreatePatientDialog } from '@/modules/patients/ui/create-patient-dialog';
import { can, loadWorkspace } from '@/modules/tenancy/workspace';
import { formatLocalDay, formatShortDate } from '@/shared/lib/format';
import { formatPhone } from '@/shared/lib/phone';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { CellStack, DataTable, type Column } from '@/shared/ui/data-table';
import { Input } from '@/shared/ui/form-controls';
import { PageHeader } from '@/shared/ui/layout';
import { EmptyState, ErrorState } from '@/shared/ui/states';

import { LoadFailure } from '../_lib/page-state';

export async function generateMetadata() {
  const t = await getTranslations('patients');
  return { title: t('title') };
}

/** Patient records: server-side search, newest first by default, registration dialog. */
export default async function PatientsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicSlug: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const [{ clinicSlug }, query] = await Promise.all([params, searchParams]);
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

  const q = sanitizeSearch(query.q ?? '');
  const patients = await searchPatients({ clinicId: ws.clinic.id, query: q });
  const canCreate = can(ws, 'patients.create') && ws.clinic.status !== 'suspended';

  const header = (
    <PageHeader title={t('patients.title')} description={t('patients.subtitle')} actions={canCreate ? <CreatePatientDialog slug={ws.clinic.slug} /> : null} />
  );
  if (patients.status !== 'ok') return (<>{header}<LoadFailure outcome={patients} /></>);

  type Row = (typeof patients.data.rows)[number];
  const columns: Column<Row>[] = [
    {
      id: 'patient',
      header: t('columns.patient'),
      cell: (p) => (
        <CellStack
          primary={
            <Link href={`/w/${ws.clinic.slug}/patients/${p.id}`} className="focus-ring rounded-sm hover:underline">
              {`${p.firstName} ${p.lastName}`}
            </Link>
          }
          secondary={p.firstNameAr || p.lastNameAr ? <span lang="ar" dir="rtl">{`${p.firstNameAr ?? ''} ${p.lastNameAr ?? ''}`.trim()}</span> : undefined}
        />
      ),
    },
    { id: 'file', header: t('columns.fileNumber'), className: 'w-28', cell: (p) => <span className="tabular">{p.fileNumber}</span> },
    { id: 'dob', header: t('columns.dateOfBirth'), hideBelow: 'md', className: 'w-36', cell: (p) => (p.dateOfBirth ? formatLocalDay(locale, p.dateOfBirth, 'short') : '—') },
    { id: 'phone', header: t('columns.phone'), hideBelow: 'sm', className: 'w-44', cell: (p) => (p.phone ? <span dir="ltr" className="tabular">{formatPhone(p.phone)}</span> : '—') },
    { id: 'lang', header: t('columns.language'), hideBelow: 'lg', className: 'w-24', cell: (p) => (p.preferredLocale === 'ar' ? 'العربية' : 'Français') },
    {
      id: 'created',
      header: t('columns.createdAt'),
      hideBelow: 'lg',
      className: 'w-36',
      cell: (p) => (
        <span className="flex items-center gap-2">
          {formatShortDate(locale, p.createdAt, ws.clinic.timezone)}
          {p.status === 'archived' ? <Badge>{t('patients.archived')}</Badge> : null}
        </span>
      ),
    },
  ];

  const { rows, hasMore } = patients.data;
  return (
    <>
      {header}
      <DataTable
        caption={q ? t('patients.results', { count: rows.length, query: q }) : t('patients.recent')}
        columns={columns}
        rows={rows}
        getRowId={(p) => p.id}
        toolbar={
          <form role="search" className="flex w-full flex-wrap items-center gap-2" action="">
            <label htmlFor="patient-search" className="sr-only">
              {t('patients.searchLabel')}
            </label>
            <div className="relative min-w-0 flex-1 sm:max-w-md">
              <Search aria-hidden className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
              <Input id="patient-search" name="q" type="search" defaultValue={q} placeholder={t('patients.searchPlaceholder')} className="ps-9" />
            </div>
            <Button type="submit" variant="secondary">
              {t('common.search')}
            </Button>
            <span className="ms-auto text-small text-ink-muted">{q ? t('patients.results', { count: rows.length, query: q }) : t('patients.recent')}</span>
          </form>
        }
        footer={hasMore ? <span>{t('patients.tooMany', { count: PATIENT_PAGE_SIZE })}</span> : undefined}
        empty={<EmptyState icon={Users} title={q ? t('patients.emptySearch', { query: q }) : t('patients.empty')} />}
      />
    </>
  );
}
