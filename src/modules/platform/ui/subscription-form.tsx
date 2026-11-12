'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { useRouter } from '@/i18n/navigation';
import { needsPeriod, nextSubscriptionStatuses, type SubscriptionStatus } from '@/modules/subscriptions/domain';
import { Button } from '@/shared/ui/button';
import { Field } from '@/shared/ui/field';
import { Input, Select, Textarea } from '@/shared/ui/form-controls';
import { InlineAlert } from '@/shared/ui/states';
import { useToast } from '@/shared/ui/toast';

import { markSubscriptionPaid, setSubscription } from '../actions';

/**
 * Plan, status and period of one clinic's subscription (manual billing during the pilot).
 * Dates are the clinic's local dates; the period ends at the end of its last day.
 */
export function SubscriptionForm({ clinicId, plans, current }: {
  clinicId: string;
  plans: Array<{ code: string; label: string }>;
  current: { planCode: string | null; status: SubscriptionStatus | null; periodStart: string; periodEnd: string; trialEndsOn: string };
}) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const statuses = nextSubscriptionStatuses(current.status === 'expired' ? null : current.status);
  const [plan, setPlan] = useState(current.planCode ?? plans[0]?.code ?? '');
  const [status, setStatus] = useState<SubscriptionStatus>(statuses.includes(current.status as SubscriptionStatus) ? (current.status as SubscriptionStatus) : statuses[0] ?? 'active');
  const [periodStart, setPeriodStart] = useState(current.periodStart);
  const [periodEnd, setPeriodEnd] = useState(current.periodEnd);
  const [trialEnd, setTrialEnd] = useState(current.trialEndsOn);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const periodMissing = needsPeriod(status) && (!periodStart || !periodEnd || periodEnd < periodStart);

  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await setSubscription({
            clinicId, planCode: plan, status,
            periodStart: needsPeriod(status) ? periodStart : '',
            periodEnd: needsPeriod(status) ? periodEnd : '',
            trialEndsOn: status === 'trialing' ? trialEnd : '',
            notes: notes.trim(),
          });
          if (!result.ok) return setError(t(`errors.${result.code}`));
          setError(null);
          toast({ tone: 'success', title: t('platformClinic.subscriptionSaved') });
          router.refresh();
        });
      }}
    >
      <Field id="sub-plan" label={t('subscription.plan')} required>
        <Select value={plan} onChange={(e) => setPlan(e.target.value)}>
          {plans.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}
        </Select>
      </Field>
      <Field id="sub-status" label={t('subscription.statusLabel')} required>
        <Select value={status} onChange={(e) => setStatus(e.target.value as SubscriptionStatus)}>
          {statuses.map((s) => <option key={s} value={s}>{t(`subscription.status.${s}`)}</option>)}
        </Select>
      </Field>
      {needsPeriod(status) ? (
        <>
          <Field id="sub-start" label={t('platformClinic.periodStart')} required>
            <Input type="date" dir="ltr" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          </Field>
          <Field id="sub-end" label={t('platformClinic.periodEnd')} required error={periodMissing && periodStart && periodEnd ? t('platformClinic.periodInvalid') : undefined}>
            <Input type="date" dir="ltr" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </Field>
        </>
      ) : null}
      {status === 'trialing' ? (
        <Field id="sub-trial" label={t('platformClinic.trialEnd')} hint={t('platformClinic.trialEndHint')} optionalLabel={t('common.optional')}>
          <Input type="date" dir="ltr" value={trialEnd} onChange={(e) => setTrialEnd(e.target.value)} />
        </Field>
      ) : null}
      <Field id="sub-notes" label={t('platformClinic.notes')} optionalLabel={t('common.optional')} className="sm:col-span-2">
        <Textarea value={notes} maxLength={500} rows={2} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      {error ? <InlineAlert tone="danger" className="sm:col-span-2">{error}</InlineAlert> : null}
      <div className="sm:col-span-2">
        <Button type="submit" variant="primary" loading={pending} disabled={!plan || periodMissing}>{t('platformClinic.saveSubscription')}</Button>
      </div>
    </form>
  );
}

/** A payment received for the next period: active until the chosen local date (included). */
export function MarkPaidForm({ clinicId, defaultUntil }: { clinicId: string; defaultUntil: string }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const [until, setUntil] = useState(defaultUntil);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await markSubscriptionPaid({ clinicId, paidUntil: until, notes: notes.trim() });
          if (!result.ok) return setError(t(`errors.${result.code}`));
          setError(null);
          setNotes('');
          toast({ tone: 'success', title: t('platformClinic.paymentRecorded') });
          router.refresh();
        });
      }}
    >
      <Field id="paid-until" label={t('platformClinic.paidUntil')} required>
        <Input type="date" dir="ltr" value={until} onChange={(e) => setUntil(e.target.value)} />
      </Field>
      <Field id="paid-notes" label={t('platformClinic.paymentNote')} optionalLabel={t('common.optional')}>
        <Input value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <Button type="submit" variant="secondary" loading={pending} disabled={!until}>{t('platformClinic.markPaid')}</Button>
      {error ? <InlineAlert tone="danger" className="sm:col-span-3">{error}</InlineAlert> : null}
    </form>
  );
}
