import { ArrowLeft } from 'lucide-react';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { z } from 'zod';

import { Link, redirect } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { centsToDecimal, decimalToCents, quantityLabel } from '@/modules/billing/money';
import { loadInvoice, type InvoiceFile } from '@/modules/billing/queries';
import { PrintButton } from '@/modules/billing/ui/invoice-actions';
import { can, loadWorkspace } from '@/modules/tenancy/workspace';
import { formatDateTime, formatLongDate, formatMoney } from '@/shared/lib/format';
import { formatPhone } from '@/shared/lib/phone';
import { ErrorState } from '@/shared/ui/states';

import { ServiceUnavailablePage } from '../../../../_components/service-unavailable';

export async function generateMetadata() {
  const t = await getTranslations('billing');
  return { title: t('printTitle') };
}

function ClinicBlock({ invoice }: { invoice: InvoiceFile }) {
  const c = invoice.clinic;
  if (!c) return null;
  return (
    <address className="grid gap-0.5 not-italic text-small text-ink-muted">
      <span className="text-heading font-semibold text-ink">{c.displayName}</span>
      {c.legalName && c.legalName !== c.displayName ? <span>{c.legalName}</span> : null}
      {c.addressLine ? <span>{c.addressLine}</span> : null}
      {c.city ? <span>{c.city}</span> : null}
      {c.phone ? <span dir="ltr" className="tabular">{formatPhone(c.phone)}</span> : null}
      {c.email ? <span dir="ltr">{c.email}</span> : null}
      {c.ice ? <span className="tabular">ICE {c.ice}</span> : null}
    </address>
  );
}

/**
 * Printable invoice, or one payment's receipt with ?receipt=<payment id>. Outside the workspace
 * shell so that only the document prints. Same rules as the invoice page: invoices.view, the
 * clinic's own rows (RLS), issued invoices only.
 */
export default async function PrintInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicSlug: string; invoiceId: string }>;
  searchParams: Promise<{ receipt?: string }>;
}) {
  const [{ clinicSlug, invoiceId }, query] = await Promise.all([params, searchParams]);
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const result = await loadWorkspace(clinicSlug);
  if (result.status === 'anonymous') redirect({ href: '/sign-in', locale });
  if (result.status === 'mfa_required') redirect({ href: '/mfa', locale });
  if (result.status === 'not_found') notFound();
  if (result.status !== 'ok') return <ServiceUnavailablePage />;
  const ws = result.workspace;
  const tz = ws.clinic.timezone;

  const back = `/w/${ws.clinic.slug}/billing/${invoiceId}`;
  const fail = (title: string, body: string) => (
    <main id="main" tabIndex={-1} className="mx-auto max-w-2xl p-6">
      <div className="rounded-lg border border-line bg-surface"><ErrorState title={title} description={body} /></div>
    </main>
  );
  if (!can(ws, 'invoices.view')) return fail(t('states.forbiddenTitle'), t('states.forbiddenBody'));
  if (!z.uuid().safeParse(invoiceId).success) notFound();
  const loaded = await loadInvoice(ws.clinic.id, invoiceId);
  if (loaded.status === 'error' && loaded.code === 'NOT_FOUND') notFound();
  if (loaded.status !== 'ok') return fail(t('states.errorTitle'), t('states.unavailableBody'));
  const inv = loaded.data;
  if (inv.status === 'draft' || !inv.number || !inv.issuedAt) return fail(t('billing.printDraftTitle'), t('billing.printDraftBody'));

  const payment = query.receipt ? inv.payments.find((p) => p.id === query.receipt) : undefined;
  if (query.receipt && !payment) notFound();
  const money = (v: string) => formatMoney(locale, v);
  const balance = centsToDecimal(decimalToCents(inv.totalMad) - decimalToCents(inv.paidMad));

  return (
    <main id="main" tabIndex={-1} className="mx-auto grid max-w-3xl gap-6 bg-surface p-6 print:max-w-none print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link href={back} className="focus-ring inline-flex items-center gap-1 rounded-sm text-small text-ink-muted hover:text-ink">
          <ArrowLeft aria-hidden className="size-4 flip-rtl" />
          {t('billing.backToInvoice')}
        </Link>
        <PrintButton label={payment ? t('billing.printReceipt') : t('billing.printInvoice')} />
      </div>

      <article className="grid gap-6 rounded-lg border border-line p-8 print:rounded-none print:border-0 print:p-0">
        <header className="flex flex-wrap items-start justify-between gap-6">
          <ClinicBlock invoice={inv} />
          <div className="grid gap-1 text-end">
            <h1 className="text-title text-ink">
              {payment ? t('billing.receiptTitle', { number: payment.receiptNumber }) : t('billing.invoiceNumber', { number: inv.number })}
            </h1>
            <p className="text-small text-ink-muted">
              {formatLongDate(locale, payment ? payment.paidAt : inv.issuedAt, tz)}
            </p>
            {inv.status === 'void' || payment?.status === 'reversed' ? (
              <p className="text-heading font-semibold uppercase text-danger">{payment ? t('billing.paymentReversed') : t('billing.status.void')}</p>
            ) : null}
          </div>
        </header>

        {payment ? (
          <dl className="grid gap-3 text-body sm:grid-cols-2">
            <div><dt className="text-small text-ink-muted">{t('billing.receivedFrom')}</dt><dd className="font-medium">{inv.billTo}</dd></div>
            <div><dt className="text-small text-ink-muted">{t('billing.forInvoice')}</dt><dd className="tabular" dir="ltr">{inv.number}</dd></div>
            <div><dt className="text-small text-ink-muted">{t('billing.amount')}</dt><dd className="text-heading font-semibold tabular">{money(payment.amountMad)}</dd></div>
            <div>
              <dt className="text-small text-ink-muted">{t('billing.method')}</dt>
              <dd>{t(`billing.methods.${payment.method}`)}{payment.reference ? ` · ${payment.reference}` : ''}</dd>
            </div>
            <div><dt className="text-small text-ink-muted">{t('billing.receivedAt')}</dt><dd className="tabular">{formatDateTime(locale, payment.paidAt, tz)}</dd></div>
            <div><dt className="text-small text-ink-muted">{t('billing.invoiceTotal')}</dt><dd className="tabular">{money(inv.totalMad)}</dd></div>
          </dl>
        ) : (
          <>
            <div className="grid gap-0.5">
              <span className="text-small text-ink-muted">{t('billing.billTo')}</span>
              <span className="text-heading font-medium">{inv.billTo}</span>
            </div>
            <table className="w-full border-collapse text-body">
              <caption className="sr-only">{t('billing.lines')}</caption>
              <thead>
                <tr className="border-b border-line-strong text-small text-ink-muted">
                  <th scope="col" className="py-2 text-start font-medium">{t('billing.line.description')}</th>
                  <th scope="col" className="w-20 py-2 text-end font-medium">{t('billing.line.quantity')}</th>
                  <th scope="col" className="w-32 py-2 text-end font-medium">{t('billing.line.unitPrice')}</th>
                  <th scope="col" className="w-32 py-2 text-end font-medium">{t('billing.line.total')}</th>
                </tr>
              </thead>
              <tbody>
                {inv.items.map((i) => (
                  <tr key={i.id} className="border-b border-line">
                    <td className="py-2">{i.description}</td>
                    <td className="py-2 text-end tabular">{quantityLabel(i.quantity)}</td>
                    <td className="py-2 text-end tabular">{money(i.unitPriceMad)}</td>
                    <td className="py-2 text-end tabular">{money(i.lineTotalMad)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <dl className="ms-auto grid w-full max-w-xs gap-1 text-body">
              <div className="flex justify-between gap-4"><dt className="text-ink-muted">{t('billing.subtotal')}</dt><dd className="tabular">{money(inv.subtotalMad)}</dd></div>
              {decimalToCents(inv.discountMad) > 0 ? (
                <div className="flex justify-between gap-4"><dt className="text-ink-muted">{t('billing.discount')}</dt><dd className="tabular">{money(`-${inv.discountMad}`)}</dd></div>
              ) : null}
              <div className="flex justify-between gap-4 border-t border-line-strong pt-1 font-semibold"><dt>{t('billing.total')}</dt><dd className="tabular">{money(inv.totalMad)}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-ink-muted">{t('billing.paid')}</dt><dd className="tabular">{money(inv.paidMad)}</dd></div>
              {inv.status !== 'void' ? (
                <div className="flex justify-between gap-4 font-medium"><dt>{t('billing.balance')}</dt><dd className="tabular">{money(balance)}</dd></div>
              ) : null}
            </dl>
            {inv.notes ? <p className="text-small text-ink-muted">{inv.notes}</p> : null}
          </>
        )}
        <footer className="border-t border-line pt-3 text-caption text-ink-subtle">{t('billing.printFooter')}</footer>
      </article>
    </main>
  );
}
