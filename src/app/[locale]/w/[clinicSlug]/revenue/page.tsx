import { ChevronLeft, ChevronRight, Wallet } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import { PAYMENT_METHODS } from '@/modules/billing/domain';
import { centsToDecimal, decimalToCents } from '@/modules/billing/money';
import { loadRevenue, type RevenueDay } from '@/modules/billing/queries';
import { can, loadWorkspace } from '@/modules/tenancy/workspace';
import { formatLocalDay, formatMoney, intlLocale } from '@/shared/lib/format';
import { today } from '@/shared/lib/time';
import { Button } from '@/shared/ui/button';
import { DataTable, type Column } from '@/shared/ui/data-table';
import { MetricStrip, PageHeader, Section } from '@/shared/ui/layout';
import { EmptyState, ErrorState } from '@/shared/ui/states';

import { LoadFailure } from '../_lib/page-state';

export async function generateMetadata() {
  const t = await getTranslations('revenue');
  return { title: t('title') };
}

function monthBounds(month: string): { from: string; to: string; previous: string; next: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const shift = (delta: number) => {
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}`, previous: shift(-1), next: shift(1) };
}

function sum(days: RevenueDay[], pick: (d: RevenueDay) => string): string {
  return centsToDecimal(days.reduce((total, d) => total + decimalToCents(pick(d)), 0));
}

/**
 * Revenue (K7, BUSINESS_RULES §8) for one month, per local day: invoiced, voided, collected,
 * reversed and net, by payment method. Corrections land on the day they are made.
 */
export default async function RevenuePage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicSlug: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const [{ clinicSlug }, query] = await Promise.all([params, searchParams]);
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations();
  const result = await loadWorkspace(clinicSlug);
  if (result.status !== 'ok') return null;
  const ws = result.workspace;
  if (!can(ws, 'billing.reports')) {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <ErrorState title={t('states.forbiddenTitle')} description={t('states.forbiddenBody')} />
      </div>
    );
  }

  const current = today(ws.clinic.timezone).slice(0, 7);
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(query.month ?? '') ? (query.month as string) : current;
  const { from, to, previous, next } = monthBounds(month);
  const revenue = await loadRevenue(ws.clinic.id, from, to);
  const base = `/w/${ws.clinic.slug}/revenue`;
  const monthLabel = new Intl.DateTimeFormat(intlLocale(locale), { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${month}-01T12:00:00Z`));

  const header = (
    <PageHeader
      title={t('revenue.title')}
      description={t('revenue.subtitle')}
      meta={
        <Link href={`/w/${ws.clinic.slug}/billing`} className="focus-ring rounded-sm text-accent hover:underline">{t('billing.title')}</Link>
      }
      actions={
        <nav aria-label={t('revenue.monthNav')} className="flex items-center gap-1">
          <Button asChild size="icon" variant="ghost">
            <Link href={`${base}?month=${previous}`} aria-label={t('revenue.previousMonth')}><ChevronLeft aria-hidden className="flip-rtl" /></Link>
          </Button>
          <span className="min-w-36 text-center text-body font-medium capitalize" aria-live="polite">{monthLabel}</span>
          <Button asChild size="icon" variant="ghost">
            <Link href={`${base}?month=${next}`} aria-label={t('revenue.nextMonth')}><ChevronRight aria-hidden className="flip-rtl" /></Link>
          </Button>
        </nav>
      }
    />
  );
  if (revenue.status !== 'ok') return (<>{header}<LoadFailure outcome={revenue} /></>);

  const days = revenue.data;
  const active = days.filter((d) => d.invoicesIssued || d.invoicesVoided || d.paymentsCount || decimalToCents(d.reversedMad));
  const money = (v: string) => formatMoney(locale, v);
  const byMethod = PAYMENT_METHODS.map((m) => ({ method: m, cents: days.reduce((total, d) => total + decimalToCents(d.byMethod[m] ?? '0'), 0) }))
    .filter((m) => m.cents !== 0);

  const columns: Column<RevenueDay>[] = [
    { id: 'day', header: t('revenue.columns.day'), cell: (d) => formatLocalDay(locale, d.day, 'short') },
    { id: 'invoiced', header: t('revenue.columns.invoiced'), align: 'end', cell: (d) => <span className="tabular">{money(d.invoicedMad)}</span> },
    { id: 'voided', header: t('revenue.columns.voided'), align: 'end', hideBelow: 'lg', cell: (d) => <span className="tabular">{money(d.voidedMad)}</span> },
    { id: 'collected', header: t('revenue.columns.collected'), align: 'end', hideBelow: 'md', cell: (d) => <span className="tabular">{money(d.collectedMad)}</span> },
    { id: 'reversed', header: t('revenue.columns.reversed'), align: 'end', hideBelow: 'lg', cell: (d) => <span className="tabular">{money(d.reversedMad)}</span> },
    { id: 'net', header: t('revenue.columns.net'), align: 'end', cell: (d) => <span className="tabular font-medium">{money(d.netMad)}</span> },
  ];

  return (
    <>
      {header}
      <MetricStrip
        label={t('revenue.totalsLabel', { month: monthLabel })}
        metrics={[
          { id: 'invoiced', label: t('revenue.columns.invoiced'), value: money(sum(days, (d) => d.invoicedMad)), hint: t('revenue.invoicesCount', { count: days.reduce((n, d) => n + d.invoicesIssued, 0) }) },
          { id: 'voided', label: t('revenue.columns.voided'), value: money(sum(days, (d) => d.voidedMad)) },
          { id: 'collected', label: t('revenue.columns.collected'), value: money(sum(days, (d) => d.collectedMad)), hint: t('revenue.paymentsCount', { count: days.reduce((n, d) => n + d.paymentsCount, 0) }) },
          { id: 'reversed', label: t('revenue.columns.reversed'), value: money(sum(days, (d) => d.reversedMad)) },
          { id: 'net', label: t('revenue.columns.net'), value: money(sum(days, (d) => d.netMad)), tone: 'success' },
        ]}
      />
      {byMethod.length > 0 ? (
        <Section id="methods" title={t('revenue.byMethod')}>
          <ul className="flex flex-wrap gap-2">
            {byMethod.map((m) => (
              <li key={m.method} className="rounded-md border border-line bg-surface px-3 py-2 text-body">
                <span className="text-ink-muted">{t(`billing.methods.${m.method}`)}</span>{' '}
                <span className="tabular font-medium">{money(centsToDecimal(m.cents))}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section id="days" title={t('revenue.perDay')} description={t('revenue.definition')}>
        <DataTable
          caption={t('revenue.perDay')}
          columns={columns}
          rows={active}
          getRowId={(d) => d.day}
          empty={<EmptyState icon={Wallet} title={t('revenue.empty')} />}
        />
      </Section>
    </>
  );
}
