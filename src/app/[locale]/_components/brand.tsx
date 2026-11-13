import Image from 'next/image';

import { cn } from '@/shared/lib/cn';

// Static imports: the served URL carries a hash of the file, so replacing a file in public/
// shows the new image at once instead of the optimizer's cached copy (kept up to 4 h).
import logo from '../../../../public/Logo_SmartCabin.png';
import mark from '../../../../public/icon.png';

/**
 * Wordmark: the official SmartCabin logo (`public/Logo_SmartCabin.png`, horizontal banner).
 * `iconOnly` shows the square mark (`public/icon.png`). On inverse (dark) backgrounds, such
 * as the navy workspace rail, a light pill keeps the navy lettering legible.
 */
export function Brand({
  inverse = false,
  iconOnly = false,
  className,
  imageClassName,
}: {
  inverse?: boolean;
  iconOnly?: boolean;
  className?: string;
  imageClassName?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <span
        className={cn(
          'inline-flex items-center justify-center overflow-hidden rounded-md transition-colors',
          inverse && 'bg-white/95 px-2 py-1 shadow-xs',
        )}
      >
        {iconOnly ? (
          <Image src={mark} alt="SmartCabin" height={28} priority className={cn('size-7 object-contain', imageClassName)} />
        ) : (
          <Image src={logo} alt="SmartCabin" height={28} priority className={cn('h-7 w-auto object-contain', imageClassName)} />
        )}
      </span>
    </span>
  );
}
