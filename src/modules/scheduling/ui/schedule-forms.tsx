'use client';

import { CalendarPlus, Copy, Pencil, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { useRouter } from '@/i18n/navigation';
import type { ErrorCode } from '@/shared/lib/errors';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Dialog, DialogContent, DialogTrigger } from '@/shared/ui/dialog';
import { Field, FieldGrid } from '@/shared/ui/field';
import { Input } from '@/shared/ui/form-controls';
import { InlineAlert } from '@/shared/ui/states';
import { useToast } from '@/shared/ui/toast';

import { deleteSchedule, saveSchedule } from '../actions';
import {
  copyDay,
  scheduleSchema,
  sortWindows,
  weeklyMinutes,
  windowIssues,
  WORKING_DAYS,
  type DoctorSchedule,
  type ScheduleWindow,
} from '../schemas';
import { WindowsEditor } from './windows-editor';

function sameWindows(a: readonly ScheduleWindow[], b: readonly ScheduleWindow[]): boolean {
  return JSON.stringify(sortWindows(a)) === JSON.stringify(sortWindows(b));
}

function useWeeklyHours(minutes: number) {
  const t = useTranslations('schedules');
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? t('weeklyHours', { hours }) : t('weeklyHoursMinutes', { hours, minutes: rest });
}

/**
 * The doctor's regular weekly hours. Creates the regular schedule on first save (valid from
 * today). Saving never moves appointments: the page lists the ones that no longer fit.
 */
export function RegularHoursForm({
  slug,
  doctorId,
  schedule,
  defaultName,
  today,
  editable,
}: {
  slug: string;
  doctorId: string;
  schedule: DoctorSchedule | null;
  defaultName: string;
  today: string;
  editable: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const initial = useMemo(() => schedule?.windows ?? [], [schedule]);
  const [windows, setWindows] = useState<ScheduleWindow[]>(initial);
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const issues = windowIssues(windows);
  const dirty = !sameWindows(windows, initial);
  const weekly = useWeeklyHours(weeklyMinutes(windows));

  async function save() {
    setSubmitted(true);
    setError(null);
    if (issues.size > 0) return;
    setPending(true);
    const result = await saveSchedule(slug, doctorId, schedule?.id ?? null, {
      kind: 'regular',
      name: schedule?.name ?? defaultName,
      validFrom: schedule?.validFrom ?? today,
      validUntil: schedule?.validUntil ?? '',
      windows,
    });
    setPending(false);
    if (!result.ok) return setError(result.code);
    setSubmitted(false);
    toast({ tone: 'success', title: t('schedules.saved') });
    router.refresh();
  }

  return (
    <div className="grid gap-3">
      <WindowsEditor idPrefix="regular" value={windows} onChange={setWindows} issues={submitted ? issues : new Map()} disabled={!editable} />
      <p className="text-small text-ink-muted" aria-live="polite">{weekly}</p>
      {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
      {editable ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" loading={pending} disabled={!dirty} onClick={save}>
            {t('common.save')}
          </Button>
          <Button variant="secondary" disabled={!dirty || pending} onClick={() => { setWindows(initial); setSubmitted(false); setError(null); }}>
            {t('schedules.discard')}
          </Button>
          <Button
            variant="ghost"
            disabled={pending || !windows.some((w) => w.weekday === 1)}
            onClick={() => setWindows(copyDay(windows, 1, WORKING_DAYS))}
          >
            <Copy aria-hidden />
            {t('schedules.copyMonday')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Create or edit a dated override (e.g. Ramadan hours). New overrides start from the regular hours. */
export function OverrideDialog({
  slug,
  doctorId,
  override,
  regularWindows,
  today,
}: {
  slug: string;
  doctorId: string;
  override?: DoctorSchedule;
  regularWindows: ScheduleWindow[];
  today: string;
}) {
  const t = useTranslations();
  const tf = useTranslations('forms.errors');
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const blank = () => ({
    name: override?.name ?? '',
    validFrom: override?.validFrom ?? today,
    validUntil: override?.validUntil ?? '',
    windows: override?.windows ?? regularWindows,
  });
  const [values, setValues] = useState(blank);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const issues = windowIssues(values.windows);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    const input = { kind: 'override' as const, ...values };
    const parsed = scheduleSchema.safeParse(input);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) if (typeof issue.path[0] === 'string') next[issue.path[0]] ??= issue.message;
      setFields(next);
      return;
    }
    setFields({});
    setPending(true);
    const result = await saveSchedule(slug, doctorId, override?.id ?? null, input);
    setPending(false);
    if (!result.ok) {
      setFields(result.fields ?? {});
      return setError(result.code);
    }
    toast({ tone: 'success', title: t('schedules.saved') });
    setOpen(false);
    router.refresh();
  }

  const fieldError = (name: string) => (fields[name] ? tf(fields[name]) : undefined);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setValues(blank());
          setFields({});
          setSubmitted(false);
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        {override ? (
          <Button size="sm" variant="ghost">
            <Pencil aria-hidden />
            <span className="sr-only xl:not-sr-only">{t('schedules.edit')}</span>
            <span className="sr-only xl:hidden"> {override.name}</span>
          </Button>
        ) : (
          <Button variant="secondary">
            <CalendarPlus aria-hidden />
            {t('schedules.addOverride')}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        title={override ? t('schedules.editOverrideTitle', { name: override.name }) : t('schedules.addOverrideTitle')}
        description={t('schedules.overrideHint')}
        closeLabel={t('common.close')}
        className="sm:max-w-3xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form="override-form" variant="primary" loading={pending}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <form id="override-form" noValidate className="grid gap-4" onSubmit={submit}>
          <FieldGrid>
            <Field id="ov-name" label={t('schedules.overrideName')} hint={t('schedules.overrideNameHint')} required error={fieldError('name')}>
              <Input value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field id="ov-from" label={t('schedules.validFrom')} required error={fieldError('validFrom')}>
                <Input type="date" dir="ltr" value={values.validFrom} onChange={(e) => setValues({ ...values, validFrom: e.target.value })} />
              </Field>
              <Field id="ov-until" label={t('schedules.validUntil')} required error={fieldError('validUntil')}>
                <Input type="date" dir="ltr" value={values.validUntil} onChange={(e) => setValues({ ...values, validUntil: e.target.value })} />
              </Field>
            </div>
          </FieldGrid>
          <WindowsEditor
            idPrefix="override"
            value={values.windows}
            onChange={(windows) => setValues({ ...values, windows })}
            issues={submitted ? issues : new Map()}
          />
          {error ? <InlineAlert tone="danger">{t(`errors.${error}`)}</InlineAlert> : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteScheduleButton({ slug, scheduleId, name }: { slug: string; scheduleId: string; name: string }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  return (
    <ConfirmDialog
      tone="danger"
      trigger={
        <Button size="sm" variant="ghost" className="text-danger hover:bg-danger-bg hover:text-danger">
          <Trash2 aria-hidden />
          <span className="sr-only xl:not-sr-only">{t('schedules.delete')}</span>
          <span className="sr-only xl:hidden"> {name}</span>
        </Button>
      }
      title={t('schedules.deleteTitle', { name })}
      description={t('schedules.deleteBody')}
      confirmLabel={t('schedules.delete')}
      cancelLabel={t('common.cancel')}
      onConfirm={async () => {
        const result = await deleteSchedule(slug, scheduleId);
        if (!result.ok) return t(`errors.${result.code}`);
        toast({ tone: 'success', title: t('schedules.deleted') });
        router.refresh();
      }}
    />
  );
}
