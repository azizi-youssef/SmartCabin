'use client';

import { useRef, type KeyboardEvent } from 'react';

import type { Locale } from '@/i18n/routing';
import { cn } from '@/shared/lib/cn';
import { formatTime } from '@/shared/lib/format';

export interface SlotItem {
  startsAt: string;
}

/**
 * Time slots as a WAI-ARIA radio group (audit SC-AUD-16): one Tab stop (the selected slot, or the
 * first one), arrow keys move and select, Home/End jump to the ends. Left/Right follow the reading
 * direction, so in Arabic (RTL) ArrowLeft moves to the next, later slot.
 */
export function SlotRadioGroup<T extends SlotItem>({
  slots,
  value,
  onChange,
  label,
  locale,
  timeZone,
  dir,
  busy = false,
}: {
  slots: readonly T[];
  value: string | null;
  onChange: (slot: T | null) => void;
  label: string;
  locale: Locale;
  timeZone: string;
  dir: 'ltr' | 'rtl';
  busy?: boolean;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = slots.findIndex((s) => s.startsAt === value);
  const tabStop = selectedIndex >= 0 ? selectedIndex : 0;

  function move(to: number) {
    const index = Math.max(0, Math.min(slots.length - 1, to));
    const slot = slots[index];
    if (!slot) return;
    onChange(slot);
    refs.current[index]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const backward = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    const target =
      event.key === forward || event.key === 'ArrowDown' ? index + 1
      : event.key === backward || event.key === 'ArrowUp' ? index - 1
      : event.key === 'Home' ? 0
      : event.key === 'End' ? slots.length - 1
      : null;
    if (target === null) return;
    event.preventDefault();
    move(target);
  }

  return (
    <div role="radiogroup" aria-label={label} aria-busy={busy || undefined} className={cn('flex flex-wrap gap-1.5', busy && 'opacity-60')}>
      {slots.map((slot, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            key={slot.startsAt}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={index === tabStop ? 0 : -1}
            onClick={() => onChange(selected ? null : slot)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'focus-ring h-8 min-w-16 rounded-md border px-2 text-small font-medium tabular transition-colors',
              selected
                ? 'border-primary bg-primary text-primary-fg'
                : 'border-line-strong bg-surface text-ink hover:border-accent hover:bg-accent-soft',
            )}
          >
            <span dir="ltr">{formatTime(locale, slot.startsAt, timeZone)}</span>
          </button>
        );
      })}
    </div>
  );
}
