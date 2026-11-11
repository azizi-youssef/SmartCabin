'use client';

import {
  Building2,
  CalendarClock,
  CalendarDays,
  ClipboardList,
  LayoutDashboard,
  ListChecks,
  Menu,
  Palette,
  Settings,
  Stethoscope,
  UserCog,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useState, type ReactNode } from 'react';

import { Link, usePathname } from '@/i18n/navigation';
import { cn } from '@/shared/lib/cn';

const ICONS = {
  dashboard: LayoutDashboard,
  reception: ClipboardList,
  doctor: Stethoscope,
  patients: Users,
  clinics: Building2,
  portal: CalendarDays,
  design: Palette,
  team: UserCog,
  settings: Settings,
  services: ListChecks,
  schedules: CalendarClock,
} satisfies Record<string, LucideIcon>;

export type NavIcon = keyof typeof ICONS;

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** Exact match only (e.g. the dashboard root). */
  exact?: boolean;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

interface AppShellProps {
  brand: ReactNode;
  groups: NavGroup[];
  navLabel: string;
  /** Contents of the top bar (clinic, date, language, account). */
  topbar: ReactNode;
  /** Bottom of the navigation rail (signed-in identity). */
  sidebarFooter?: ReactNode;
  /** Workspace-wide notice under the top bar (e.g. clinic suspended). */
  banner?: ReactNode;
  labels: { openMenu: string; closeMenu: string };
  children: ReactNode;
}

/**
 * Application frame: navy navigation rail (inline-start), white top bar, canvas content area.
 * Desktop ≥ 1024px: fixed rail. Below: the rail becomes a drawer opened from the top bar.
 * Direction-aware: the rail sits on the right in Arabic.
 */
export function AppShell({ brand, groups, navLabel, topbar, sidebarFooter, banner, labels, children }: AppShellProps) {
  const pathname = usePathname();
  // The drawer remembers the page it was opened on, so navigating closes it (no effect needed).
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const open = openedOn === pathname;
  const setOpen = (next: boolean) => setOpenedOn(next ? pathname : null);

  const rail = (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center border-b border-nav-line px-4">{brand}</div>
      <nav aria-label={navLabel} className="flex-1 overflow-y-auto px-2 py-3">
        {groups.map((group, gi) => (
          <div key={gi} className="mb-4 last:mb-0">
            {group.label ? (
              <p className="px-2 pb-1.5 text-caption font-medium uppercase tracking-wide text-nav-ink/70 [:lang(ar)_&]:normal-case [:lang(ar)_&]:tracking-normal">
                {group.label}
              </p>
            ) : null}
            <ul className="grid gap-0.5">
              {group.items.map((item) => {
                const Icon = ICONS[item.icon];
                const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'focus-ring relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-body text-nav-ink transition-colors hover:bg-nav-hover hover:text-nav-ink-active',
                        active && 'bg-nav-active font-medium text-nav-ink-active',
                      )}
                    >
                      {active ? <span aria-hidden className="absolute inset-y-1.5 start-0 w-0.5 rounded-full bg-[var(--sc-teal-500)]" /> : null}
                      <Icon aria-hidden className="size-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      {sidebarFooter ? <div className="shrink-0 border-t border-nav-line px-4 py-3">{sidebarFooter}</div> : null}
    </div>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-dvh bg-nav lg:block">{rail}</aside>

      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-overlay lg:hidden" />
          <DialogPrimitive.Content className="fixed inset-y-0 start-0 z-50 w-72 max-w-[85vw] bg-nav shadow-dialog lg:hidden">
            <DialogPrimitive.Title className="sr-only">{navLabel}</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">{navLabel}</DialogPrimitive.Description>
            <DialogPrimitive.Close
              aria-label={labels.closeMenu}
              className="focus-ring absolute end-2 top-3 z-10 rounded-md p-1.5 text-nav-ink hover:bg-nav-hover hover:text-white"
            >
              <X aria-hidden className="size-4" />
            </DialogPrimitive.Close>
            {rail}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-surface px-3 sm:px-4 lg:px-6">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={labels.openMenu}
            className="focus-ring -ms-1 rounded-md p-2 text-ink-muted hover:bg-surface-sunken hover:text-ink lg:hidden"
          >
            <Menu aria-hidden className="size-5" />
          </button>
          {topbar}
        </header>
        {banner}
        <main id="main" tabIndex={-1} className="flex-1 px-4 py-5 outline-none sm:px-6 lg:py-6">
          <div className="mx-auto grid w-full max-w-[96rem] gap-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
