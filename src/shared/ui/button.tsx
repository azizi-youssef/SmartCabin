import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ButtonHTMLAttributes } from 'react';

import { cn } from '@/shared/lib/cn';

import { Spinner } from './spinner';

export const buttonVariants = cva(
  'focus-ring inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        /** Main action of a page or dialog. One per area. */
        primary: 'bg-primary text-primary-fg hover:bg-primary-hover',
        /** Everyday actions. */
        secondary: 'border border-line-strong bg-surface text-ink hover:bg-surface-sunken',
        /** Low-emphasis actions in dense areas (table rows, toolbars). */
        ghost: 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
        /** Irreversible or destructive actions, always behind a confirmation. */
        danger: 'bg-danger text-white hover:bg-danger/90',
        'danger-outline': 'border border-danger-line bg-surface text-danger hover:bg-danger-bg',
        link: 'h-auto rounded-sm px-0 text-accent underline-offset-4 hover:text-accent-hover hover:underline',
      },
      size: {
        sm: 'h-8 px-2.5 text-small',
        md: 'h-9 px-3.5 text-body',
        lg: 'h-10 px-4 text-body',
        icon: 'size-9',
        'icon-sm': 'size-8',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Render the child element (e.g. a Link) with button styles. */
  asChild?: boolean;
  /** Shows a spinner and disables the button while an action runs. */
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  children,
  type,
  ...props
}: ButtonProps) {
  if (asChild) {
    return (
      <Slot.Root className={cn(buttonVariants({ variant, size }), className)} {...props}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      type={type ?? 'button'}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner className="size-4" /> : null}
      {children}
    </button>
  );
}
