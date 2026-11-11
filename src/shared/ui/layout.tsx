import type { ReactNode } from 'react';

import { cn } from '@/shared/lib/cn';

/** Page title row: title + context on the start side, page actions on the end side. */
export function PageHeader({
  title,
  description,
  meta,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('flex flex-wrap items-end justify-between gap-x-6 gap-y-3', className)}>
      <div className="grid min-w-0 gap-1">
        {meta ? <div className="text-small text-ink-muted">{meta}</div> : null}
        <h1 className="text-title text-ink">{title}</h1>
        {description ? <p className="max-w-prose text-body text-ink-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/**
 * Flat content section (title + optional actions), separated by space rather than cards.
 * Use one bordered surface per data region (table, list), not per heading.
 */
export function Section({
  title,
  description,
  actions,
  children,
  className,
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section aria-labelledby={headingId} className={cn('grid gap-3', className)}>
      {title || actions ? (
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="grid gap-0.5">
            {title ? (
              <h2 id={headingId} className="text-heading text-ink">
                {title}
              </h2>
            ) : null}
            {description ? <p className="text-small text-ink-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export interface Metric {
  id: string;
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}

const metricTone = {
  default: 'text-ink',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
} as const;

/**
 * Key figures as one segmented strip (not a grid of cards). Values come from the database;
 * a metric with no data shows "—", never an invented number.
 */
export function MetricStrip({ metrics, label }: { metrics: Metric[]; label: string }) {
  return (
    <dl
      aria-label={label}
      className="grid grid-cols-2 overflow-hidden rounded-lg border border-line bg-surface sm:grid-cols-3 xl:auto-cols-fr xl:grid-flow-col xl:grid-cols-none"
    >
      {metrics.map((m) => (
        // Each cell draws its bottom and end borders; the 1px overhang is clipped at the frame,
        // so wrapped rows never produce double lines.
        <div key={m.id} className="-mb-px -me-px grid content-start gap-1 border-b border-e border-line px-4 py-3">
          <dt className="text-small text-ink-muted">{m.label}</dt>
          <dd className={cn('tabular text-display', metricTone[m.tone ?? 'default'])}>{m.value}</dd>
          {m.hint ? <dd className="text-caption text-ink-subtle">{m.hint}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

/** Two-line definition list for detail panels. */
export function DetailList({ items }: { items: Array<{ label: ReactNode; value: ReactNode }> }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[minmax(8rem,auto)_1fr]">
      {items.map((item, i) => (
        <div key={i} className="contents">
          <dt className="text-small text-ink-muted">{item.label}</dt>
          <dd className="text-body text-ink">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join('');
  return (
    <span
      aria-hidden
      className={cn('inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-caption font-semibold text-accent-hover', className)}
    >
      {letters}
    </span>
  );
}
