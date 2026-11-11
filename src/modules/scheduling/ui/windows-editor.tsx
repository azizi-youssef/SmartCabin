'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/form-controls';

import { suggestWindow, WEEKDAYS, type ScheduleWindow } from '../schemas';

/**
 * Weekly opening windows, one row per weekday (Monday first). Controlled: the parent owns the
 * list and its validation. Times are the clinic's local wall-clock times, on a 5-minute grid.
 */
export function WindowsEditor({
  idPrefix,
  value,
  onChange,
  issues,
  disabled = false,
}: {
  idPrefix: string;
  value: ScheduleWindow[];
  onChange: (next: ScheduleWindow[]) => void;
  /** Validation message key (forms.errors) per window index, shown after a save attempt. */
  issues: ReadonlyMap<number, string>;
  disabled?: boolean;
}) {
  const t = useTranslations('schedules');
  const tf = useTranslations('forms.errors');

  const update = (index: number, patch: Partial<ScheduleWindow>) =>
    onChange(value.map((w, i) => (i === index ? { ...w, ...patch } : w)));

  return (
    <div className="divide-y divide-line rounded-md border border-line bg-surface">
      {WEEKDAYS.map((day) => {
        const items = value.map((w, i) => ({ w, i })).filter((x) => x.w.weekday === day);
        const dayLabel = t(`weekday.${day}`);
        return (
          <div key={day} role="group" aria-labelledby={`${idPrefix}-d${day}`} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start">
            <div id={`${idPrefix}-d${day}`} className="shrink-0 pt-1.5 text-small font-medium text-ink sm:w-28">
              {dayLabel}
            </div>
            <div className="flex flex-1 flex-col gap-2">
              {items.length === 0 ? <p className="pt-1.5 text-small text-ink-muted">{t('closed')}</p> : null}
              {items.map(({ w, i }) => {
                const issue = issues.get(i);
                const errorId = `${idPrefix}-e${i}`;
                return (
                  <div key={i}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        type="time"
                        step={300}
                        dir="ltr"
                        className="w-32"
                        aria-label={t('startOf', { day: dayLabel })}
                        aria-invalid={issue ? true : undefined}
                        aria-describedby={issue ? errorId : undefined}
                        value={w.start}
                        disabled={disabled}
                        onChange={(e) => update(i, { start: e.target.value })}
                      />
                      <span aria-hidden className="text-ink-muted">–</span>
                      <Input
                        type="time"
                        step={300}
                        dir="ltr"
                        className="w-32"
                        aria-label={t('endOf', { day: dayLabel })}
                        aria-invalid={issue ? true : undefined}
                        aria-describedby={issue ? errorId : undefined}
                        value={w.end}
                        disabled={disabled}
                        onChange={(e) => update(i, { end: e.target.value })}
                      />
                      {disabled ? null : (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={t('removeWindow', { day: dayLabel, start: w.start, end: w.end })}
                          onClick={() => onChange(value.filter((_, j) => j !== i))}
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      )}
                    </div>
                    {issue ? (
                      <p id={errorId} className="mt-1 text-small text-danger">
                        {tf(issue)}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {disabled ? null : (
              <Button size="sm" variant="ghost" className="self-start" onClick={() => onChange([...value, suggestWindow(day, value)])}>
                <Plus aria-hidden />
                {t('addWindow')}
                <span className="sr-only"> ({dayLabel})</span>
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
