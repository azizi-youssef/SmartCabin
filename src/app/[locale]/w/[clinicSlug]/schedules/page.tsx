import { CalendarClock, ChevronRight } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { localizedName } from '@/modules/catalog/names';
import { loadCatalog, loadSpecialties, type Doctor } from '@/modules/catalog/queries';
import { can, loadWorkspace } from '@/modules/tenancy/workspace';
import { Badge } from '@/shared/ui/badge';
import { CellStack, DataTable, type Column } from '@/shared/ui/data-table';
import { PageHeader } from '@/shared/ui/layout';
import { EmptyState, ErrorState } from '@/shared/ui/states';

import { LoadFailure } from '../_lib/page-state';

export async function generateMetadata() {
  const t = await getTranslations('schedules');
  return { title: t('title') };
}

/**
 * Doctors whose hours and time off the user may see. A doctor without broader rights sees only
 * their own agenda (the database enforces it too: practitioner-only scope).
 */
export default async function SchedulesPage({ params }: { params: Promise<{ clinicSlug: string }> }) {
  const { clinicSlug } = await params;
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

  const [catalog, specialties] = await Promise.all([loadCatalog(ws.clinic.id), loadSpecialties()]);
  if (catalog.status !== 'ok') return <LoadFailure outcome={catalog} />;
  const specialtyList = specialties.status === 'ok' ? specialties.data : [];
  const ownOnly = ws.role === 'doctor';
  const doctors = catalog.data.doctors
    .filter((d) => !ownOnly || d.userId === ws.session.userId)
    .sort((a, b) => Number(b.active) - Number(a.active));
  const base = `/w/${ws.clinic.slug}/schedules`;

  const columns: Column<Doctor>[] = [
    {
      id: 'name',
      header: t('columns.doctor'),
      cell: (d) => (
        <CellStack
          primary={
            <Link href={`${base}/${d.id}`} className="focus-ring rounded-sm font-medium text-ink hover:text-accent hover:underline">
              {d.fullName}
            </Link>
          }
          secondary={d.fullNameAr ? <span lang="ar" dir="rtl">{d.fullNameAr}</span> : undefined}
        />
      ),
    },
    {
      id: 'specialty',
      header: t('doctors.specialty'),
      hideBelow: 'md',
      cell: (d) => {
        const s = specialtyList.find((x) => x.id === d.specialtyId);
        return s ? localizedName(locale, s.nameFr, s.nameAr) : <span className="text-ink-subtle">—</span>;
      },
    },
    {
      id: 'status',
      header: t('columns.status'),
      className: 'w-32',
      cell: (d) => <Badge tone={d.active ? 'success' : 'neutral'} dot>{d.active ? t('doctors.active') : t('doctors.inactive')}</Badge>,
    },
    {
      id: 'open',
      header: <span className="sr-only">{t('columns.actions')}</span>,
      align: 'end',
      className: 'w-px whitespace-nowrap',
      cell: (d) => (
        <Link
          href={`${base}/${d.id}`}
          className="focus-ring inline-flex items-center gap-1 rounded-md px-2 py-1 text-small font-medium text-accent hover:bg-accent-soft"
        >
          {t('schedules.open')}
          <span className="sr-only"> — {d.fullName}</span>
          <ChevronRight aria-hidden className="size-4 flip-rtl" />
        </Link>
      ),
    },
  ];

  return (
    <>
      <PageHeader title={t('schedules.title')} description={t('schedules.subtitle')} />
      <DataTable
        caption={t('schedules.title')}
        columns={columns}
        rows={doctors}
        getRowId={(d) => d.id}
        rowClassName={(d) => (d.active ? undefined : 'text-ink-muted')}
        empty={<EmptyState icon={CalendarClock} title={t('schedules.noDoctors')} description={t('schedules.noDoctorsHint')} />}
      />
    </>
  );
}
