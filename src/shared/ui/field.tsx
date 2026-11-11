import { AlertCircle } from 'lucide-react';
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

import { cn } from '@/shared/lib/cn';

import { Label } from './form-controls';

interface FieldProps {
  /** id of the control; label, hint and error are wired to it. */
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  /** Already-localized error message. */
  error?: string | undefined;
  required?: boolean;
  /** Visually marks optional fields instead of required ones (forms with mostly required fields). */
  optionalLabel?: string;
  className?: string;
  children: ReactElement<Record<string, unknown>>;
}

/**
 * Label + control + hint + error, with ARIA wiring (aria-describedby, aria-invalid, aria-required).
 * Errors are shown under the field, in text and icon — never by color alone.
 */
export function Field({ id, label, hint, error, required, optionalLabel, className, children }: FieldProps) {
  // The error replaces the hint, so only reference what is actually rendered.
  const hintId = hint && !error ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const control = Children.only(children);
  const wired = isValidElement(control)
    ? cloneElement(control, {
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        'aria-required': required || undefined,
      })
    : control;

  return (
    <div className={cn('grid content-start gap-1.5', className)}>
      <Label htmlFor={id} className="flex items-baseline gap-1.5">
        <span>{label}</span>
        {required ? (
          <span aria-hidden className="text-danger">
            *
          </span>
        ) : optionalLabel ? (
          <span className="text-caption font-normal text-ink-subtle">{optionalLabel}</span>
        ) : null}
      </Label>
      {wired}
      {hint && !error ? (
        <p id={hintId} className="text-small text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="flex items-center gap-1.5 text-small text-danger" role="alert">
          <AlertCircle aria-hidden className="size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Groups fields in a responsive grid; a form row never exceeds two columns. */
export function FieldGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-4 sm:grid-cols-2', className)}>{children}</div>;
}
