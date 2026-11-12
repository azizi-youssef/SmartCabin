'use client';

import { Copy, MonitorPlay, Plus } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { useRouter } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import type { ErrorCode } from '@/shared/lib/errors';
import { formatDateTime } from '@/shared/lib/format';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Dialog, DialogContent, DialogTrigger } from '@/shared/ui/dialog';
import { Field } from '@/shared/ui/field';
import { Checkbox, Input } from '@/shared/ui/form-controls';
import { EmptyState, InlineAlert } from '@/shared/ui/states';
import { useToast } from '@/shared/ui/toast';

import { createDisplayScreen, revokeDisplayScreen } from '../display-actions';

export interface ScreenRow {
  id: string;
  name: string;
  doctorNames: string[] | null;
  createdAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
}

/** Waiting-room screens: create (link shown once), see when each was last online, revoke. */
export function DisplayScreens({
  slug,
  screens,
  doctors,
  timeZone,
  canManage,
}: {
  slug: string;
  screens: ScreenRow[];
  doctors: Array<{ id: string; name: string }>;
  timeZone: string;
  canManage: boolean;
}) {
  const t = useTranslations('displays');
  const locale = useLocale() as Locale;
  const active = screens.filter((s) => !s.revokedAt);
  return (
    <div className="grid gap-3">
      {canManage ? (
        <div>
          <CreateScreenDialog slug={slug} doctors={doctors} />
        </div>
      ) : null}
      {active.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface">
          <EmptyState icon={MonitorPlay} title={t('empty')} description={t('emptyHint')} />
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {active.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="grid min-w-0 flex-1 leading-tight">
                <span className="font-medium text-ink">{s.name}</span>
                <span className="text-small text-ink-muted">
                  {s.doctorNames ? s.doctorNames.join(', ') : t('allDoctors')}
                  {' · '}
                  {s.lastSeenAt ? t('lastSeen', { when: formatDateTime(locale, s.lastSeenAt, timeZone) }) : t('neverSeen')}
                </span>
              </span>
              {canManage ? <RevokeScreenButton screenId={s.id} name={s.name} /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateScreenDialog({ slug, doctors }: { slug: string; doctors: Array<{ id: string; name: string }> }) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [all, setAll] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [pending, startTransition] = useTransition();
  const valid = name.trim().length >= 2 && (all || selected.length > 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setName('');
          setAll(true);
          setSelected([]);
          setLink(null);
          setCopied(false);
          setError(null);
        } else if (link) {
          router.refresh();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary">
          <Plus aria-hidden />
          {t('displays.add')}
        </Button>
      </DialogTrigger>
      <DialogContent
        title={link ? t('displays.linkTitle') : t('displays.addTitle')}
        description={link ? t('displays.linkHint') : t('displays.addHint')}
        closeLabel={t('common.close')}
        footer={
          link ? (
            <Button variant="primary" onClick={() => setOpen(false)}>{t('common.close')}</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
              <Button
                variant="primary"
                loading={pending}
                disabled={!valid}
                onClick={() =>
                  startTransition(async () => {
                    setError(null);
                    const result = await createDisplayScreen({ clinicSlug: slug, locale, name: name.trim(), doctorIds: all ? null : selected });
                    if (!result.ok) return setError(result.code);
                    setLink(result.data.link);
                  })
                }
              >
                {t('displays.create')}
              </Button>
            </>
          )
        }
      >
        {link ? (
          <div className="grid gap-3">
            <Input readOnly dir="ltr" value={link} aria-label={t('displays.linkLabel')} onFocus={(e) => e.currentTarget.select()} />
            <div>
              <Button
                variant="secondary"
                onClick={async () => {
                  await navigator.clipboard.writeText(link);
                  setCopied(true);
                }}
              >
                <Copy aria-hidden />
                {copied ? t('displays.copied') : t('displays.copy')}
              </Button>
            </div>
            <InlineAlert tone="warning">{t('displays.onceWarning')}</InlineAlert>
          </div>
        ) : (
          <div className="grid gap-4">
            <Field id="screen-name" label={t('displays.name')} hint={t('displays.nameHint')} required>
              <Input maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-small font-medium text-ink">{t('displays.doctors')}</legend>
              <Checkbox label={t('displays.allDoctors')} checked={all} onChange={(e) => setAll(e.target.checked)} />
              {all ? null : doctors.map((d) => (
                <Checkbox
                  key={d.id}
                  label={d.name}
                  checked={selected.includes(d.id)}
                  onChange={(e) => setSelected(e.target.checked ? [...selected, d.id] : selected.filter((x) => x !== d.id))}
                />
              ))}
            </fieldset>
            {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RevokeScreenButton({ screenId, name }: { screenId: string; name: string }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  return (
    <ConfirmDialog
      tone="danger"
      trigger={
        <Button size="sm" variant="ghost" className="text-danger hover:bg-danger-bg hover:text-danger">
          {t('displays.revoke')}
          <span className="sr-only"> — {name}</span>
        </Button>
      }
      title={t('displays.revokeTitle', { name })}
      description={t('displays.revokeBody')}
      confirmLabel={t('displays.revoke')}
      cancelLabel={t('common.cancel')}
      onConfirm={async () => {
        const result = await revokeDisplayScreen(screenId);
        if (!result.ok) return t(`errors.${result.code}`);
        toast({ tone: 'success', title: t('displays.revoked') });
        router.refresh();
      }}
    />
  );
}

