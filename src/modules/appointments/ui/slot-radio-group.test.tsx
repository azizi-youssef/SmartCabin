import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { SlotRadioGroup, type SlotItem } from './slot-radio-group';

const SLOTS: SlotItem[] = [
  { startsAt: '2027-01-04T08:00:00Z' },
  { startsAt: '2027-01-04T08:20:00Z' },
  { startsAt: '2027-01-04T08:40:00Z' },
  { startsAt: '2027-01-04T09:00:00Z' },
];

function Harness({ dir, initial = null }: { dir: 'ltr' | 'rtl'; initial?: string | null }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <>
      <button type="button">before</button>
      <SlotRadioGroup slots={SLOTS} value={value} onChange={(s) => setValue(s?.startsAt ?? null)} label="Créneaux" locale="fr" timeZone="UTC" dir={dir} />
      <output data-testid="value">{value ?? 'none'}</output>
    </>
  );
}

const radios = () => screen.getAllByRole('radio');

describe('SlotRadioGroup (WAI-ARIA radio group, audit SC-AUD-16)', () => {
  it('is a single Tab stop: the first slot, or the selected one', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness dir="ltr" />);
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1, -1]);
    await user.click(screen.getByRole('button', { name: 'before' }));
    await user.tab();
    expect(radios()[0]).toHaveFocus();
    unmount();

    render(<Harness dir="ltr" initial={SLOTS[2]?.startsAt ?? null} />);
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, -1, 0, -1]);
  });

  it('moves and selects with the arrow keys, Home and End', async () => {
    const user = userEvent.setup();
    render(<Harness dir="ltr" />);
    await user.click(screen.getByRole('button', { name: 'before' }));
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(radios()[1]).toHaveFocus();
    expect(radios()[1]).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('value')).toHaveTextContent(SLOTS[1]?.startsAt ?? '');
    await user.keyboard('{ArrowDown}');
    expect(radios()[2]).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{End}');
    expect(radios()[3]).toHaveFocus();
    await user.keyboard('{ArrowRight}'); // stays on the last slot
    expect(radios()[3]).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{Home}');
    expect(radios()[0]).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowUp}'); // stays on the first slot
    expect(radios()[0]).toHaveFocus();
  });

  it('follows the reading direction in Arabic: ArrowLeft moves to the next slot', async () => {
    const user = userEvent.setup();
    render(<Harness dir="rtl" />);
    await user.click(screen.getByRole('button', { name: 'before' }));
    await user.tab();
    await user.keyboard('{ArrowLeft}');
    expect(radios()[1]).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowRight}');
    expect(radios()[0]).toHaveAttribute('aria-checked', 'true');
  });
});
