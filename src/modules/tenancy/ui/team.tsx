'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Copy, UserPlus } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import { useRouter } from '@/i18n/navigation';
import type { ErrorCode } from '@/shared/lib/errors';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Dialog, DialogContent, DialogTrigger } from '@/shared/ui/dialog';
import { Field, FieldGrid } from '@/shared/ui/field';
import { Input, Select } from '@/shared/ui/form-controls';
import { InlineAlert } from '@/shared/ui/states';
import { useToast } from '@/shared/ui/toast';

import type { ClinicRole, MemberStatus } from '../roles';
import { inviteSchema, type InviteInput } from '../schemas';
import { changeMemberRole, inviteMember, revokeInvitation, setMemberStatus } from '../team-actions';

/** Invitation: email + role; the acceptance link is shown once (only its hash is stored). */
export function InviteDialog({ slug, roles }: { slug: string; roles: ClinicRole[] }) {
  const t = useTranslations();
  const tf = useTranslations('forms.errors');
  const locale = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const form = useForm<InviteInput, unknown, z.output<typeof inviteSchema>>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: '', role: roles.includes('receptionist') ? 'receptionist' : (roles[0] ?? 'receptionist') },
  });

  function change(next: boolean) {
    setOpen(next);
    if (!next) {
      if (link) router.refresh();
      setLink(null);
      setCopied(false);
      setError(null);
      form.reset();
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>
        <Button variant="primary">
          <UserPlus aria-hidden />
          {t('team.invite')}
        </Button>
      </DialogTrigger>
      <DialogContent
        title={t('team.inviteTitle')}
        description={link ? t('team.linkOnce') : t('team.inviteDescription')}
        closeLabel={t('common.close')}
        footer={
          link ? (
            <Button variant="primary" onClick={() => change(false)}>
              {t('common.close')}
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => change(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" form="invite-form" variant="primary" loading={form.formState.isSubmitting}>
                {t('team.createInvitation')}
              </Button>
            </>
          )
        }
      >
        {link ? (
          <div className="grid gap-3">
            <Field id="invite-link" label={t('team.invitationLink')} hint={t('team.linkHint')}>
              <Input readOnly dir="ltr" value={link} className="text-start font-mono text-small" onFocus={(e) => e.currentTarget.select()} />
            </Field>
            <Button
              variant="secondary"
              className="justify-self-start"
              onClick={async () => {
                await navigator.clipboard.writeText(link).catch(() => undefined);
                setCopied(true);
              }}
            >
              <Copy aria-hidden />
              {copied ? t('team.copied') : t('team.copyLink')}
            </Button>
          </div>
        ) : (
          <form
            id="invite-form"
            noValidate
            className="grid gap-4"
            onSubmit={form.handleSubmit(async (values) => {
              setError(null);
              const result = await inviteMember(slug, locale, values);
              if (result.ok) setLink(result.data.link);
              else setError(result.code);
            })}
          >
            <FieldGrid>
              <Field id="invite-email" label={t('auth.email')} required error={form.formState.errors.email?.message ? tf(form.formState.errors.email.message) : undefined}>
                <Input type="email" dir="ltr" className="text-start" autoComplete="off" {...form.register('email')} />
              </Field>
              <Field id="invite-role" label={t('team.role')} required>
                <Select {...form.register('role')}>
                  {roles.map((r) => (
                    <option key={r} value={r}>
                      {t(`roles.${r}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            </FieldGrid>
            {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Role change and status actions for one member. Rules are enforced by the database. */
export function MemberActions({
  member,
  roles,
}: {
  member: { memberId: string; fullName: string; role: ClinicRole; status: MemberStatus };
  roles: ClinicRole[];
}) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const [roleOpen, setRoleOpen] = useState(false);
  const [role, setRole] = useState<ClinicRole>(member.role);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [pending, startTransition] = useTransition();

  const done = (title: string) => {
    toast({ tone: 'success', title });
    router.refresh();
  };

  if (member.status === 'removed') return null;

  return (
    <div className="flex items-center justify-end gap-1">
      {member.status === 'active' ? (
        <Dialog
          open={roleOpen}
          onOpenChange={(next) => {
            setRoleOpen(next);
            setRole(member.role);
            setError(null);
          }}
        >
          <DialogTrigger asChild>
            <Button size="sm" variant="ghost">
              {t('team.changeRole')}
            </Button>
          </DialogTrigger>
          <DialogContent
            size="sm"
            title={t('team.changeRoleTitle', { name: member.fullName })}
            closeLabel={t('common.close')}
            footer={
              <>
                <Button variant="secondary" onClick={() => setRoleOpen(false)} disabled={pending}>
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="primary"
                  loading={pending}
                  disabled={role === member.role}
                  onClick={() =>
                    startTransition(async () => {
                      const result = await changeMemberRole(member.memberId, role);
                      if (!result.ok) return setError(result.code);
                      setRoleOpen(false);
                      done(t('team.roleChanged'));
                    })
                  }
                >
                  {t('common.save')}
                </Button>
              </>
            }
          >
            <div className="grid gap-4">
              <Field id={`role-${member.memberId}`} label={t('team.role')}>
                <Select value={role} onChange={(e) => setRole(e.target.value as ClinicRole)}>
                  {roles.map((r) => (
                    <option key={r} value={r}>
                      {t(`roles.${r}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <p className="text-small text-ink-muted">{t('team.mfaNote')}</p>
              {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {member.status === 'active' ? (
        <ConfirmDialog
          trigger={<Button size="sm" variant="ghost">{t('team.suspend')}</Button>}
          title={t('team.suspendTitle', { name: member.fullName })}
          description={t('team.suspendBody')}
          confirmLabel={t('team.suspend')}
          cancelLabel={t('common.cancel')}
          onConfirm={async () => {
            const result = await setMemberStatus(member.memberId, 'suspended');
            if (!result.ok) return t(`errors.${result.code}`);
            done(t('team.suspended'));
          }}
        />
      ) : (
        <ConfirmDialog
          trigger={<Button size="sm" variant="ghost">{t('team.reactivate')}</Button>}
          title={t('team.reactivateTitle', { name: member.fullName })}
          description={t('team.reactivateBody')}
          confirmLabel={t('team.reactivate')}
          cancelLabel={t('common.cancel')}
          onConfirm={async () => {
            const result = await setMemberStatus(member.memberId, 'active');
            if (!result.ok) return t(`errors.${result.code}`);
            done(t('team.reactivated'));
          }}
        />
      )}

      <ConfirmDialog
        tone="danger"
        trigger={<Button size="sm" variant="ghost" className="text-danger hover:bg-danger-bg hover:text-danger">{t('team.remove')}</Button>}
        title={t('team.removeTitle', { name: member.fullName })}
        description={t('team.removeBody')}
        confirmLabel={t('team.remove')}
        cancelLabel={t('common.cancel')}
        onConfirm={async () => {
          const result = await setMemberStatus(member.memberId, 'removed');
          if (!result.ok) return t(`errors.${result.code}`);
          done(t('team.removed'));
        }}
      />
    </div>
  );
}

export function RevokeInvitationButton({ invitationId, email }: { invitationId: string; email: string }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  return (
    <ConfirmDialog
      tone="danger"
      trigger={<Button size="sm" variant="ghost">{t('team.revoke')}</Button>}
      title={t('team.revokeTitle')}
      description={t('team.revokeBody', { email })}
      confirmLabel={t('team.revoke')}
      cancelLabel={t('common.cancel')}
      onConfirm={async () => {
        const result = await revokeInvitation(invitationId);
        if (!result.ok) return t(`errors.${result.code}`);
        toast({ tone: 'success', title: t('team.revoked') });
        router.refresh();
      }}
    />
  );
}
