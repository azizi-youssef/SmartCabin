import { AlertTriangle, CheckCircle2, Info, PlugZap, XCircle, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/shared/lib/cn';

/**
 * Empty / error / unavailable states. Compact and aligned with the content they replace:
 * they explain what is happening and offer the next useful action. No illustrations.
 */
interface StateProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

function StateBlock({
  icon: Icon,
  iconClassName,
  title,
  description,
  action,
  className,
  role,
}: StateProps & { icon: LucideIcon; iconClassName: string; role?: 'status' | 'alert' }) {
  return (
    <div role={role} className={cn('flex items-start gap-3 px-4 py-6 sm:px-5', className)}>
      <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md', iconClassName)}>
        <Icon aria-hidden className="size-4" />
      </span>
      <div className="grid min-w-0 gap-1">
        <p className="text-body font-medium text-ink">{title}</p>
        {description ? <div className="max-w-prose text-small text-ink-muted">{description}</div> : null}
        {action ? <div className="mt-2 flex flex-wrap gap-2">{action}</div> : null}
      </div>
    </div>
  );
}

export function EmptyState({ icon = Info, ...props }: StateProps & { icon?: LucideIcon }) {
  return <StateBlock icon={icon} iconClassName="bg-surface-sunken text-ink-muted" role="status" {...props} />;
}

export function ErrorState(props: StateProps) {
  return <StateBlock icon={XCircle} iconClassName="bg-danger-bg text-danger" role="alert" {...props} />;
}

/** Backend not configured or unreachable: say so plainly; never show placeholder figures. */
export function UnavailableState(props: StateProps) {
  return <StateBlock icon={PlugZap} iconClassName="bg-warning-bg text-warning" role="status" {...props} />;
}

const alertTones = {
  info: { icon: Info, className: 'border-info-line bg-info-bg text-info' },
  success: { icon: CheckCircle2, className: 'border-success-line bg-success-bg text-success' },
  warning: { icon: AlertTriangle, className: 'border-warning-line bg-warning-bg text-warning' },
  danger: { icon: XCircle, className: 'border-danger-line bg-danger-bg text-danger' },
} as const;

export function InlineAlert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: keyof typeof alertTones;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const { icon: Icon, className: toneClass } = alertTones[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex gap-2.5 rounded-md border px-3 py-2.5 text-small', toneClass, className)}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="grid gap-0.5">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="text-ink">{children}</div> : null}
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn('block animate-pulse rounded-sm bg-surface-sunken', className)} />;
}
