'use client';

import { X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/shared/lib/cn';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const widths = { sm: 'sm:max-w-md', md: 'sm:max-w-xl', lg: 'sm:max-w-3xl' } as const;

/**
 * Modal dialog for focused tasks (forms, details). Header, scrollable body, sticky footer.
 * Bottom sheet on phones, centered panel from `sm` up. Escape and the close button dismiss it.
 */
export function DialogContent({
  title,
  description,
  footer,
  closeLabel,
  size = 'md',
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof DialogPrimitive.Content>, 'title'> & {
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  closeLabel: string;
  size?: keyof typeof widths;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay" />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-lg border border-line bg-surface shadow-dialog',
          // Centering is direction-independent, so physical left/translate are correct in RTL too.
          'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-[8vh] sm:w-[calc(100%-2rem)] sm:-translate-x-1/2 sm:rounded-lg',
          widths[size],
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="grid gap-1">
            <DialogPrimitive.Title className="text-heading text-ink">{title}</DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="text-small text-ink-muted">{description}</DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only">{typeof title === 'string' ? title : ''}</DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close
            className="focus-ring -me-1.5 -mt-1 rounded-md p-1.5 text-ink-subtle hover:bg-surface-sunken hover:text-ink"
            aria-label={closeLabel}
          >
            <X aria-hidden className="size-4" />
          </DialogPrimitive.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-muted px-5 py-3">
            {footer}
          </div>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
