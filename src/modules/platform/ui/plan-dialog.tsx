'use client';

import { Pencil, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { useRouter } from '@/i18n/navigation';
import { LIMIT_KEYS, type LimitKey, type Limits } from '@/modules/subscriptions/domain';
import { Button } from '@/shared/ui/button';
import { Dialog, DialogContent, DialogTrigger } from '@/shared/ui/dialog';
import { Field } from '@/shared/ui/field';
import { Checkbox, Input } from '@/shared/ui/form-controls';
import { InlineAlert } from '@/shared/ui/states';
import { useToast } from '@/shared/ui/toast';

import { savePlan } from '../actions';

interface PlanValues {
  id: string | null;
  code: string;
  nameFr: string;
  nameAr: string;
  monthlyPriceMad: string;
  graceDays: number;
  isPublic: boolean;
  isActive: boolean;
  limits: Limits;
}

const EMPTY: PlanValues = {
  id: null, code: '', nameFr: '', nameAr: '', monthlyPriceMad: '0', graceDays: 7, isPublic: true, isActive: true,
  limits: { max_doctors: null, max_staff: null, monthly_sms_quota: null },
};

/** Create or edit a plan; an empty limit means unlimited. The code is fixed once created. */
export function PlanDialog({ plan }: { plan?: PlanValues }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<PlanValues>(plan ?? EMPTY);
  const [limits, setLimits] = useState<Record<LimitKey, string>>(() => toText((plan ?? EMPTY).limits));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const editing = Boolean(plan);

  const parsedLimits = Object.fromEntries(LIMIT_KEYS.map((k) => [k, limits[k].trim() === '' ? null : /^\d{1,7}$/.test(limits[k].trim()) ? Number(limits[k]) : NaN])) as Record<LimitKey, number | null>;
  const invalid = Object.values(parsedLimits).some((v) => v !== null && Number.isNaN(v))
    || !/^[a-z][a-z0-9_]{1,29}$/.test(values.code) || values.nameFr.trim().length < 2 || values.nameAr.trim().length < 2
    || !/^\d{1,7}([.,]\d{1,2})?$/.test(values.monthlyPriceMad.trim());

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (next) {
          setValues(plan ?? EMPTY);
          setLimits(toText((plan ?? EMPTY).limits));
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        {editing ? (
          <Button size="sm" variant="ghost" aria-label={t('platformPlans.editOf', { name: plan?.nameFr ?? '' })}>
            <Pencil aria-hidden />
            {t('platformPlans.edit')}
          </Button>
        ) : (
          <Button variant="primary"><Plus aria-hidden />{t('platformPlans.create')}</Button>
        )}
      </DialogTrigger>
      <DialogContent
        title={editing ? t('platformPlans.editTitle') : t('platformPlans.createTitle')}
        description={t('platformPlans.dialogHint')}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={invalid}
              onClick={() => startTransition(async () => {
                const result = await savePlan({
                  planId: values.id,
                  code: values.code,
                  nameFr: values.nameFr.trim(),
                  nameAr: values.nameAr.trim(),
                  monthlyPriceMad: values.monthlyPriceMad.trim().replace(',', '.'),
                  graceDays: values.graceDays,
                  isPublic: values.isPublic,
                  isActive: values.isActive,
                  limits: parsedLimits,
                });
                if (!result.ok) return setError(t(`errors.${result.code}`));
                toast({ tone: 'success', title: t('platformPlans.saved') });
                setOpen(false);
                router.refresh();
              })}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="plan-code" label={t('platformPlans.code')} hint={t('platformPlans.codeHint')} required>
            <Input dir="ltr" value={values.code} disabled={editing} maxLength={30} onChange={(e) => setValues({ ...values, code: e.target.value.toLowerCase() })} />
          </Field>
          <Field id="plan-price" label={t('platformPlans.price')} required>
            <Input dir="ltr" inputMode="decimal" className="tabular" value={values.monthlyPriceMad} onChange={(e) => setValues({ ...values, monthlyPriceMad: e.target.value })} />
          </Field>
          <Field id="plan-name-fr" label={t('platformPlans.nameFr')} required>
            <Input value={values.nameFr} maxLength={60} onChange={(e) => setValues({ ...values, nameFr: e.target.value })} />
          </Field>
          <Field id="plan-name-ar" label={t('platformPlans.nameAr')} required>
            <Input dir="rtl" lang="ar" value={values.nameAr} maxLength={60} onChange={(e) => setValues({ ...values, nameAr: e.target.value })} />
          </Field>
          {LIMIT_KEYS.map((k) => (
            <Field key={k} id={`plan-limit-${k}`} label={t(`subscription.limits.${k}`)} hint={t('platformPlans.unlimitedHint')}
              error={Number.isNaN(parsedLimits[k]) ? t('platformPlans.limitInvalid') : undefined}>
              <Input dir="ltr" inputMode="numeric" className="tabular" value={limits[k]} onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} />
            </Field>
          ))}
          <Field id="plan-grace" label={t('platformPlans.graceDays')} hint={t('platformPlans.graceHint')}>
            <Input dir="ltr" type="number" min={0} max={60} className="tabular" value={values.graceDays}
              onChange={(e) => setValues({ ...values, graceDays: Math.max(0, Math.min(60, Number(e.target.value) || 0)) })} />
          </Field>
          <div className="grid content-start gap-2 sm:col-span-2">
            <Checkbox id="plan-public" checked={values.isPublic} onChange={(e) => setValues({ ...values, isPublic: e.target.checked })} label={t('platformPlans.public')} />
            <Checkbox id="plan-active" checked={values.isActive} onChange={(e) => setValues({ ...values, isActive: e.target.checked })} label={t('platformPlans.active')} />
          </div>
          {error ? <InlineAlert tone="danger" className="sm:col-span-2">{error}</InlineAlert> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function toText(limits: Limits): Record<LimitKey, string> {
  return Object.fromEntries(LIMIT_KEYS.map((k) => [k, limits[k] === null ? '' : String(limits[k])])) as Record<LimitKey, string>;
}
