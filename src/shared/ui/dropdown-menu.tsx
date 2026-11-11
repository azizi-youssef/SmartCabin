'use client';

import { DropdownMenu as MenuPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '@/shared/lib/cn';

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;

export function DropdownMenuContent({ className, align = 'end', sideOffset = 4, ...props }: ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn('z-50 min-w-44 rounded-md border border-line bg-surface p-1 text-body shadow-popover', className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  tone = 'default',
  ...props
}: ComponentProps<typeof MenuPrimitive.Item> & { tone?: 'default' | 'danger' }) {
  return (
    <MenuPrimitive.Item
      className={cn(
        'flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 outline-none [&_svg]:size-4 [&_svg]:text-ink-subtle',
        'data-[highlighted]:bg-surface-sunken data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        tone === 'danger' && 'text-danger [&_svg]:text-danger',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cn('px-2 py-1.5 text-caption text-ink-subtle', className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-line', className)} {...props} />;
}
