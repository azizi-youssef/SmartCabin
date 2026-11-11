import { cn } from '@/shared/lib/cn';

/**
 * Wordmark: a plain medical cross in a rounded square + name. Text, not an image,
 * so it stays crisp and correct in both directions.
 */
export function Brand({ inverse = false, className }: { inverse?: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <svg aria-hidden viewBox="0 0 24 24" className="size-6 shrink-0">
        <rect width="24" height="24" rx="6" fill={inverse ? 'var(--sc-teal-500)' : 'var(--sc-navy-900)'} />
        <path d="M10 6h4v4h4v4h-4v4h-4v-4H6v-4h4z" fill="#fff" />
      </svg>
      <span dir="ltr" className={cn('text-heading font-semibold tracking-tight', inverse ? 'text-white' : 'text-ink')}>
        SmartCabin
      </span>
    </span>
  );
}
