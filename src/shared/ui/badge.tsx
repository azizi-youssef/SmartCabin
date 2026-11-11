import { cva, type VariantProps } from 'class-variance-authority';
import type { ReactNode } from 'react';

import { cn } from '@/shared/lib/cn';

export const badgeVariants = cva(
  'inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-caption font-medium',
  {
    variants: {
      tone: {
        neutral: 'border-neutral-status-line bg-neutral-status-bg text-neutral-status',
        info: 'border-info-line bg-info-bg text-info',
        success: 'border-success-line bg-success-bg text-success',
        warning: 'border-warning-line bg-warning-bg text-warning',
        danger: 'border-danger-line bg-danger-bg text-danger',
        accent: 'border-accent-line bg-accent-soft text-accent-hover',
        navy: 'border-transparent bg-primary text-primary-fg',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

/**
 * Status label. Always text + color (never color alone); the dot helps scanning in dense tables.
 */
export function Badge({
  tone,
  dot = false,
  className,
  children,
}: {
  tone?: BadgeTone;
  dot?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={cn(badgeVariants({ tone }), className)}>
      {dot ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}
