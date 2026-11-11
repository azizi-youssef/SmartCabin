import { Users } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import type { Locale } from '@/i18n/routing';
import { loadMembers, loadOpenInvitations, type Invitation, type Member } from '@/modules/tenancy/queries';
import { manageableRoles } from '@/modules/tenancy/roles';
import { InviteDialog, MemberActions, RevokeInvitationButton } from '@/modules/tenancy/ui/team';
import { can, loadWorkspace } from '@/modules/tenancy/workspace';
import { formatShortDate } from '@/shared/lib/format';
import { Badge } from '@/shared/ui/badge';
import { CellStack, DataTable, type Column } from '@/shared/ui/data-table';
import { PageHeader, Section } from '@/shared/ui/layout';
import { EmptyState, ErrorState } from '@/shared/ui/states';

import { LoadFailure } from '../_lib/page-state';

export async function generateMetadata() {
  const t = await getTranslations('team');
  return { title: t('title') };
}

/** Team: members (role, status) and open invitations. Owners and admins only. */
export default async function TeamPage({ params }: { params: Promise<{ clinicSlug: string }> }) {
  const { clinicSlug } = await params;
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const result = await loadWorkspace(clinicSlug);
  if (result.status !== 'ok') return null;
  const ws = result.workspace;
  if (!can(ws, 'members.view')) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <ErrorState title={t('states.forbiddenTitle')} description={t('states.forbiddenBody')} />
      </div>
    );
  }

  const [members, invitations] = await Promise.all([loadMembers(ws.clinic.id), loadOpenInvitations(ws.clinic.id)]);
  const roles = manageableRoles(ws.role);
  const canManage = can(ws, 'members.invite') && ws.clinic.status !== 'suspended';
  const header = (
    <PageHeader title={t('team.title')} description={t('team.subtitle')} actions={canManage ? <InviteDialog slug={ws.clinic.slug} roles={roles} /> : null} />
  );
  if (members.status !== 'ok') return (<>{header}<LoadFailure outcome={members} /></>);

  const statusTone = { active: 'success', suspended: 'warning', removed: 'neutral' } as const;
  const memberColumns: Column<Member>[] = [
    {
      id: 'name',
      header: t('team.member'),
      cell: (m) => (
        <CellStack
          primary={
            <span className="flex items-center gap-2">
              {m.fullName}
              {m.isSelf ? <Badge>{t('team.you')}</Badge> : null}
            </span>
          }
          secondary={<span dir="ltr">{m.email}</span>}
        />
      ),
    },
    {
      id: 'role',
      header: t('team.role'),
      className: 'w-56',
      cell: (m) => (
        <span className="flex flex-wrap items-center gap-1">
          {t(`roles.${m.role}`)}
          {m.isPractitioner && m.role !== 'doctor' ? <Badge tone="accent">{t('roles.practitioner')}</Badge> : null}
        </span>
      ),
    },
    { id: 'status', header: t('columns.status'), className: 'w-32', cell: (m) => <Badge tone={statusTone[m.status]} dot>{t(`team.status.${m.status}`)}</Badge> },
    { id: 'joined', header: t('team.joined'), hideBelow: 'md', className: 'w-32', cell: (m) => formatShortDate(locale, m.joinedAt, ws.clinic.timezone) },
    {
      id: 'actions',
      header: <span className="sr-only">{t('columns.actions')}</span>,
      align: 'end',
      className: 'w-px whitespace-nowrap',
      cell: (m) =>
        canManage && !m.isSelf && roles.includes(m.role) ? <MemberActions member={m} roles={roles} /> : null,
    },
  ];

  const invitationColumns: Column<Invitation>[] = [
    { id: 'email', header: t('auth.email'), cell: (i) => <span dir="ltr">{i.email}</span> },
    { id: 'role', header: t('team.role'), className: 'w-48', cell: (i) => t(`roles.${i.role}`) },
    { id: 'expires', header: t('team.expires'), className: 'w-32', cell: (i) => formatShortDate(locale, i.expiresAt, ws.clinic.timezone) },
    {
      id: 'actions',
      header: <span className="sr-only">{t('columns.actions')}</span>,
      align: 'end',
      className: 'w-px',
      cell: (i) => (canManage && roles.includes(i.role) ? <RevokeInvitationButton invitationId={i.id} email={i.email} /> : null),
    },
  ];

  return (
    <>
      {header}
      <DataTable
        caption={t('team.title')}
        columns={memberColumns}
        rows={members.data.filter((m) => m.status !== 'removed')}
        getRowId={(m) => m.memberId}
        rowClassName={(m) => (m.status !== 'active' ? 'text-ink-muted' : undefined)}
        empty={<EmptyState icon={Users} title={t('team.empty')} />}
      />
      <Section id="invitations" title={t('team.invitations')} description={t('team.invitationsHint')}>
        {invitations.status !== 'ok' ? (
          <LoadFailure outcome={invitations} />
        ) : (
          <DataTable
            caption={t('team.invitations')}
            columns={invitationColumns}
            rows={invitations.data}
            getRowId={(i) => i.id}
            empty={<EmptyState title={t('team.noInvitations')} />}
          />
        )}
      </Section>
    </>
  );
}
