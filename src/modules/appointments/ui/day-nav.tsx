'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { addDays } from '@/shared/lib/time';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/form-controls';

/**
 * Day switcher for agenda screens: previous / today / next + a date picker.
 * The day lives in the URL (?day=YYYY-MM-DD) so it survives refresh and can be shared.
 */
export function DayNav({ day, today, params = {} }: { day: string; today: string; params?: Record<string, string> }) {
  const t = useTranslations('common');
  const pathname = usePathname();
  const router = useRouter();
  const href = (d: string) => ({ pathname, query: { ...params, day: d } });

  return (
    <div className="flex items-center gap-1" role="group" aria-label={t('chooseDay')}>
      <Button asChild variant="secondary" size="icon" aria-label={t('previousDay')}>
        <Link href={href(addDays(day, -1))}>
          <ChevronLeft aria-hidden className="flip-rtl" />
        </Link>
      </Button>
      <Button asChild variant={day === today ? 'secondary' : 'ghost'} size="md" aria-current={day === today ? 'date' : undefined}>
        <Link href={href(today)}>{t('today')}</Link>
      </Button>
      <Button asChild variant="secondary" size="icon" aria-label={t('nextDay')}>
        <Link href={href(addDays(day, 1))}>
          <ChevronRight aria-hidden className="flip-rtl" />
        </Link>
      </Button>
      <label className="sr-only" htmlFor="day-picker">
        {t('chooseDay')}
      </label>
      <Input
        id="day-picker"
        type="date"
        className="w-40 tabular"
        value={day}
        onChange={(event) => {
          if (event.target.value) router.push(href(event.target.value));
        }}
      />
    </div>
  );
}
