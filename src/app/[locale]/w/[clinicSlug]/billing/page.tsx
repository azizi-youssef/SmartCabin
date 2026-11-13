import { ReceiptText, Search } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { INVOICE_FILTERS, type InvoiceFilter } from '@/modules/billing/domain';
import { centsToDecimal, decimalToCents } from '@/modules/billing/money';
import { INVOICE_PAGE_SIZE, loadInvoices, sanitizeInvoiceSearch } from '@/modules/billing/queries';
import { InvoiceStatusBadge } from '@/modules/billing/ui/invoice-status-badge';
import { can, loadWorkspace } from '@/modules/tenancy/workspace';
import { cn } from '@/shared/lib/cn';
import { formatMoney, formatShortDate } from '@/shared/lib/format';
import { submitSearch } from '@/shared/lib/search-actions';
import { readSearchTerm } from '@/shared/lib/search-term';
import { Button } from '@/shared/ui/button';
import { DataTable, type Column } from '@/shared/ui/data-table';
import { Input } from '@/shared/ui/form-controls';
import { PageHeader } from '@/shared/ui/layout';
import { EmptyState, ErrorState } from '@/shared/ui/states';

import { LoadFailure } from '../_lib/page-state';

export async function generateMetadata() {
  const t = await getTranslations('billing');
  return { title: t('title') };
}

/** Invoices of the clinic, newest first, by status group, with a search on number or name. */
export default async function BillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicSlug: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const [{ clinicSlug }, query] = await Promise.all([params, searchParams]);
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const result = await loadWorkspace(clinicSlug);
  if (result.status !== 'ok') return null;
  const ws = result.workspace;
  if (!can(ws, 'invoices.view')) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <ErrorState title={t('states.forbiddenTitle')} description={t('states.forbiddenBody')} />
      </div>
    );
  }

  const filter: InvoiceFilter = (INVOICE_FILTERS as readonly string[]).includes(query.status ?? '') ? (query.status as InvoiceFilter) : 'all';
  // Names typed in the search stay out of the URL (SC-AUD-07): posted, kept in an HttpOnly cookie.
  const q = sanitizeInvoiceSearch(await readSearchTerm('invoices', ws.clinic.slug));
  const invoices = await loadInvoices({ clinicId: ws.clinic.id, filter, query: q });
  const base = `/w/${ws.clinic.slug}/billing`;
  const tz = ws.clinic.timezone;

  const header = (
    <PageHeader
      title={t('billing.title')}
      description={t('billing.subtitle')}
      actions={can(ws, 'billing.reports') ? (
        <Button asChild variant="secondary">
          <Link href={`/w/${ws.clinic.slug}/revenue`}>{t('billing.revenueLink')}</Link>
        </Button>
      ) : null}
    />
  );
  if (invoices.status !== 'ok') return (<>{header}<LoadFailure outcome={invoices} /></>);

  type Row = (typeof invoices.data.rows)[number];
  const columns: Column<Row>[] = [
    {
      id: 'number',
      header: t('billing.columns.number'),
      className: 'w-40',
      cell: (i) => (
        <Link href={`${base}/${i.id}`} className="focus-ring rounded-sm font-medium text-accent hover:underline">
          {i.number ? <span className="tabular" dir="ltr">{i.number}</span> : t('billing.draftLabel')}
        </Link>
      ),
    },
    { id: 'date', header: t('billing.columns.date'), className: 'w-32', cell: (i) => formatShortDate(locale, i.issuedAt ?? i.createdAt, tz) },
    { id: 'billTo', header: t('billing.columns.billTo'), cell: (i) => i.billTo },
    { id: 'total', header: t('billing.columns.total'), align: 'end', className: 'w-32', cell: (i) => <span className="tabular">{formatMoney(locale, i.totalMad)}</span> },
    {
      id: 'balance',
      header: t('billing.columns.balance'),
      align: 'end',
      hideBelow: 'md',
      className: 'w-32',
      cell: (i) => (i.status === 'issued' || i.status === 'partially_paid'
        ? <span className="tabular">{formatMoney(locale, centsToDecimal(decimalToCents(i.totalMad) - decimalToCents(i.paidMad)))}</span>
        : <span className="text-ink-subtle">—</span>),
    },
    { id: 'status', header: t('billing.columns.status'), className: 'w-40', cell: (i) => <InvoiceStatusBadge status={i.status} /> },
  ];

  const { rows, hasMore } = invoices.data;
  return (
    <>
      {header}
      <nav aria-label={t('billing.filtersLabel')} className="flex flex-wrap gap-1">
        {INVOICE_FILTERS.map((f) => {
          const href = `${base}${f === 'all' ? '' : `?status=${f}`}`;
          return (
            <Link
              key={f}
              href={href}
              aria-current={f === filter ? 'page' : undefined}
              className={cn(
                'focus-ring rounded-md px-3 py-1.5 text-small font-medium',
                f === filter ? 'bg-primary text-primary-fg' : 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
              )}
            >
              {t(`billing.filters.${f}`)}
            </Link>
          );
        })}
      </nav>
      <DataTable
        caption={t('billing.listCaption')}
        columns={columns}
        rows={rows}
        getRowId={(i) => i.id}
        toolbar={
          <form role="search" className="flex w-full flex-wrap items-center gap-2" action={submitSearch}>
            <input type="hidden" name="scope" value="invoices" />
            <input type="hidden" name="clinic" value={ws.clinic.slug} />
            <label htmlFor="invoice-search" className="sr-only">{t('billing.searchLabel')}</label>
            <div className="relative min-w-0 flex-1 sm:max-w-md">
              <Search aria-hidden className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
              <Input id="invoice-search" name="q" type="search" defaultValue={q} placeholder={t('billing.searchPlaceholder')} className="ps-9" />
            </div>
            <Button type="submit" variant="secondary">{t('common.search')}</Button>
            {q ? <Button type="submit" name="clear" value="1" variant="ghost">{t('common.clearSearch')}</Button> : null}
          </form>
        }
        footer={hasMore ? <span>{t('billing.tooMany', { count: INVOICE_PAGE_SIZE })}</span> : undefined}
        empty={<EmptyState icon={ReceiptText} title={q ? t('billing.emptySearch', { query: q }) : t('billing.empty')} description={t('billing.emptyHint')} />}
      />
    </>
  );
}
