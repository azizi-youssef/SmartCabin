'use client';

import { Banknote, FilePlus2, Printer, Undo2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState, useTransition } from 'react';

import { useRouter } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { formatMoney } from '@/shared/lib/format';
import { Button, type ButtonProps } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Dialog, DialogContent, DialogTrigger } from '@/shared/ui/dialog';
import { Field } from '@/shared/ui/field';
import { Input, Select, Textarea } from '@/shared/ui/form-controls';
import { InlineAlert } from '@/shared/ui/states';
import { useToast } from '@/shared/ui/toast';

import { createInvoiceDraft, recordPayment, reversePayment, voidInvoice } from '../actions';
import { PAYMENT_METHODS, type PaymentMethod } from '../domain';
import { centsToDecimal, decimalToCents, parseCents } from '../money';

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** "Facturer": opens a draft for an appointment (its booked price) or a patient, then shows it. */
export function NewInvoiceButton({ slug, appointmentId, patientId, label, variant = 'secondary' }: {
  slug: string;
  appointmentId?: string;
  patientId?: string;
  label: string;
  variant?: ButtonProps['variant'];
}) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  // One key per button: a double click or a retry opens the same draft (API_SPECIFICATION §4.1).
  const key = useRef<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant={variant}
      loading={pending}
      onClick={() => startTransition(async () => {
        key.current ??= newKey();
        const result = await createInvoiceDraft({
          ...(appointmentId ? { appointmentId } : {}),
          ...(patientId ? { patientId } : {}),
          idempotencyKey: key.current,
        });
        if (!result.ok) {
          toast({ tone: 'danger', title: t(`errors.${result.code}`) });
          return;
        }
        router.push(`/w/${slug}/billing/${result.data.invoiceId}`);
      })}
    >
      <FilePlus2 aria-hidden />
      {label}
    </Button>
  );
}

/** BR-F-04: at most the balance; the receipt number comes back from the database (BR-F-07). */
export function PaymentDialog({ invoiceId, balanceMad }: { invoiceId: string; balanceMad: string }) {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const router = useRouter();
  const toast = useToast();
  const key = useRef<string>('');
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(balanceMad);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const cents = parseCents(amount);
  const balance = decimalToCents(balanceMad);
  const amountError = cents === null || cents <= 0 ? t('billing.amountInvalid') : cents > balance ? t('errors.PAYMENT_EXCEEDS_BALANCE') : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (next) {
          key.current = newKey();
          setAmount(balanceMad);
          setMethod('cash');
          setReference('');
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="primary">
          <Banknote aria-hidden />
          {t('billing.recordPayment')}
        </Button>
      </DialogTrigger>
      <DialogContent
        title={t('billing.recordPaymentTitle')}
        description={t('billing.balanceDue', { amount: formatMoney(locale, balanceMad) })}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={Boolean(amountError)}
              onClick={() => startTransition(async () => {
                const result = await recordPayment({
                  invoiceId,
                  amountMad: centsToDecimal(cents ?? 0),
                  method,
                  reference: reference.trim(),
                  idempotencyKey: key.current,
                });
                if (!result.ok) return setError(t(`errors.${result.code}`));
                toast({ tone: 'success', title: t('billing.paymentRecorded', { receipt: result.data.receiptNumber }) });
                setOpen(false);
                router.refresh();
              })}
            >
              {t('billing.recordPayment')}
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <Field id="payment-amount" label={t('billing.amount')} required error={amount ? amountError : undefined}>
            <Input inputMode="decimal" dir="ltr" className="tabular" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          </Field>
          <Field id="payment-method" label={t('billing.method')} required>
            <Select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>{t(`billing.methods.${m}`)}</option>
              ))}
            </Select>
          </Field>
          <Field id="payment-reference" label={t('billing.reference')} optionalLabel={t('common.optional')} hint={t('billing.referenceHint')}>
            <Input value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} />
          </Field>
          {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReasonField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const t = useTranslations();
  return (
    <Field id={id} label={t('billing.reason')} required hint={t('billing.reasonHint')}>
      <Textarea value={value} maxLength={300} rows={2} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

/** BR-F-06: only without recorded payments; the number is kept. */
export function VoidInvoiceButton({ invoiceId, version, number }: { invoiceId: string; version: number; number: string }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const [reason, setReason] = useState('');
  return (
    <ConfirmDialog
      trigger={<Button variant="danger-outline">{t('billing.void')}</Button>}
      title={t('billing.voidTitle', { number })}
      description={t('billing.voidBody')}
      confirmLabel={t('billing.void')}
      cancelLabel={t('common.cancel')}
      tone="danger"
      confirmDisabled={reason.trim().length < 3}
      onOpenChange={(open) => { if (open) setReason(''); }}
      onConfirm={async () => {
        const result = await voidInvoice({ invoiceId, version, reason: reason.trim() });
        if (!result.ok) return t(`errors.${result.code}`);
        toast({ tone: 'success', title: t('billing.voided', { number }) });
        router.refresh();
      }}
    >
      <ReasonField id="void-reason" value={reason} onChange={setReason} />
    </ConfirmDialog>
  );
}

/** BR-F-05: a payment is never deleted; it is reversed with a reason. */
export function ReversePaymentButton({ paymentId, receipt }: { paymentId: string; receipt: string }) {
  const t = useTranslations();
  const router = useRouter();
  const toast = useToast();
  const [reason, setReason] = useState('');
  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="ghost" aria-label={t('billing.reverseOf', { receipt })}>
          <Undo2 aria-hidden />
          {t('billing.reverse')}
        </Button>
      }
      title={t('billing.reverseTitle', { receipt })}
      description={t('billing.reverseBody')}
      confirmLabel={t('billing.reverse')}
      cancelLabel={t('common.cancel')}
      tone="danger"
      confirmDisabled={reason.trim().length < 3}
      onOpenChange={(open) => { if (open) setReason(''); }}
      onConfirm={async () => {
        const result = await reversePayment({ paymentId, reason: reason.trim() });
        if (!result.ok) return t(`errors.${result.code}`);
        toast({ tone: 'success', title: t('billing.reversed', { receipt }) });
        router.refresh();
      }}
    >
      <ReasonField id={`reverse-reason-${paymentId}`} value={reason} onChange={setReason} />
    </ConfirmDialog>
  );
}

export function PrintButton({ label }: { label: string }) {
  return (
    <Button variant="primary" onClick={() => window.print()}>
      <Printer aria-hidden />
      {label}
    </Button>
  );
}
