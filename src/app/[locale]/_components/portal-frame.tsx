import type { ReactNode } from 'react';

import { Brand } from './brand';
import { AccountMenu, LocaleSwitcher } from './topbar';

/** Mobile-first frame for patients: light header, single readable column, large touch targets. */
export function PortalFrame({ identity, children }: { identity: string; children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="sticky top-0 z-30 border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-2 px-4">
          <Brand />
          <div className="ms-auto flex items-center gap-1">
            <LocaleSwitcher />
            <AccountMenu identity={identity} />
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto grid max-w-2xl gap-6 px-4 py-6">
        {children}
      </main>
    </div>
  );
}

/** Centered frame for sign-in and verification screens. */
export function AuthFrame({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="flex h-14 items-center justify-between px-4 sm:px-6">
        <Brand />
        <LocaleSwitcher />
      </header>
      <main id="main" className="flex flex-1 items-start justify-center px-4 pb-12 pt-[8vh]">
        <div className="grid w-full max-w-sm gap-6">
          <div className="rounded-lg border border-line bg-surface p-6">{children}</div>
          {footer ? <div className="text-center text-small">{footer}</div> : null}
        </div>
      </main>
    </div>
  );
}
