import { Check } from 'lucide-react';

import { cn } from '@/shared/lib/cn';

import { PROGRESS_STEPS, stepStates, type ProgressStep, type StepState } from '../progress';

/**
 * Five-step tracker (requested → confirmed → arrived → with the doctor → done). The state of
 * each step is carried by its icon, its text weight and a screen-reader word, not by color alone.
 * Logical positioning, so it reads right to left in Arabic.
 */
export function AppointmentProgress({ current, label, steps, states, hint }: {
  current: number;
  label: string;
  steps: Record<ProgressStep, string>;
  states: Record<StepState, string>;
  hint?: string;
}) {
  const list = stepStates(current);
  return (
    <div className="grid gap-2">
      <ol aria-label={label} className="grid grid-cols-5">
        {PROGRESS_STEPS.map((step, i) => {
          const state = list[i]!;
          return (
            <li key={step} aria-current={state === 'current' ? 'step' : undefined} className="relative grid justify-items-center gap-1.5 text-center">
              {i > 0 ? (
                <span
                  aria-hidden
                  className={cn('absolute top-2 -start-1/2 h-0.5 w-full', list[i - 1] === 'done' && state !== 'todo' ? 'bg-accent' : 'bg-line-strong')}
                />
              ) : null}
              <span
                aria-hidden
                className={cn(
                  'relative z-10 flex size-4.5 items-center justify-center rounded-full border-2',
                  state === 'done' && 'border-accent bg-accent text-white',
                  state === 'current' && 'border-accent bg-surface ring-4 ring-accent-soft',
                  state === 'todo' && 'border-line-strong bg-surface',
                )}
              >
                {state === 'done' ? <Check className="size-3" strokeWidth={3} /> : state === 'current' ? <span className="size-2 rounded-full bg-accent" /> : null}
              </span>
              <span className={cn('px-0.5 text-caption leading-tight', state === 'current' ? 'font-medium text-ink' : state === 'done' ? 'text-ink-muted' : 'text-ink-subtle')}>
                {steps[step]}
                <span className="sr-only"> ({states[state]})</span>
              </span>
            </li>
          );
        })}
      </ol>
      {hint ? <p className="text-small text-ink-muted">{hint}</p> : null}
    </div>
  );
}
