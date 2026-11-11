'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState, useTransition } from 'react';

import type { Locale } from '@/i18n/routing';
import type { ErrorCode } from '@/shared/lib/errors';
import { InlineAlert, Skeleton } from '@/shared/ui/states';

import { fetchSlots, type SlotOption } from '../actions';
import { SlotRadioGroup } from './slot-radio-group';

/**
 * Free slots for (doctor, service, day), computed by the database. A slot shown here can still
 * be taken by someone else before submission; the booking command re-checks atomically.
 */
export function SlotPicker({
  doctorId,
  serviceId,
  day,
  timeZone,
  value,
  onChange,
}: {
  doctorId: string;
  serviceId: string;
  day: string;
  timeZone: string;
  value: string | null;
  onChange: (slot: SlotOption | null) => void;
}) {
  const t = useTranslations('booking');
  const te = useTranslations('errors');
  const locale = useLocale() as Locale;
  const [slots, setSlots] = useState<SlotOption[] | null>(null);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [pending, startTransition] = useTransition();
  const ready = Boolean(doctorId && serviceId && day);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    startTransition(async () => {
      const result = await fetchSlots({ doctorId, serviceId, day });
      if (cancelled) return;
      if (result.ok) {
        setSlots(result.data);
        setError(null);
      } else {
        setSlots(null);
        setError(result.code);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ready, doctorId, serviceId, day]);

  if (!ready) return <p className="text-small text-ink-muted">{t('slotsHint')}</p>;
  if (pending && !slots) {
    return (
      <div className="flex flex-wrap gap-1.5" aria-busy>
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-16" />
        ))}
      </div>
    );
  }
  if (error) return <InlineAlert tone="danger">{te(error)}</InlineAlert>;
  if (!slots || slots.length === 0) return <p className="text-small text-ink-muted">{t('slotsEmpty')}</p>;

  return (
    <SlotRadioGroup
      slots={slots}
      value={value}
      onChange={onChange}
      label={t('slots')}
      locale={locale}
      timeZone={timeZone}
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
      busy={pending}
    />
  );
}
