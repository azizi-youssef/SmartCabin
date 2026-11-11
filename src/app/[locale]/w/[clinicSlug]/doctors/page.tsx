import { Stethoscope } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import type { Locale } from '@/i18n/routing';
import { localizedName } from '@/modules/catalog/names';
import { loadCatalog, loadSpecialties, type Doctor } from '@/modules/catalog/queries';
import { DoctorDialog, DoctorServicesDialog, DoctorStatusButton } from '@/modules/catalog/ui/doctors';
import { loadMembers } from '@/modules/tenancy/queries';
import { can, loadWorkspace } from '@/modules/tenancy/workspace';
import { formatPhone } from '@/shared/lib/phone';
import { Badge } from '@/shared/ui/badge';
import { CellStack, DataTable, type Column } from '@/shared/ui/data-table';
import { PageHeader } from '@/shared/ui/layout';
import { EmptyState, ErrorState } from '@/shared/ui/states';

import { LoadFailure } from '../_lib/page-state';

export async function generateMetadata() {
  const t = await getTranslations('doctors');
  return { title: t('title') };
}

/** Practitioners of the clinic: identity, linked login, offered services, online booking, status. */
export default async function DoctorsPage({ params }: { params: Promise<{ clinicSlug: string }> }) {
  const { clinicSlug } = await params;
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const result = await loadWorkspace(clinicSlug);
  if (result.status !== 'ok') return null;
  const ws = result.workspace;
  if (!can(ws, 'doctors.manage')) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <ErrorState title={t('states.forbiddenTitle')} description={t('states.forbiddenBody')} />
      </div>
    );
  }

  const [catalog, specialties, members] = await Promise.all([loadCatalog(ws.clinic.id), loadSpecialties(), loadMembers(ws.clinic.id)]);
  if (catalog.status !== 'ok') return <LoadFailure outcome={catalog} />;
  const specialtyList = specialties.status === 'ok' ? specialties.data : [];
  const memberList = members.status === 'ok' ? members.data : [];
  const editable = ws.clinic.status !== 'suspended';
  const linkedUsers = new Set(catalog.data.doctors.map((d) => d.userId).filter(Boolean));
  const memberLabel = new Map(memberList.map((m) => [m.userId, `${m.fullName} · ${m.email}`]));
  const memberOptions = (doctor?: Doctor) =>
    memberList
      .filter((m) => m.status === 'active' && (!linkedUsers.has(m.userId) || m.userId === doctor?.userId))
      .map((m) => ({ userId: m.userId, label: `${m.fullName} (${t(`roles.${m.role}`)})` }));

  const columns: Column<Doctor>[] = [
    {
      id: 'name',
      header: t('columns.doctor'),
      cell: (d) => <CellStack primary={d.fullName} secondary={d.fullNameAr ? <span lang="ar" dir="rtl">{d.fullNameAr}</span> : d.phone ? <span dir="ltr">{formatPhone(d.phone)}</span> : undefined} />,
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
      id: 'account',
      header: t('doctors.account'),
      hideBelow: 'lg',
      cell: (d) => (d.userId ? <span dir="ltr" className="text-small">{memberLabel.get(d.userId) ?? '—'}</span> : <span className="text-small text-ink-subtle">{t('doctors.noAccount')}</span>),
    },
    {
      id: 'services',
      header: t('doctors.services'),
      className: 'w-40',
      cell: (d) =>
        editable ? (
          <DoctorServicesDialog
            doctorId={d.id}
            doctorName={d.fullName}
            offers={catalog.data.services
              .filter((s) => s.active)
              .map((s) => {
                const offer = catalog.data.offerings.find((o) => o.doctorId === d.id && o.serviceId === s.id);
                return {
                  serviceId: s.id,
                  name: localizedName(locale, s.nameFr, s.nameAr),
                  defaultDuration: s.durationMinutes,
                  defaultPrice: s.priceMad,
                  offered: Boolean(offer?.active),
                  durationMinutes: offer?.durationMinutes ?? null,
                  priceMad: offer?.priceMad ?? null,
                  onlineBookable: offer?.onlineBookable ?? true,
                };
              })}
          />
        ) : (
          t('doctors.servicesCount', { count: catalog.data.offerings.filter((o) => o.doctorId === d.id && o.active).length })
        ),
    },
    {
      id: 'status',
      header: t('columns.status'),
      className: 'w-44',
      cell: (d) => (
        <span className="flex flex-wrap gap-1">
          <Badge tone={d.active ? 'success' : 'neutral'} dot>{d.active ? t('doctors.active') : t('doctors.inactive')}</Badge>
          {d.active && d.onlineBookable ? <Badge tone="accent">{t('doctors.online')}</Badge> : null}
        </span>
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">{t('columns.actions')}</span>,
      align: 'end',
      className: 'w-px whitespace-nowrap',
      cell: (d) =>
        editable ? (
          <span className="flex items-center justify-end gap-1">
            <DoctorDialog
              slug={ws.clinic.slug}
              specialties={specialtyList}
              members={memberOptions(d)}
              doctor={{ id: d.id, fullName: d.fullName, fullNameAr: d.fullNameAr, specialtyId: d.specialtyId, inpe: d.inpe, phone: d.phone, userId: d.userId, onlineBookable: d.onlineBookable }}
            />
            <DoctorStatusButton slug={ws.clinic.slug} doctorId={d.id} name={d.fullName} active={d.active} />
          </span>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title={t('doctors.title')}
        description={t('doctors.subtitle')}
        actions={editable ? <DoctorDialog slug={ws.clinic.slug} specialties={specialtyList} members={memberOptions()} /> : null}
      />
      <DataTable
        caption={t('doctors.title')}
        columns={columns}
        rows={catalog.data.doctors}
        getRowId={(d) => d.id}
        rowClassName={(d) => (d.active ? undefined : 'text-ink-muted')}
        empty={<EmptyState icon={Stethoscope} title={t('doctors.empty')} description={t('doctors.emptyHint')} />}
      />
    </>
  );
}
