import { ChevronDown } from 'lucide-react';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

import { cn } from '@/shared/lib/cn';

/* One control style for inputs, selects and textareas: 36px high, 1px border, teal focus. */
const controlBase =
  'w-full rounded-md border border-line-strong bg-surface text-body text-ink placeholder:text-ink-subtle ' +
  'transition-colors hover:border-ink-subtle focus-visible:border-accent focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-accent-line disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-subtle ' +
  'aria-[invalid=true]:border-danger aria-[invalid=true]:focus-visible:ring-danger-line';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(controlBase, 'h-9 px-3', className)} {...props} />;
}

export function Textarea({ className, rows = 3, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={rows} className={cn(controlBase, 'min-h-20 px-3 py-2', className)} {...props} />;
}

/**
 * Native select: fully accessible, works with keyboard and screen readers, mobile-friendly,
 * and mirrors correctly in RTL (chevron on the inline end).
 */
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select className={cn(controlBase, 'h-9 appearance-none pe-9 ps-3', className)} {...props}>
        {children}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle" />
    </div>
  );
}

export function Checkbox({
  className,
  label,
  description,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode; description?: ReactNode }) {
  return (
    <label className={cn('flex cursor-pointer items-start gap-2.5 text-body text-ink', className)}>
      <input
        type="checkbox"
        className="focus-ring mt-0.5 size-4 shrink-0 cursor-pointer rounded-sm border-line-strong accent-[var(--sc-teal-600)]"
        {...props}
      />
      <span className="grid gap-0.5">
        <span>{label}</span>
        {description ? <span className="text-small text-ink-muted">{description}</span> : null}
      </span>
    </label>
  );
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-small font-medium text-ink', className)} {...props} />;
}
