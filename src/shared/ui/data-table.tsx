import type { ReactNode } from 'react';

import { cn } from '@/shared/lib/cn';

import { Skeleton } from './states';

export interface Column<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Logical alignment (start/end), so columns mirror in RTL. Numbers and times: end or start consistently. */
  align?: 'start' | 'end' | 'center';
  /** e.g. "w-24"; leave one column flexible. */
  className?: string;
  /** Hide on narrow screens (secondary information only). */
  hideBelow?: 'sm' | 'md' | 'lg';
}

const alignClass = { start: 'text-start', end: 'text-end', center: 'text-center' } as const;
const hideClass = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' } as const;

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  /** Accessible name of the table (visually hidden). */
  caption: string;
  /** Rendered instead of the body when there are no rows. */
  empty?: ReactNode;
  rowClassName?: (row: T) => string | undefined;
  /** Toolbar rendered above the table, inside the frame. */
  toolbar?: ReactNode;
  /** Footer (pagination, totals) rendered below the table, inside the frame. */
  footer?: ReactNode;
  className?: string;
}

/**
 * Dense operational table: 40px rows, sticky header, horizontal scroll on small screens,
 * logical alignment for RTL. Server-component friendly (no client state).
 */
export function DataTable<T>({
  columns,
  rows,
  getRowId,
  caption,
  empty,
  rowClassName,
  toolbar,
  footer,
  className,
}: DataTableProps<T>) {
  return (
    <TableFrame className={className} toolbar={toolbar} footer={footer}>
      {rows.length === 0 && empty ? (
        empty
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-body">
            <caption className="sr-only">{caption}</caption>
            <thead className="sticky top-0 z-10 bg-surface-muted">
              <tr className="border-b border-line">
                {columns.map((col) => (
                  <th
                    key={col.id}
                    scope="col"
                    className={cn(
                      'h-9 whitespace-nowrap px-3 text-caption font-medium text-ink-muted',
                      alignClass[col.align ?? 'start'],
                      col.hideBelow && hideClass[col.hideBelow],
                      col.className,
                    )}
                  >
                    {col.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={getRowId(row)}
                  className={cn('border-b border-line last:border-b-0 hover:bg-surface-muted', rowClassName?.(row))}
                >
                  {columns.map((col) => (
                    <td
                      key={col.id}
                      className={cn(
                        'h-10 px-3 py-1.5 align-middle',
                        alignClass[col.align ?? 'start'],
                        col.hideBelow && hideClass[col.hideBelow],
                        col.className,
                      )}
                    >
                      {col.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </TableFrame>
  );
}

export function TableFrame({
  children,
  toolbar,
  footer,
  className,
}: {
  children: ReactNode;
  toolbar?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('overflow-hidden rounded-lg border border-line bg-surface', className)}>
      {toolbar ? <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">{toolbar}</div> : null}
      {children}
      {footer ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2 text-small text-ink-muted">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

/** Loading placeholder with the same geometry as the table it replaces (no layout shift). */
export function TableSkeleton({ columns = 5, rows = 6, label }: { columns?: number; rows?: number; label: string }) {
  return (
    <TableFrame>
      <div role="status" aria-label={label} className="divide-y divide-line">
        <div className="flex h-9 items-center gap-6 bg-surface-muted px-3">
          {Array.from({ length: columns }, (_, i) => (
            <Skeleton key={i} className="h-2.5 w-16" />
          ))}
        </div>
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex h-10 items-center gap-6 px-3">
            {Array.from({ length: columns }, (_, c) => (
              <Skeleton key={c} className={cn('h-3', c === 1 ? 'w-40' : 'w-16')} />
            ))}
          </div>
        ))}
      </div>
    </TableFrame>
  );
}

/** Secondary line under a primary cell value (e.g. file number under a patient name). */
export function CellStack({ primary, secondary }: { primary: ReactNode; secondary?: ReactNode }) {
  return (
    <div className="grid min-w-0 leading-tight">
      <span className="truncate font-medium text-ink">{primary}</span>
      {secondary ? <span className="truncate text-small text-ink-muted">{secondary}</span> : null}
    </div>
  );
}
