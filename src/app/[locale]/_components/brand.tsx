import Image from 'next/image';

import { cn } from '@/shared/lib/cn';

/**
 * Wordmark: Official SmartCabin logo (`Logo_SmartCabin.png`).
 * Rendered with next/image for crisp display and performance.
 * On inverse (dark) backgrounds (e.g. the navy workspace rail),
 * a subtle light pill ensures legibility and contrast.
 */
export function Brand({
  inverse = false,
  className,
  imageClassName,
}: {
  inverse?: boolean;
  className?: string;
  imageClassName?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <span
        className={cn(
          'inline-flex items-center justify-center overflow-hidden rounded-md transition-colors',
          inverse && 'bg-white/95 px-2 py-0.5 shadow-xs',
        )}
      >
        <Image
          src="/Logo_SmartCabin.png"
          alt="SmartCabin"
          width={1536}
          height={1024}
          priority
          className={cn('h-9 w-auto object-contain', imageClassName)}
        />
      </span>
      <span className="sr-only">SmartCabin</span>
    </span>
  );
}
