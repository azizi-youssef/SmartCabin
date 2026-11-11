import { ListChecks } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import type { Locale } from '@/i18n/routing';
import { localizedName } from '@/modules/catalog/names';
import { loadCatalog, loadSpecialties, type Service } from '@/modules/catalog/queries';
import { ServiceArchiveButton, ServiceDialog } from '@/modules/catalog/ui/services';
import { can, loadWorkspace } from '@/modules/tenancy/workspace';
import { formatMoney } from '@/shared/lib/format';
import { Badge } from '@/shared/ui/badge';
import { CellStack, DataTable, type Column } from '@/shared/ui/data-table';
import { PageHeader } from '@/shared/ui/layout';
import { EmptyState, ErrorState } from '@/shared/ui/states';

import { LoadFailure } from '../_lib/page-state';

export async function generateMetadata() {
  const t = await getTranslations('services');
  return { title: t('title') };
}

/** Clinic service catalog: bilingual names, default duration and price, online booking, archive. */
export default async function ServicesPage({ params }: { params: Promise<{ clinicSlug: string }> }) {
  const { clinicSlug } = await params;
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const result = await loadWorkspace(clinicSlug);
  if (result.status !== 'ok') return null;
  const ws = result.workspace;
  if (!can(ws, 'services.manage')) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <ErrorState title={t('states.forbiddenTitle')} description={t('states.forbiddenBody')} />
      </div>
    );
  }

  const [catalog, specialties] = await Promise.all([loadCatalog(ws.clinic.id), loadSpecialties()]);
  if (catalog.status !== 'ok') return <LoadFailure outcome={catalog} />;
  const specialtyList = specialties.status === 'ok' ? specialties.data : [];
  const editable = ws.clinic.status !== 'suspended';
  const offeredBy = (serviceId: string) => catalog.data.offerings.filter((o) => o.serviceId === serviceId && o.active).length;
  // Active services first, then archived ones.
  const rows = [...catalog.data.services].sort((a, b) => Number(b.active) - Number(a.active));

  const columns: Column<Service>[] = [
    {
      id: 'name',
      header: t('columns.service'),
      cell: (s) => {
        const primary = localizedName(locale, s.nameFr, s.nameAr);
        const other = locale === 'ar' ? s.nameFr : s.nameAr;
        return (
          <CellStack
            primary={primary}
            secondary={other && other !== primary ? <span lang={locale === 'ar' ? 'fr' : 'ar'} dir={locale === 'ar' ? 'ltr' : 'rtl'}>{other}</span> : undefined}
          />
        );
      },
    },
    {
      id: 'specialty',
      header: t('doctors.specialty'),
      hideBelow: 'md',
      cell: (s) => {
        const sp = specialtyList.find((x) => x.id === s.specialtyId);
        return sp ? localizedName(locale, sp.nameFr, sp.nameAr) : <span className="text-ink-subtle">—</span>;
      },
    },
    {
      id: 'duration',
      header: t('services.duration'),
      align: 'end',
      className: 'w-28',
      cell: (s) => <span className="tabular">{t('services.minutes', { count: s.durationMinutes })}</span>,
    },
    {
      id: 'price',
      header: t('columns.price'),
      align: 'end',
      className: 'w-32',
      cell: (s) => <span className="tabular">{formatMoney(locale, s.priceMad)}</span>,
    },
    {
      id: 'doctors',
      header: t('services.offeredBy'),
      hideBelow: 'lg',
      className: 'w-36',
      cell: (s) => t('services.doctorsCount', { count: offeredBy(s.id) }),
    },
    {
      id: 'status',
      header: t('columns.status'),
      className: 'w-44',
      cell: (s) => (
        <span className="flex flex-wrap gap-1">
          <Badge tone={s.active ? 'success' : 'neutral'} dot>{s.active ? t('services.active') : t('services.archived')}</Badge>
          {s.active && s.onlineBookable ? <Badge tone="accent">{t('doctors.online')}</Badge> : null}
        </span>
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">{t('columns.actions')}</span>,
      align: 'end',
      className: 'w-px whitespace-nowrap',
      cell: (s) => {
        if (!editable) return null;
        const name = localizedName(locale, s.nameFr, s.nameAr);
        return (
          <span className="flex items-center justify-end gap-1">
            {s.active ? (
              <ServiceDialog
                slug={ws.clinic.slug}
                specialties={specialtyList}
                service={{ id: s.id, nameFr: s.nameFr, nameAr: s.nameAr, specialtyId: s.specialtyId, durationMinutes: s.durationMinutes, priceMad: s.priceMad, onlineBookable: s.onlineBookable }}
              />
            ) : null}
            <ServiceArchiveButton slug={ws.clinic.slug} serviceId={s.id} name={name} active={s.active} />
          </span>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title={t('services.title')}
        description={t('services.subtitle')}
        actions={editable ? <ServiceDialog slug={ws.clinic.slug} specialties={specialtyList} /> : null}
      />
      <DataTable
        caption={t('services.title')}
        columns={columns}
        rows={rows}
        getRowId={(s) => s.id}
        rowClassName={(s) => (s.active ? undefined : 'text-ink-muted')}
        empty={<EmptyState icon={ListChecks} title={t('services.empty')} description={t('services.emptyHint')} />}
      />
    </>
  );
}
