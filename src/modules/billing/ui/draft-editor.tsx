'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useRef, useState, useTransition } from 'react';

import { useRouter } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { formatMoney } from '@/shared/lib/format';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Field } from '@/shared/ui/field';
import { Input, Select, Textarea } from '@/shared/ui/form-controls';
import { InlineAlert } from '@/shared/ui/states';
import { useToast } from '@/shared/ui/toast';

import { discardInvoiceDraft, issueInvoice, saveInvoiceDraft } from '../actions';
import { centsToDecimal, lineTotalCents, parseCents, parseQuantity, quantityLabel } from '../money';

export interface ServiceOption {
  id: string;
  label: string;
  priceMad: string;
}

interface Line {
  key: number;
  serviceId: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
}

interface DraftEditorProps {
  slug: string;
  invoiceId: string;
  version: number;
  items: Array<{ serviceId: string | null; description: string; quantity: string; unitPriceMad: string }>;
  discountMad: string;
  notes: string | null;
  services: ServiceOption[];
  canIssue: boolean;
}

const MAX_LINES = 50;

/**
 * Draft lines (BR-F-02: editable only before issue). The preview is computed in cents with the
 * database's rounding; the database recomputes and stores the real totals on save.
 */
export function DraftEditor({ slug, invoiceId, version: initialVersion, items, discountMad, notes: initialNotes, services, canIssue }: DraftEditorProps) {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const router = useRouter();
  const toast = useToast();
  const nextKey = useRef(items.length + 1);
  const [version, setVersion] = useState(initialVersion);
  const [lines, setLines] = useState<Line[]>(() =>
    items.map((i, index) => ({ key: index + 1, serviceId: i.serviceId, description: i.description, quantity: quantityLabel(i.quantity), unitPrice: i.unitPriceMad })));
  const [discount, setDiscount] = useState(discountMad === '0.00' ? '0' : discountMad);
  const [notes, setNotes] = useState(initialNotes ?? '');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [picked, setPicked] = useState('');

  const computed = useMemo(() => {
    const rows = lines.map((l) => {
      const qty = parseQuantity(l.quantity);
      const price = parseCents(l.unitPrice);
      const descriptionOk = l.description.trim().length > 0 && l.description.trim().length <= 200;
      return { qty, price, descriptionOk, total: qty !== null && price !== null ? lineTotalCents(qty, price) : null };
    });
    const subtotal = rows.reduce((sum, r) => sum + (r.total ?? 0), 0);
    const discountCents = parseCents(discount || '0');
    const valid = rows.every((r) => r.qty !== null && r.price !== null && r.descriptionOk)
      && discountCents !== null && discountCents <= subtotal && notes.length <= 500;
    return { rows, subtotal, discountCents, total: subtotal - (discountCents ?? 0), valid };
  }, [lines, discount, notes]);

  const money = (cents: number) => formatMoney(locale, centsToDecimal(cents));

  function change(update: (current: Line[]) => Line[]) {
    setLines(update);
    setDirty(true);
    setError(null);
  }

  function addService(serviceId: string) {
    const service = services.find((s) => s.id === serviceId);
    if (!service || lines.length >= MAX_LINES) return;
    change((current) => [...current, { key: nextKey.current++, serviceId: service.id, description: service.label, quantity: '1', unitPrice: service.priceMad }]);
    setPicked('');
  }

  function addFreeLine() {
    if (lines.length >= MAX_LINES) return;
    change((current) => [...current, { key: nextKey.current++, serviceId: null, description: '', quantity: '1', unitPrice: '' }]);
  }

  async function save(): Promise<number | null> {
    const result = await saveInvoiceDraft({
      invoiceId,
      version,
      items: lines.map((l) => ({
        serviceId: l.serviceId,
        description: l.description.trim(),
        quantity: centsToDecimal(parseQuantity(l.quantity) ?? 0),
        unitPriceMad: centsToDecimal(parseCents(l.unitPrice) ?? 0),
      })),
      discountMad: centsToDecimal(computed.discountCents ?? 0),
      notes: notes.trim(),
    });
    if (!result.ok) {
      setError(t(`errors.${result.code}`));
      return null;
    }
    setVersion(result.data.version);
    setDirty(false);
    return result.data.version;
  }

  const disabled = pending || !computed.valid;

  return (
    <div className="grid gap-4">
      <div className="rounded-lg border border-line bg-surface">
        <div className="hidden grid-cols-[minmax(0,1fr)_5.5rem_8rem_7.5rem_2.25rem] gap-2 border-b border-line bg-surface-muted px-3 py-2 text-caption font-medium text-ink-muted sm:grid">
          <span>{t('billing.line.description')}</span>
          <span>{t('billing.line.quantity')}</span>
          <span>{t('billing.line.unitPrice')}</span>
          <span className="text-end">{t('billing.line.total')}</span>
          <span className="sr-only">{t('billing.line.actions')}</span>
        </div>
        {lines.length === 0 ? (
          <p className="px-4 py-6 text-small text-ink-muted">{t('billing.noLines')}</p>
        ) : (
          <ol className="grid">
            {lines.map((line, index) => {
              const row = computed.rows[index];
              const n = index + 1;
              return (
                <li key={line.key} className="grid grid-cols-2 gap-2 border-b border-line px-3 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_5.5rem_8rem_7.5rem_2.25rem] sm:items-start">
                  <div className="col-span-2 grid gap-1 sm:col-span-1">
                    <label htmlFor={`line-${line.key}-description`} className="text-caption text-ink-muted sm:sr-only">
                      {t('billing.line.descriptionOf', { n })}
                    </label>
                    <Input
                      id={`line-${line.key}-description`}
                      value={line.description}
                      maxLength={200}
                      aria-invalid={row && !row.descriptionOk ? true : undefined}
                      onChange={(e) => change((c) => c.map((l) => (l.key === line.key ? { ...l, description: e.target.value } : l)))}
                    />
                  </div>
                  <div className="grid gap-1">
                    <label htmlFor={`line-${line.key}-quantity`} className="text-caption text-ink-muted sm:sr-only">
                      {t('billing.line.quantityOf', { n })}
                    </label>
                    <Input
                      id={`line-${line.key}-quantity`}
                      inputMode="decimal"
                      dir="ltr"
                      className="tabular"
                      value={line.quantity}
                      aria-invalid={row?.qty === null ? true : undefined}
                      onChange={(e) => change((c) => c.map((l) => (l.key === line.key ? { ...l, quantity: e.target.value } : l)))}
                    />
                  </div>
                  <div className="grid gap-1">
                    <label htmlFor={`line-${line.key}-price`} className="text-caption text-ink-muted sm:sr-only">
                      {t('billing.line.unitPriceOf', { n })}
                    </label>
                    <Input
                      id={`line-${line.key}-price`}
                      inputMode="decimal"
                      dir="ltr"
                      className="tabular"
                      value={line.unitPrice}
                      aria-invalid={row?.price === null ? true : undefined}
                      onChange={(e) => change((c) => c.map((l) => (l.key === line.key ? { ...l, unitPrice: e.target.value } : l)))}
                    />
                  </div>
                  <output className="tabular self-center text-body text-ink sm:text-end" aria-label={t('billing.line.totalOf', { n })}>
                    {row?.total != null ? money(row.total) : '—'}
                  </output>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="justify-self-end"
                    aria-label={t('billing.line.remove', { n })}
                    onClick={() => change((c) => c.filter((l) => l.key !== line.key))}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </li>
              );
            })}
          </ol>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-3">
          {services.length > 0 ? (
            <>
              <label htmlFor="add-service" className="sr-only">{t('billing.addService')}</label>
              <Select id="add-service" value={picked} className="w-auto min-w-48" onChange={(e) => addService(e.target.value)} disabled={lines.length >= MAX_LINES}>
                <option value="">{t('billing.addService')}</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>{`${s.label} — ${formatMoney(locale, s.priceMad)}`}</option>
                ))}
              </Select>
            </>
          ) : null}
          <Button size="sm" variant="ghost" onClick={addFreeLine} disabled={lines.length >= MAX_LINES}>
            <Plus aria-hidden />
            {t('billing.addLine')}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_16rem]">
        <Field id="invoice-notes" label={t('billing.notes')} optionalLabel={t('common.optional')} hint={t('billing.notesHint')}>
          <Textarea value={notes} maxLength={500} rows={2} onChange={(e) => { setNotes(e.target.value); setDirty(true); }} />
        </Field>
        <div className="grid content-start gap-3">
          <Field id="invoice-discount" label={t('billing.discount')} error={computed.discountCents === null || (computed.discountCents ?? 0) > computed.subtotal ? t('billing.discountInvalid') : undefined}>
            <Input inputMode="decimal" dir="ltr" className="tabular" value={discount} onChange={(e) => { setDiscount(e.target.value); setDirty(true); }} />
          </Field>
          <dl className="grid gap-1 rounded-lg border border-line bg-surface p-3 text-body">
            <div className="flex justify-between gap-4"><dt className="text-ink-muted">{t('billing.subtotal')}</dt><dd className="tabular">{money(computed.subtotal)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-ink-muted">{t('billing.discount')}</dt><dd className="tabular">{money(-(computed.discountCents ?? 0))}</dd></div>
            <div className="flex justify-between gap-4 border-t border-line pt-1 font-medium"><dt>{t('billing.total')}</dt><dd className="tabular">{money(computed.total)}</dd></div>
          </dl>
        </div>
      </div>

      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={dirty || !canIssue ? 'primary' : 'secondary'}
          loading={pending}
          disabled={disabled || !dirty}
          onClick={() => startTransition(async () => {
            if ((await save()) !== null) {
              toast({ tone: 'success', title: t('billing.draftSaved') });
              router.refresh();
            }
          })}
        >
          {t('billing.saveDraft')}
        </Button>
        {canIssue ? (
          <ConfirmDialog
            trigger={<Button variant={dirty ? 'secondary' : 'primary'} disabled={disabled || lines.length === 0 || computed.total <= 0}>{t('billing.issue')}</Button>}
            title={t('billing.issueTitle')}
            description={t('billing.issueBody', { total: money(computed.total) })}
            confirmLabel={t('billing.issue')}
            cancelLabel={t('common.cancel')}
            onConfirm={async () => {
              const current = dirty ? await save() : version;
              if (current === null) return t('billing.saveFailed');
              const result = await issueInvoice({ invoiceId, version: current });
              if (!result.ok) return t(`errors.${result.code}`);
              toast({ tone: 'success', title: t('billing.issued', { number: result.data.number }) });
              router.refresh();
            }}
          />
        ) : null}
        <ConfirmDialog
          trigger={<Button variant="ghost" className="ms-auto text-danger hover:text-danger" disabled={pending}>{t('billing.discard')}</Button>}
          title={t('billing.discardTitle')}
          description={t('billing.discardBody')}
          confirmLabel={t('billing.discard')}
          cancelLabel={t('common.cancel')}
          tone="danger"
          onConfirm={async () => {
            const result = await discardInvoiceDraft({ invoiceId, version });
            if (!result.ok) return t(`errors.${result.code}`);
            toast({ tone: 'success', title: t('billing.discarded') });
            router.push(`/w/${slug}/billing`);
          }}
        />
      </div>
    </div>
  );
}
