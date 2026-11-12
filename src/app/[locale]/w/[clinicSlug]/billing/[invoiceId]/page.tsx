import { ArrowLeft, Printer } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import { z } from 'zod';

import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { invoiceActions } from '@/modules/billing/domain';
import { centsToDecimal, decimalToCents, quantityLabel } from '@/modules/billing/money';
import { loadInvoice } from '@/modules/billing/queries';
import { DraftEditor } from '@/modules/billing/ui/draft-editor';
import { PaymentDialog, ReversePaymentButton, VoidInvoiceButton } from '@/modules/billing/ui/invoice-actions';
import { InvoiceStatusBadge } from '@/modules/billing/ui/invoice-status-badge';
import { localizedName } from '@/modules/catalog/names';
import { loadCatalog } from '@/modules/catalog/queries';
import { can, loadWorkspace } from '@/modules/tenancy/workspace';
import { formatDateTime, formatMoney } from '@/shared/lib/format';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { DataTable, type Column } from '@/shared/ui/data-table';
import { DetailList, PageHeader, Section } from '@/shared/ui/layout';
import { ErrorState, InlineAlert } from '@/shared/ui/states';

import { LoadFailure } from '../../_lib/page-state';

export async function generateMetadata() {
  const t = await getTranslations('billing');
  return { title: t('invoice') };
}

/**
 * Invoice file: the draft editor before issue, then the frozen invoice (BR-F-02) with its
 * payments, receipts, reversals and voiding. Every action is re-checked by the database.
 */
export default async function InvoicePage({ params }: { params: Promise<{ clinicSlug: string; invoiceId: string }> }) {
  const { clinicSlug, invoiceId } = await params;
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const result = await loadWorkspace(clinicSlug);
  if (result.status !== 'ok') return null;
  const ws = result.workspace;
  const notFound = (
    <div className="rounded-lg border border-line bg-surface">
      <ErrorState title={t('states.notFoundTitle')} description={t('states.notFoundBody')} />
    </div>
  );
  if (!can(ws, 'invoices.view')) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <ErrorState title={t('states.forbiddenTitle')} description={t('states.forbiddenBody')} />
      </div>
    );
  }
  if (!z.uuid().safeParse(invoiceId).success) return notFound;

  const invoice = await loadInvoice(ws.clinic.id, invoiceId);
  if (invoice.status === 'error' && invoice.code === 'NOT_FOUND') return notFound;
  if (invoice.status !== 'ok') return <LoadFailure outcome={invoice} />;
  const inv = invoice.data;

  const slug = ws.clinic.slug;
  const tz = ws.clinic.timezone;
  const writable = ws.clinic.status !== 'suspended';
  const allowed = invoiceActions(inv.status);
  const editing = allowed.edit && writable && can(ws, 'invoices.create');
  const catalog = editing ? await loadCatalog(ws.clinic.id) : null;
  const balanceMad = centsToDecimal(decimalToCents(inv.totalMad) - decimalToCents(inv.paidMad));
  const canReverse = writable && can(ws, 'payments.reverse') && inv.status !== 'void';

  const details = [
    {
      label: t('billing.billTo'),
      value: can(ws, 'patients.view') ? (
        <Link href={`/w/${slug}/patients/${inv.patientId}`} className="focus-ring rounded-sm font-medium text-accent hover:underline">{inv.billTo}</Link>
      ) : (
        <span className="font-medium">{inv.billTo}</span>
      ),
    },
    ...(inv.appointmentId && can(ws, 'appointments.view')
      ? [{ label: t('billing.appointment'), value: <Link href={`/w/${slug}/appointments/${inv.appointmentId}`} className="focus-ring rounded-sm text-accent hover:underline">{t('billing.openAppointment')}</Link> }]
      : []),
    { label: t('billing.createdAt'), value: <time dateTime={inv.createdAt} className="tabular">{formatDateTime(locale, inv.createdAt, tz)}</time> },
    ...(inv.issuedAt ? [{ label: t('billing.issuedAt'), value: <time dateTime={inv.issuedAt} className="tabular">{formatDateTime(locale, inv.issuedAt, tz)}</time> }] : []),
    ...(inv.status !== 'draft' ? [
      { label: t('billing.total'), value: <span className="tabular font-medium">{formatMoney(locale, inv.totalMad)}</span> },
      { label: t('billing.paid'), value: <span className="tabular">{formatMoney(locale, inv.paidMad)}</span> },
      ...(allowed.pay ? [{ label: t('billing.balance'), value: <span className="tabular font-medium">{formatMoney(locale, balanceMad)}</span> }] : []),
    ] : []),
    ...(inv.notes ? [{ label: t('billing.notes'), value: inv.notes }] : []),
  ];

  type Item = (typeof inv.items)[number];
  const itemColumns: Column<Item>[] = [
    { id: 'description', header: t('billing.line.description'), cell: (i) => i.description },
    { id: 'quantity', header: t('billing.line.quantity'), align: 'end', className: 'w-24', cell: (i) => <span className="tabular">{quantityLabel(i.quantity)}</span> },
    { id: 'price', header: t('billing.line.unitPrice'), align: 'end', className: 'w-32', cell: (i) => <span className="tabular">{formatMoney(locale, i.unitPriceMad)}</span> },
    { id: 'total', header: t('billing.line.total'), align: 'end', className: 'w-32', cell: (i) => <span className="tabular">{formatMoney(locale, i.lineTotalMad)}</span> },
  ];

  type Pay = (typeof inv.payments)[number];
  const paymentColumns: Column<Pay>[] = [
    { id: 'receipt', header: t('billing.columns.receipt'), className: 'w-36', cell: (p) => <span className="tabular" dir="ltr">{p.receiptNumber}</span> },
    { id: 'when', header: t('billing.columns.date'), className: 'w-44', cell: (p) => <time dateTime={p.paidAt} className="tabular">{formatDateTime(locale, p.paidAt, tz)}</time> },
    {
      id: 'method',
      header: t('billing.method'),
      hideBelow: 'md',
      cell: (p) => (
        <span className="grid">
          <span>{t(`billing.methods.${p.method}`)}</span>
          {p.reference ? <span className="text-caption text-ink-subtle">{p.reference}</span> : null}
        </span>
      ),
    },
    {
      id: 'amount',
      header: t('billing.amount'),
      align: 'end',
      className: 'w-32',
      cell: (p) => <span className={p.status === 'reversed' ? 'tabular text-ink-subtle line-through' : 'tabular'}>{formatMoney(locale, p.amountMad)}</span>,
    },
    {
      id: 'state',
      header: t('billing.columns.status'),
      className: 'w-56',
      cell: (p) => (p.status === 'reversed' ? (
        <span className="grid gap-0.5">
          <Badge tone="danger">{t('billing.paymentReversed')}</Badge>
          {p.reversalReason ? <span className="text-caption text-ink-subtle">{p.reversalReason}</span> : null}
        </span>
      ) : (
        <span className="flex flex-wrap items-center gap-1">
          <Button asChild size="sm" variant="ghost">
            <Link href={`/print/${slug}/invoices/${inv.id}?receipt=${p.id}`} aria-label={t('billing.printReceiptOf', { receipt: p.receiptNumber })}>
              <Printer aria-hidden />
              {t('billing.receipt')}
            </Link>
          </Button>
          {canReverse ? <ReversePaymentButton paymentId={p.id} receipt={p.receiptNumber} /> : null}
        </span>
      )),
    },
  ];

  const title = inv.number ? t('billing.invoiceNumber', { number: inv.number }) : t('billing.draftTitle');

  return (
    <>
      <PageHeader
        title={<span dir="auto">{title}</span>}
        description={inv.billTo}
        meta={
          <span className="flex flex-wrap items-center gap-2">
            <Link href={`/w/${slug}/billing`} className="focus-ring inline-flex items-center gap-1 rounded-sm text-small text-ink-muted hover:text-ink">
              <ArrowLeft aria-hidden className="size-4 flip-rtl" />
              {t('billing.backToList')}
            </Link>
            <InvoiceStatusBadge status={inv.status} />
          </span>
        }
        actions={
          <>
            {inv.status !== 'draft' ? (
              <Button asChild variant="secondary">
                <Link href={`/print/${slug}/invoices/${inv.id}`}>
                  <Printer aria-hidden />
                  {t('billing.printInvoice')}
                </Link>
              </Button>
            ) : null}
            {writable && allowed.void && can(ws, 'invoices.void') && inv.number ? (
              <VoidInvoiceButton invoiceId={inv.id} version={inv.version} number={inv.number} />
            ) : null}
            {writable && allowed.pay && can(ws, 'payments.record') ? <PaymentDialog invoiceId={inv.id} balanceMad={balanceMad} /> : null}
          </>
        }
      />

      {inv.status === 'void' ? (
        <InlineAlert tone="danger">
          {t('billing.voidNotice', { reason: inv.voidReason ?? '—', date: inv.voidedAt ? formatDateTime(locale, inv.voidedAt, tz) : '—' })}
        </InlineAlert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,1.4fr)]">
        <Section id="lines" title={t('billing.lines')} description={editing ? t('billing.linesHint') : undefined}>
          {editing ? (
            <DraftEditor
              slug={slug}
              invoiceId={inv.id}
              version={inv.version}
              items={inv.items}
              discountMad={inv.discountMad}
              notes={inv.notes}
              canIssue={can(ws, 'invoices.issue')}
              services={catalog?.status === 'ok'
                ? catalog.data.services.filter((s) => s.active).map((s) => ({ id: s.id, label: localizedName(locale, s.nameFr, s.nameAr), priceMad: s.priceMad }))
                : []}
            />
          ) : (
            <DataTable
              caption={t('billing.lines')}
              columns={itemColumns}
              rows={inv.items}
              getRowId={(i) => i.id}
              footer={
                <dl className="ms-auto grid w-full max-w-xs gap-1 text-body">
                  <div className="flex justify-between gap-4"><dt className="text-ink-muted">{t('billing.subtotal')}</dt><dd className="tabular">{formatMoney(locale, inv.subtotalMad)}</dd></div>
                  {decimalToCents(inv.discountMad) > 0 ? (
                    <div className="flex justify-between gap-4"><dt className="text-ink-muted">{t('billing.discount')}</dt><dd className="tabular">{formatMoney(locale, `-${inv.discountMad}`)}</dd></div>
                  ) : null}
                  <div className="flex justify-between gap-4 font-medium"><dt>{t('billing.total')}</dt><dd className="tabular">{formatMoney(locale, inv.totalMad)}</dd></div>
                </dl>
              }
            />
          )}
        </Section>

        <Section id="details" title={t('billing.details')}>
          <div className="rounded-lg border border-line bg-surface p-4">
            <DetailList items={details} />
          </div>
        </Section>
      </div>

      {inv.status !== 'draft' ? (
        <Section id="payments" title={t('billing.payments')} description={t('billing.paymentsHint')}>
          {inv.payments.length === 0 ? (
            <p className="text-small text-ink-muted">{t('billing.noPayments')}</p>
          ) : (
            <DataTable caption={t('billing.payments')} columns={paymentColumns} rows={inv.payments} getRowId={(p) => p.id} />
          )}
        </Section>
      ) : null}
    </>
  );
}
