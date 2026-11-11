import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { APPOINTMENT_STATUSES } from '@/modules/appointments/domain/status';
import { AppointmentStatusBadge } from '@/modules/appointments/ui/status-badge';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { CellStack, DataTable, TableSkeleton, type Column } from '@/shared/ui/data-table';
import { Field, FieldGrid } from '@/shared/ui/field';
import { Checkbox, Input, Select, Textarea } from '@/shared/ui/form-controls';
import { MetricStrip, PageHeader, Section } from '@/shared/ui/layout';
import { EmptyState, ErrorState, InlineAlert, UnavailableState } from '@/shared/ui/states';

import { Brand } from '../_components/brand';
import { LocaleSwitcher } from '../_components/topbar';
import { DialogDemos } from './gallery-client';

export const metadata = { robots: { index: false } };

const SWATCHES = [
  ['canvas', 'bg-canvas'],
  ['surface', 'bg-surface'],
  ['surface-sunken', 'bg-surface-sunken'],
  ['line', 'bg-line'],
  ['ink', 'bg-ink'],
  ['ink-muted', 'bg-ink-muted'],
  ['primary (navy)', 'bg-primary'],
  ['nav', 'bg-nav'],
  ['accent (teal)', 'bg-accent'],
  ['accent-soft', 'bg-accent-soft'],
  ['success', 'bg-success'],
  ['warning', 'bg-warning'],
  ['danger', 'bg-danger'],
  ['info', 'bg-info'],
] as const;

/**
 * Development-only component gallery (404 in production). Content here is illustrative and
 * labeled as such; it never appears in the product.
 */
export default async function DesignSystemPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  const t = await getTranslations();
  const sampleRows = [1, 2, 3].map((n) => ({ id: String(n), name: t('designSystem.sampleName', { n }), file: `P00000${n}`, time: `${String(8 + n).padStart(2, '0')}:00` }));
  const columns: Column<(typeof sampleRows)[number]>[] = [
    { id: 'time', header: t('columns.time'), className: 'w-20', cell: (r) => <span className="tabular font-medium">{r.time}</span> },
    { id: 'patient', header: t('columns.patient'), cell: (r) => <CellStack primary={r.name} secondary={r.file} /> },
    { id: 'service', header: t('columns.service'), hideBelow: 'md', cell: () => t('designSystem.sampleService') },
    { id: 'status', header: t('columns.status'), cell: (r) => <AppointmentStatusBadge status={r.id === '1' ? 'confirmed' : r.id === '2' ? 'pending' : 'completed'} /> },
    { id: 'actions', header: <span className="sr-only">{t('columns.actions')}</span>, align: 'end', className: 'w-px', cell: () => <Button size="sm">{t('reception.confirm')}</Button> },
  ];

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-surface px-4 sm:px-6">
        <Brand />
        <LocaleSwitcher />
      </header>
      <main id="main" className="mx-auto grid max-w-6xl gap-10 px-4 py-8 sm:px-6">
        <PageHeader title={t('designSystem.title')} description={t('designSystem.intro')} />

        <Section id="colors" title={t('designSystem.colors')}>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            {SWATCHES.map(([name, cls]) => (
              <li key={name} className="grid gap-1.5">
                <span className={`h-12 rounded-md border border-line ${cls}`} />
                <span className="font-mono text-caption text-ink-muted" dir="ltr">{name}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section id="type" title={t('designSystem.typography')}>
          <div className="grid gap-3 rounded-lg border border-line bg-surface p-5">
            <p className="text-display tabular">1 284</p>
            <p className="text-caption text-ink-muted">display · 24/32 · {t('designSystem.typeDisplay')}</p>
            <p className="text-title">{t('designSystem.typeTitle')}</p>
            <p className="text-heading">{t('designSystem.typeHeading')}</p>
            <p className="text-body">{t('designSystem.sampleText')} — {t('designSystem.typeBody')}</p>
            <p className="text-small text-ink-muted">{t('designSystem.typeSmall')}</p>
            <p className="text-caption text-ink-muted">{t('designSystem.typeCaption')}</p>
          </div>
        </Section>

        <Section id="buttons" title={t('designSystem.buttons')}>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary">{t('reception.newAppointment')}</Button>
            <Button>{t('reception.reschedule')}</Button>
            <Button variant="ghost">{t('common.back')}</Button>
            <Button variant="danger">{t('reception.cancel')}</Button>
            <Button variant="danger-outline">{t('reception.noShow')}</Button>
            <Button variant="link">{t('dashboard.openReception')}</Button>
            <Button variant="primary" loading>{t('common.loading')}</Button>
            <Button disabled>{t('reception.confirm')}</Button>
            <Button size="sm">{t('reception.confirm')}</Button>
          </div>
        </Section>

        <Section id="forms" title={t('designSystem.forms')}>
          <div className="grid gap-4 rounded-lg border border-line bg-surface p-5">
            <FieldGrid>
              <Field id="ds-name" label={t('patients.form.lastName')} required>
                <Input defaultValue={t('designSystem.sampleName', { n: 1 })} />
              </Field>
              <Field id="ds-phone" label={t('patients.form.phone')} hint={t('patients.form.phoneHint')}>
                <Input dir="ltr" className="text-start" placeholder="06 12 34 56 78" />
              </Field>
              <Field id="ds-error" label={t('patients.form.dateOfBirth')} error={t('patients.form.errors.invalidDate')}>
                <Input type="date" />
              </Field>
              <Field id="ds-select" label={t('booking.doctor')} optionalLabel={t('common.optional')}>
                <Select defaultValue="">
                  <option value="">{t('common.selectPlaceholder')}</option>
                  <option>{t('designSystem.sampleDoctor')}</option>
                </Select>
              </Field>
              <Field id="ds-note" label={t('reception.cancelNote')} className="sm:col-span-2">
                <Textarea rows={2} />
              </Field>
            </FieldGrid>
            <Checkbox label={t('patients.form.consentSms')} />
          </div>
        </Section>

        <Section id="statuses" title={t('designSystem.statuses')}>
          <div className="flex flex-wrap gap-2">
            {APPOINTMENT_STATUSES.map((s) => (
              <AppointmentStatusBadge key={s} status={s} />
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge tone="warning" dot>{t('clinicStatus.pending_approval')}</Badge>
            <Badge tone="success" dot>{t('clinicStatus.active')}</Badge>
            <Badge tone="danger" dot>{t('clinicStatus.suspended')}</Badge>
            <Badge dot>{t('clinicStatus.closed')}</Badge>
            <Badge tone="warning">{t('reception.overbooked')}</Badge>
          </div>
        </Section>

        <Section id="table" title={t('designSystem.table')}>
          <MetricStrip
            label={t('dashboard.metricsLabel')}
            metrics={[
              { id: 'a', label: t('dashboard.total'), value: '—' },
              { id: 'b', label: t('dashboard.upcoming'), value: '—' },
              { id: 'c', label: t('dashboard.completed'), value: '—', tone: 'success' },
              { id: 'd', label: t('dashboard.noShowRate'), value: '—', hint: t('dashboard.noShowRateHint') },
            ]}
          />
          <DataTable caption={t('designSystem.table')} columns={columns} rows={sampleRows} getRowId={(r) => r.id} footer={<span>{t('reception.count', { count: 3 })}</span>} />
          <TableSkeleton label={t('common.loading')} rows={3} />
        </Section>

        <Section id="states" title={t('designSystem.states')}>
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="rounded-lg border border-line bg-surface"><EmptyState title={t('designSystem.emptySample')} description={t('designSystem.emptySampleHint')} action={<Button size="sm">{t('reception.newAppointment')}</Button>} /></div>
            <div className="rounded-lg border border-line bg-surface"><ErrorState title={t('designSystem.errorSample')} description={t('errors.INTERNAL')} action={<Button size="sm">{t('common.retry')}</Button>} /></div>
            <div className="rounded-lg border border-line bg-surface"><UnavailableState title={t('states.unavailableTitle')} description={t('states.unavailableBody')} /></div>
          </div>
          <div className="grid gap-2">
            <InlineAlert tone="info">{t('reception.queueNote')}</InlineAlert>
            <InlineAlert tone="success">{t('reception.bookDone')}</InlineAlert>
            <InlineAlert tone="warning">{t('shell.pendingApproval')}</InlineAlert>
            <InlineAlert tone="danger">{t('errors.SLOT_UNAVAILABLE')}</InlineAlert>
          </div>
        </Section>

        <Section id="dialogs" title={t('designSystem.dialogs')}>
          <DialogDemos />
        </Section>
      </main>
    </div>
  );
}
