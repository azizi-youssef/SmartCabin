'use client';

import { Direction } from 'radix-ui';
import type { ReactNode } from 'react';

import { ToastProvider } from '@/shared/ui/toast';

/** Client-side providers: Radix direction (menus, dialogs mirror in RTL) and toasts. */
export function Providers({ dir, closeLabel, children }: { dir: 'ltr' | 'rtl'; closeLabel: string; children: ReactNode }) {
  return (
    <Direction.Provider dir={dir}>
      <ToastProvider closeLabel={closeLabel}>{children}</ToastProvider>
    </Direction.Provider>
  );
}
