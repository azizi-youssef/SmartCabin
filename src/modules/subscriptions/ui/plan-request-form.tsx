'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { useRouter } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { formatMoney } from '@/shared/lib/format';
import { Button } from '@/shared/ui/button';
import { Field } from '@/shared/ui/field';
import { Select, Textarea } from '@/shared/ui/form-controls';
import { InlineAlert } from '@/shared/ui/states';
import { useToast } from '@/shared/ui/toast';

import { requestPlanChange } from '../actions';

/** The owner asks for a plan; the platform answers it (manual billing during the pilot). */
export function PlanRequestForm({ clinicId, plans, current }: {
  clinicId: string;
  plans: Array<{ code: string; nameFr: string; nameAr: string; monthlyPriceMad: string }>;
  current: string;
}) {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const router = useRouter();
  const toast = useToast();
  const [plan, setPlan] = useState(plans.find((p) => p.code !== current)?.code ?? plans[0]?.code ?? '');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="grid max-w-xl gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await requestPlanChange({ clinicId, planCode: plan, note: note.trim() });
          if (!result.ok) return setError(t(`errors.${result.code}`));
          setError(null);
          setNote('');
          toast({ tone: 'success', title: t('subscription.requestSent') });
          router.refresh();
        });
      }}
    >
      <Field id="plan-request" label={t('subscription.requestPlan')} required>
        <Select value={plan} onChange={(e) => setPlan(e.target.value)}>
          {plans.map((p) => (
            <option key={p.code} value={p.code}>
              {`${locale === 'ar' ? p.nameAr : p.nameFr} — ${t('subscription.perMonth', { price: formatMoney(locale, p.monthlyPriceMad) })}`}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="plan-request-note" label={t('subscription.requestNote')} optionalLabel={t('common.optional')}>
        <Textarea value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      <div>
        <Button type="submit" variant="primary" loading={pending} disabled={!plan}>{t('subscription.sendRequest')}</Button>
      </div>
    </form>
  );
}
