'use client';

import { CheckCircle2, X, XCircle } from 'lucide-react';
import { Toast as ToastPrimitive } from 'radix-ui';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { cn } from '@/shared/lib/cn';

type ToastTone = 'success' | 'danger';
interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string | undefined;
}

const ToastContext = createContext<((toast: Omit<ToastItem, 'id'>) => void) | null>(null);

/** Short confirmation after an action (announced politely to screen readers). */
export function useToast() {
  const push = useContext(ToastContext);
  if (!push) throw new Error('useToast must be used inside <ToastProvider>');
  return push;
}

export function ToastProvider({ children, closeLabel }: { children: ReactNode; closeLabel: string }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((toast: Omit<ToastItem, 'id'>) => {
    setItems((current) => [...current.slice(-2), { ...toast, id: Date.now() + Math.random() }]);
  }, []);
  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      <ToastPrimitive.Provider duration={5000} swipeDirection="down">
        {children}
        {items.map((item) => {
          const Icon = item.tone === 'success' ? CheckCircle2 : XCircle;
          return (
            <ToastPrimitive.Root
              key={item.id}
              type={item.tone === 'danger' ? 'foreground' : 'background'}
              onOpenChange={(open) => {
                if (!open) setItems((current) => current.filter((t) => t.id !== item.id));
              }}
              className="flex items-start gap-3 rounded-md border border-line bg-surface p-3 shadow-popover"
            >
              <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', item.tone === 'success' ? 'text-success' : 'text-danger')} />
              <div className="grid flex-1 gap-0.5">
                <ToastPrimitive.Title className="text-body font-medium text-ink">{item.title}</ToastPrimitive.Title>
                {item.description ? (
                  <ToastPrimitive.Description className="text-small text-ink-muted">{item.description}</ToastPrimitive.Description>
                ) : null}
              </div>
              <ToastPrimitive.Close aria-label={closeLabel} className="focus-ring rounded-sm p-0.5 text-ink-subtle hover:text-ink">
                <X aria-hidden className="size-4" />
              </ToastPrimitive.Close>
            </ToastPrimitive.Root>
          );
        })}
        <ToastPrimitive.Viewport className="fixed bottom-4 end-4 z-[60] grid w-[min(24rem,calc(100vw-2rem))] gap-2 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}
