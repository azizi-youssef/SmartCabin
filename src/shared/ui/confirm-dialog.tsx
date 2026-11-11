'use client';

import { AlertDialog as AlertPrimitive } from 'radix-ui';
import { useState, useTransition, type ReactNode } from 'react';

import { cn } from '@/shared/lib/cn';

import { Button } from './button';
import { InlineAlert } from './states';

interface ConfirmDialogProps {
  /** Element that opens the dialog (rendered asChild). */
  trigger: ReactNode;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  tone?: 'default' | 'danger';
  /** Extra inputs (e.g. a reason). The caller owns their state. */
  children?: ReactNode;
  /** Disables confirmation until required inputs are valid. */
  confirmDisabled?: boolean;
  /**
   * Runs the action. Return an error message to keep the dialog open and show it,
   * or nothing to close the dialog.
   */
  onConfirm: () => Promise<string | void>;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Confirmation for consequential actions (cancel, no-show, suspend). States the consequence
 * in the description, names the action on the button ("Annuler le rendez-vous", not "OK"),
 * keeps focus on Cancel by default, and stays open with the error if the action fails.
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = 'default',
  children,
  confirmDisabled,
  onConfirm,
  onOpenChange,
}: ConfirmDialogProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function change(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (!next) setError(null);
    onOpenChange?.(next);
  }

  function confirm() {
    setError(null);
    startTransition(async () => {
      const failure = await onConfirm();
      if (failure) {
        setError(failure);
        return;
      }
      setOpen(false);
      onOpenChange?.(false);
    });
  }

  return (
    <AlertPrimitive.Root open={open} onOpenChange={change}>
      <AlertPrimitive.Trigger asChild>{trigger}</AlertPrimitive.Trigger>
      <AlertPrimitive.Portal>
        <AlertPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <AlertPrimitive.Content
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 grid gap-4 rounded-t-lg border border-line bg-surface p-5 shadow-dialog',
            'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-[18vh] sm:w-[calc(100%-2rem)] sm:max-w-md sm:-translate-x-1/2 sm:rounded-lg',
          )}
        >
          <div className="grid gap-1.5">
            <AlertPrimitive.Title className="text-heading text-ink">{title}</AlertPrimitive.Title>
            <AlertPrimitive.Description className="text-body text-ink-muted">{description}</AlertPrimitive.Description>
          </div>
          {children ? <div className="grid gap-4">{children}</div> : null}
          {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <AlertPrimitive.Cancel asChild>
              <Button variant="secondary" disabled={pending}>
                {cancelLabel}
              </Button>
            </AlertPrimitive.Cancel>
            {/* Not AlertPrimitive.Action: it would close the dialog before the action completes. */}
            <Button
              variant={tone === 'danger' ? 'danger' : 'primary'}
              loading={pending}
              disabled={confirmDisabled}
              onClick={confirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertPrimitive.Content>
      </AlertPrimitive.Portal>
    </AlertPrimitive.Root>
  );
}
