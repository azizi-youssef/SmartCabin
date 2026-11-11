import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './confirm-dialog';
import { DataTable, type Column } from './data-table';
import { Field } from './field';
import { Input } from './form-controls';
import { MetricStrip } from './layout';
import { EmptyState } from './states';

describe('Field', () => {
  it('wires label, hint, error and ARIA attributes to the control', () => {
    render(
      <Field id="name" label="Nom" hint="Indice" error="Champ obligatoire." required>
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText(/Nom/);
    expect(input).toHaveAttribute('id', 'name');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-required', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'name-error');
    expect(screen.getByRole('alert')).toHaveTextContent('Champ obligatoire.');
    // The hint is replaced by the error, not stacked under it.
    expect(screen.queryByText('Indice')).not.toBeInTheDocument();
  });
});

describe('DataTable', () => {
  type Row = { id: string; name: string };
  const columns: Column<Row>[] = [
    { id: 'name', header: 'Patient', cell: (r) => r.name },
    { id: 'n', header: 'N°', align: 'end', cell: (r) => r.id },
  ];

  it('renders an accessible table with a caption and logical alignment', () => {
    render(<DataTable caption="Rendez-vous" columns={columns} rows={[{ id: '1', name: 'A' }, { id: '2', name: 'B' }]} getRowId={(r) => r.id} />);
    const table = screen.getByRole('table', { name: 'Rendez-vous' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByRole('columnheader', { name: 'N°' })).toHaveClass('text-end');
  });

  it('renders the empty state instead of an empty table', () => {
    render(<DataTable caption="Rendez-vous" columns={columns} rows={[]} getRowId={(r) => r.id} empty={<EmptyState title="Aucun rendez-vous" />} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Aucun rendez-vous');
  });
});

describe('MetricStrip', () => {
  it('renders labels and values as a description list', () => {
    render(<MetricStrip label="Activité" metrics={[{ id: 'a', label: 'Terminés', value: '4' }, { id: 'b', label: 'Absences', value: '—' }]} />);
    const list = screen.getByLabelText('Activité');
    expect(within(list).getByText('Terminés')).toBeInTheDocument();
    expect(within(list).getByText('—')).toBeInTheDocument();
  });
});

describe('ConfirmDialog', () => {
  function setup(onConfirm: () => Promise<string | void>) {
    render(
      <ConfirmDialog
        trigger={<button type="button">Annuler le rendez-vous</button>}
        title="Annuler ce rendez-vous ?"
        description="Le créneau sera libéré."
        confirmLabel="Confirmer l'annulation"
        cancelLabel="Garder"
        tone="danger"
        onConfirm={onConfirm}
      />,
    );
  }

  it('runs the action and closes on success', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => undefined);
    setup(onConfirm);
    await user.click(screen.getByRole('button', { name: 'Annuler le rendez-vous' }));
    expect(screen.getByRole('alertdialog', { name: 'Annuler ce rendez-vous ?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "Confirmer l'annulation" }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('stays open and shows the error when the action fails', async () => {
    const user = userEvent.setup();
    setup(async () => 'Ce créneau n’est plus disponible.');
    await user.click(screen.getByRole('button', { name: 'Annuler le rendez-vous' }));
    await user.click(screen.getByRole('button', { name: "Confirmer l'annulation" }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Ce créneau n’est plus disponible.');
  });

  it('can be dismissed without acting', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => undefined);
    setup(onConfirm);
    await user.click(screen.getByRole('button', { name: 'Annuler le rendez-vous' }));
    await user.click(screen.getByRole('button', { name: 'Garder' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
