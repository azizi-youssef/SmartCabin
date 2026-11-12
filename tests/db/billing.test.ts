import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { actAs, asPostgres, asUser, count, createPool, failure, one, withRollback, type Db } from './helpers/db';
import { createWorld, type World } from './helpers/fixtures';

/**
 * Module 10 — billing (migration 0027): drafts from appointments (BR-B-11), gapless numbering at
 * issue (BR-F-01), immutability (BR-F-02), status from payments (BR-F-03), no overpayment
 * (BR-F-04), reversals (BR-F-05), voiding (BR-F-06), receipts (BR-F-07), money rules (BR-F-08),
 * the revenue summary (K7), permissions (RBAC §3.7) and concurrency.
 */
let pool: pg.Pool;
beforeAll(() => {
  pool = createPool(6);
});
afterAll(async () => {
  await pool.end();
});

interface Ref {
  invoice_id: string;
  version: number;
}

async function scenario(fn: (db: Db, w: World) => Promise<void>): Promise<void> {
  await withRollback(pool, async (db) => {
    const w = await createWorld(db);
    await fn(db, w);
  });
}

async function draftFromAppointment(db: Db, w: World, appointment: string, key: string | null = null): Promise<Ref> {
  await actAs(db, asUser(w.users.receptionA));
  return one<Ref>(db, 'select * from public.create_invoice_draft(p_appointment_id => $1, p_idempotency_key => $2)', [appointment, key]);
}

/** A patient-path draft with one line, issued by the receptionist. */
async function issuedInvoice(db: Db, w: World, amount: number, patient = w.patientA2): Promise<Ref & { invoice_number: string }> {
  await actAs(db, asUser(w.users.receptionA));
  const draft = await one<Ref>(db, 'select * from public.create_invoice_draft(p_patient_id => $1)', [patient]);
  const edited = await one<Ref>(db, 'select invoice_id, version from public.update_invoice_draft($1, $2, $3::jsonb)',
    [draft.invoice_id, draft.version, JSON.stringify([{ description: 'Soins', quantity: 1, unit_price_mad: amount }])]);
  return one(db, 'select * from public.issue_invoice($1, $2)', [edited.invoice_id, edited.version]);
}

async function pay(db: Db, invoice: string, amount: number | string, method = 'cash', key: string | null = null, reference: string | null = null) {
  return one<{ payment_id: string; receipt_number: string; invoice_status: string; amount_paid_mad: string; version: number }>(db,
    'select * from public.record_payment($1, $2::numeric, $3::public.payment_method, $4, $5)', [invoice, amount, method, reference, key]);
}

async function invoiceRow(db: Db, id: string) {
  await actAs(db, asPostgres);
  return one<{ status: string; total_mad: string; amount_paid_mad: string; invoice_number: string | null; version: number }>(db,
    'select status::text, total_mad::text, amount_paid_mad::text, invoice_number, version from public.invoices where id = $1', [id]);
}

async function currentYear(db: Db, w: World): Promise<number> {
  await actAs(db, asPostgres);
  return (await one<{ y: number }>(db,
    'select extract(year from now() at time zone c.timezone)::int as y from public.clinics c where c.id = $1', [w.clinicA])).y;
}

describe('drafts (BR-B-11)', () => {
  it('creates a draft from an appointment at its booked price, once per appointment and per idempotency key', async () => {
    await scenario(async (db, w) => {
      const key = 'draft-key-0001';
      const draft = await draftFromAppointment(db, w, w.apptA1, key);
      expect(draft.version).toBe(1);
      await actAs(db, asPostgres);
      expect(await one(db,
        `select i.status::text, i.patient_id, i.bill_to_name, i.total_mad::text, i.invoice_number,
                it.description, it.quantity::text, it.unit_price_mad::text, it.line_total_mad::text, it.service_id
         from public.invoices i join public.invoice_items it on it.invoice_id = i.id where i.id = $1`, [draft.invoice_id]))
        .toEqual({
          status: 'draft', patient_id: w.patientA1, bill_to_name: 'Alice Alpha', total_mad: '200.00', invoice_number: null,
          description: 'Consultation', quantity: '1.00', unit_price_mad: '200.00', line_total_mad: '200.00', service_id: w.serviceA,
        });

      expect((await draftFromAppointment(db, w, w.apptA1, key)).invoice_id).toBe(draft.invoice_id);
      expect((await failure(db, 'select * from public.create_invoice_draft(p_appointment_id => $1, p_idempotency_key => $2)', [w.apptA2, key])).message)
        .toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await failure(db, 'select * from public.create_invoice_draft(p_appointment_id => $1)', [w.apptA1])).message).toBe('DUPLICATE');
      expect((await failure(db, 'select * from public.create_invoice_draft(p_appointment_id => $1, p_patient_id => $2)', [w.apptA2, w.patientA1])).message)
        .toBe('VALIDATION_FAILED');
      expect((await failure(db, 'select * from public.create_invoice_draft()')).message).toBe('VALIDATION_FAILED');

      await db.query("select public.cancel_appointment($1, 'clinic_request')", [w.apptA2]);
      expect((await failure(db, 'select * from public.create_invoice_draft(p_appointment_id => $1)', [w.apptA2])).detail)
        .toBe('appointment not billable');

      const forPatient = await one<Ref>(db, 'select * from public.create_invoice_draft(p_patient_id => $1)', [w.patientA2]);
      expect(await count(db, 'select 1 from public.invoice_items where invoice_id = $1', [forPatient.invoice_id])).toBe(0);
    });
  });

  it('edits lines with totals computed by the database, rounded half-up per line, and discards drafts', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const draft = await one<Ref>(db, 'select * from public.create_invoice_draft(p_patient_id => $1)', [w.patientA2]);
      const items = [
        { service_id: w.serviceA, description: 'Consultation', quantity: 1, unit_price_mad: 200 },
        { description: 'Pansement', quantity: 1.5, unit_price_mad: 33.33 },
      ];
      const edited = await one<{ version: number; total_mad: string }>(db,
        'select * from public.update_invoice_draft($1, $2, $3::jsonb, 10, $4)',
        [draft.invoice_id, draft.version, JSON.stringify(items), 'Note interne']);
      expect(edited).toMatchObject({ version: 2, total_mad: '240.00' });
      expect((await db.query('select line_total_mad::text as t from public.invoice_items where invoice_id = $1 order by position', [draft.invoice_id])).rows)
        .toEqual([{ t: '200.00' }, { t: '50.00' }]); // 1.5 × 33.33 = 49.995 → 50.00

      const update = 'select * from public.update_invoice_draft($1, $2, $3::jsonb, $4::numeric)';
      expect((await failure(db, update, [draft.invoice_id, 1, JSON.stringify(items), 0])).message).toBe('STALE_STATE');
      for (const [badItems, discount] of [
        [items, 300],
        [[{ description: 'X', quantity: 1, unit_price_mad: 10.005 }], 0],
        [[{ description: 'X', quantity: 0, unit_price_mad: 10 }], 0],
        [[{ description: ' ', quantity: 1, unit_price_mad: 10 }], 0],
        [[{ description: 'X', quantity: 'abc', unit_price_mad: 10 }], 0],
        [[{ service_id: w.serviceB, description: 'X', quantity: 1, unit_price_mad: 10 }], 0],
        [Array.from({ length: 51 }, () => ({ description: 'X', quantity: 1, unit_price_mad: 1 })), 0],
        [Array.from({ length: 50 }, () => ({ description: 'X', quantity: 999, unit_price_mad: 1000000 })), 0],
      ] as const) {
        expect((await failure(db, update, [draft.invoice_id, 2, JSON.stringify(badItems), discount])).message).toBe('VALIDATION_FAILED');
      }

      await db.query('select public.discard_invoice_draft($1, 2)', [draft.invoice_id]);
      await actAs(db, asPostgres);
      expect(await count(db, 'select 1 from public.invoices where id = $1', [draft.invoice_id])).toBe(0);
      expect(await count(db, 'select 1 from public.invoice_items where invoice_id = $1', [draft.invoice_id])).toBe(0);
    });
  });
});

describe('issue (BR-F-01, BR-F-02)', () => {
  it('numbers at issue, snapshots clinic and patient, and freezes the invoice for everyone, postgres included', async () => {
    await scenario(async (db, w) => {
      const year = await currentYear(db, w);
      const draft = await draftFromAppointment(db, w, w.apptA1);
      const issued = await one<{ version: number; invoice_number: string }>(db, 'select * from public.issue_invoice($1, $2)', [draft.invoice_id, draft.version]);
      expect(issued).toEqual({ invoice_id: draft.invoice_id, version: 2, invoice_number: `${year}-000001` });
      expect((await issuedInvoice(db, w, 80)).invoice_number).toBe(`${year}-000002`);

      await actAs(db, asPostgres);
      expect(await one(db,
        `select status::text, issued_by, clinic_snapshot ->> 'display_name' as clinic, bill_to_name from public.invoices where id = $1`,
        [draft.invoice_id])).toEqual({ status: 'issued', issued_by: w.users.receptionA, clinic: expect.any(String), bill_to_name: 'Alice Alpha' });
      expect(await count(db, "select 1 from public.domain_events where aggregate_id = $1 and event_type = 'invoice.issued'", [draft.invoice_id])).toBe(1);

      await actAs(db, asUser(w.users.receptionA));
      expect((await failure(db, "select * from public.update_invoice_draft($1, 2, '[]'::jsonb)", [draft.invoice_id])).message).toBe('INVOICE_IMMUTABLE');
      expect((await failure(db, 'select public.discard_invoice_draft($1, 2)', [draft.invoice_id])).message).toBe('INVOICE_IMMUTABLE');
      expect((await failure(db, 'select * from public.issue_invoice($1, 2)', [draft.invoice_id])).message).toBe('INVOICE_INVALID_TRANSITION');
      expect((await failure(db, "insert into public.invoices (clinic_id, patient_id, bill_to_name, created_by) values ($1, $2, 'x', $3)",
        [w.clinicA, w.patientA1, w.users.receptionA])).code).toBe('42501');

      await actAs(db, asPostgres);
      for (const sql of [
        'update public.invoices set total_mad = 1, subtotal_mad = 1 where id = $1',
        "update public.invoices set bill_to_name = 'Someone else' where id = $1",
        "update public.invoices set clinic_snapshot = '{}'::jsonb, notes = 'changed' where id = $1",
        'delete from public.invoices where id = $1',
        "insert into public.invoice_items (clinic_id, invoice_id, description, quantity, unit_price_mad, position) select clinic_id, id, 'x', 1, 1, 9 from public.invoices where id = $1",
        'update public.invoice_items set unit_price_mad = 1 where invoice_id = $1',
        'delete from public.invoice_items where invoice_id = $1',
      ]) {
        expect((await failure(db, sql, [draft.invoice_id])).message, sql).toBe('INVOICE_IMMUTABLE');
      }

      await actAs(db, asUser(w.users.receptionA));
      const empty = await one<Ref>(db, 'select * from public.create_invoice_draft(p_patient_id => $1)', [w.patientA1]);
      expect((await failure(db, 'select * from public.issue_invoice($1, $2)', [empty.invoice_id, empty.version])).detail).toBe('empty invoice');
    });
  });

  it('keeps invoice numbers gapless when desks issue at the same time, a rolled-back issue included', async () => {
    const setup = await pool.connect();
    let w: World;
    const drafts: Ref[] = [];
    try {
      await setup.query('begin');
      w = await createWorld(setup);
      await actAs(setup, asUser(w.users.receptionA));
      for (let i = 0; i < 6; i++) {
        const d = await one<Ref>(setup, 'select * from public.create_invoice_draft(p_patient_id => $1)', [w.patientA2]);
        drafts.push(await one<Ref>(setup, 'select invoice_id, version from public.update_invoice_draft($1, $2, $3::jsonb)',
          [d.invoice_id, d.version, JSON.stringify([{ description: 'Soins', quantity: 1, unit_price_mad: 100 + i }])]));
      }
      await setup.query('commit');
    } catch (error) {
      await setup.query('rollback');
      throw error;
    } finally {
      setup.release();
    }
    const issue = async (draft: Ref, rollback: boolean) => {
      const db = await pool.connect();
      try {
        await db.query('begin');
        await actAs(db, asUser(w.users.receptionA));
        const row = await one<{ invoice_number: string }>(db, 'select * from public.issue_invoice($1, $2)', [draft.invoice_id, draft.version]);
        await db.query(rollback ? 'rollback' : 'commit');
        return rollback ? null : row.invoice_number;
      } finally {
        db.release();
      }
    };
    const numbers = (await Promise.all(drafts.map((d, i) => issue(d, i === 2)))).filter((n): n is string => n !== null);
    const year = await withRollback(pool, (db) => currentYear(db, w));
    expect(numbers.sort()).toEqual([1, 2, 3, 4, 5].map((n) => `${year}-${String(n).padStart(6, '0')}`));
    await withRollback(pool, async (db) => {
      await actAs(db, asPostgres);
      expect(await count(db, "select 1 from public.invoices where clinic_id = $1 and status = 'draft'", [w.clinicA])).toBe(1);
    });
  });
});

describe('payments (BR-F-03, BR-F-04, BR-F-07)', () => {
  it('follows partial and full payment, refuses overpayment, numbers receipts without gaps, replays an idempotency key', async () => {
    await scenario(async (db, w) => {
      const year = await currentYear(db, w);
      const invoice = await issuedInvoice(db, w, 200);
      expect(await pay(db, invoice.invoice_id, 50)).toMatchObject({ receipt_number: `R${year}-000001`, invoice_status: 'partially_paid', amount_paid_mad: '50.00' });
      const record = 'select * from public.record_payment($1, $2::numeric, $3::public.payment_method)';
      expect((await failure(db, record, [invoice.invoice_id, 150.01, 'cash'])).message).toBe('PAYMENT_EXCEEDS_BALANCE');
      for (const bad of [0, -5, 10.005]) {
        expect((await failure(db, record, [invoice.invoice_id, bad, 'cash'])).message).toBe('VALIDATION_FAILED');
      }
      expect(await pay(db, invoice.invoice_id, 150, 'card', null, 'TPE 0042')).toMatchObject({ receipt_number: `R${year}-000002`, invoice_status: 'paid', amount_paid_mad: '200.00' });
      expect((await failure(db, record, [invoice.invoice_id, 1, 'cash'])).message).toBe('PAYMENT_EXCEEDS_BALANCE');

      await actAs(db, asUser(w.users.receptionA));
      const draft = await one<Ref>(db, 'select * from public.create_invoice_draft(p_patient_id => $1)', [w.patientA1]);
      expect((await failure(db, record, [draft.invoice_id, 1, 'cash'])).message).toBe('INVOICE_INVALID_TRANSITION');

      const second = await issuedInvoice(db, w, 300);
      const first = await pay(db, second.invoice_id, 20, 'cash', 'pay-key-0001');
      const replay = await pay(db, second.invoice_id, 20, 'cash', 'pay-key-0001');
      expect(replay.payment_id).toBe(first.payment_id);
      expect(replay.receipt_number).toBe(`R${year}-000003`);
      expect((await failure(db, 'select * from public.record_payment($1, 25, $2, null, $3)', [second.invoice_id, 'cash', 'pay-key-0001'])).message)
        .toBe('IDEMPOTENCY_KEY_REUSED');
      await actAs(db, asPostgres);
      expect(await count(db, 'select 1 from public.payments where invoice_id = $1', [second.invoice_id])).toBe(1);
      expect(await count(db, "select 1 from public.domain_events where clinic_id = $1 and event_type = 'payment.recorded'", [w.clinicA])).toBe(3);
      expect(await one(db, 'select reference, received_by from public.payments where receipt_number = $1 and clinic_id = $2', [`R${year}-000002`, w.clinicA]))
        .toEqual({ reference: 'TPE 0042', received_by: w.users.receptionA });
    });
  });

  it('reverses payments with a reason and recomputes the status; payments are never deleted or edited (BR-F-05)', async () => {
    await scenario(async (db, w) => {
      const invoice = await issuedInvoice(db, w, 200);
      const a = await pay(db, invoice.invoice_id, 120);
      const b = await pay(db, invoice.invoice_id, 80);
      const reverse = 'select * from public.reverse_payment($1, $2)';

      expect((await failure(db, reverse, [b.payment_id, 'Erreur de saisie'])).message).toBe('FORBIDDEN'); // receptionist
      await actAs(db, asUser(w.users.accountantA));
      expect((await failure(db, reverse, [b.payment_id, 'x'])).message).toBe('VALIDATION_FAILED');
      expect(await one(db, reverse, [b.payment_id, 'Erreur de saisie'])).toMatchObject({ invoice_status: 'partially_paid', amount_paid_mad: '120.00' });
      expect((await failure(db, reverse, [b.payment_id, 'Encore'])).message).toBe('INVOICE_INVALID_TRANSITION');
      expect(await one(db, reverse, [a.payment_id, 'Chèque refusé'])).toMatchObject({ invoice_status: 'issued', amount_paid_mad: '0.00' });

      await actAs(db, asPostgres);
      expect(await one(db, 'select status::text, reversed_by, reversal_reason from public.payments where id = $1', [b.payment_id]))
        .toEqual({ status: 'reversed', reversed_by: w.users.accountantA, reversal_reason: 'Erreur de saisie' });
      for (const sql of [
        'delete from public.payments where id = $1',
        'update public.payments set amount_mad = 1 where id = $1',
        "update public.payments set status = 'recorded', reversed_at = null, reversed_by = null, reversal_reason = null where id = $1",
      ]) {
        expect((await failure(db, sql, [b.payment_id])).message, sql).toBe('APPEND_ONLY');
      }

      // Every payment reversed: the invoice may now be voided, and keeps its number.
      const { version } = await invoiceRow(db, invoice.invoice_id);
      await actAs(db, asUser(w.users.accountantA));
      await db.query("select * from public.void_invoice($1, $2, 'Facture établie par erreur')", [invoice.invoice_id, version]);
      expect(await invoiceRow(db, invoice.invoice_id)).toMatchObject({ status: 'void', invoice_number: invoice.invoice_number, amount_paid_mad: '0.00' });
    });
  });

  it('collects a balance once when two desks record it at the same time', async () => {
    const setup = await pool.connect();
    let w: World;
    let invoice: string;
    try {
      await setup.query('begin');
      w = await createWorld(setup);
      invoice = (await issuedInvoice(setup, w, 200)).invoice_id;
      await setup.query('commit');
    } catch (error) {
      await setup.query('rollback');
      throw error;
    } finally {
      setup.release();
    }
    const attempt = async () => {
      const db = await pool.connect();
      try {
        await db.query('begin');
        await actAs(db, asUser(w.users.receptionA));
        try {
          await db.query("select * from public.record_payment($1, 200, 'cash')", [invoice]);
          await db.query('commit');
          return 'ok';
        } catch (error) {
          await db.query('rollback');
          return (error as Error).message;
        }
      } finally {
        db.release();
      }
    };
    expect((await Promise.all([attempt(), attempt(), attempt()])).sort()).toEqual(['PAYMENT_EXCEEDS_BALANCE', 'PAYMENT_EXCEEDS_BALANCE', 'ok']);
    await withRollback(pool, async (db) => {
      expect(await invoiceRow(db, invoice)).toMatchObject({ status: 'paid', amount_paid_mad: '200.00' });
      expect(await count(db, 'select 1 from public.payments where invoice_id = $1', [invoice])).toBe(1);
    });
  });
});

describe('void (BR-F-06)', () => {
  it('voids only issued invoices without payments, with a reason, keeping the number; the appointment can be billed again', async () => {
    await scenario(async (db, w) => {
      const draft = await draftFromAppointment(db, w, w.apptA1);
      const voidSql = 'select * from public.void_invoice($1, $2, $3)';
      await actAs(db, asUser(w.users.accountantA));
      expect((await failure(db, voidSql, [draft.invoice_id, 1, 'Erreur'])).message).toBe('INVOICE_INVALID_TRANSITION');

      const paid = await issuedInvoice(db, w, 100);
      await pay(db, paid.invoice_id, 10);
      const paidVersion = (await invoiceRow(db, paid.invoice_id)).version;
      await actAs(db, asUser(w.users.accountantA));
      expect((await failure(db, voidSql, [paid.invoice_id, paidVersion, 'Erreur'])).message).toBe('INVOICE_INVALID_TRANSITION');

      await actAs(db, asUser(w.users.receptionA));
      const issued = await one<Ref & { invoice_number: string }>(db, 'select * from public.issue_invoice($1, $2)', [draft.invoice_id, draft.version]);
      await actAs(db, asUser(w.users.accountantA));
      expect((await failure(db, voidSql, [issued.invoice_id, issued.version, ' '])).message).toBe('VALIDATION_FAILED');
      await db.query(voidSql, [issued.invoice_id, issued.version, 'Mauvais patient']);
      expect(await invoiceRow(db, issued.invoice_id)).toMatchObject({ status: 'void', invoice_number: issued.invoice_number });
      await actAs(db, asUser(w.users.accountantA));
      expect((await failure(db, voidSql, [issued.invoice_id, issued.version + 1, 'Encore'])).message).toBe('INVOICE_INVALID_TRANSITION');
      expect((await failure(db, "select * from public.record_payment($1, 10, 'cash')", [issued.invoice_id])).message).toBe('INVOICE_INVALID_TRANSITION');

      // The void invoice no longer blocks a new invoice for the same appointment.
      const again = await draftFromAppointment(db, w, w.apptA1);
      expect(again.invoice_id).not.toBe(issued.invoice_id);
    });
  });
});

describe('who may do what (RBAC §3.7)', () => {
  it('lets the front desk bill and collect, keeps voids and reversals to owner, admin and accountant with MFA', async () => {
    await scenario(async (db, w) => {
      const invoice = await issuedInvoice(db, w, 200);
      const payment = await pay(db, invoice.invoice_id, 50);

      await actAs(db, asUser(w.users.doctorA));
      expect((await failure(db, 'select * from public.create_invoice_draft(p_appointment_id => $1)', [w.apptA1])).message).toBe('FORBIDDEN');
      expect((await failure(db, "select * from public.record_payment($1, 1, 'cash')", [invoice.invoice_id])).message).toBe('FORBIDDEN');

      await actAs(db, asUser(w.users.receptionA));
      expect((await failure(db, "select * from public.void_invoice($1, null, 'Erreur')", [invoice.invoice_id])).message).toBe('FORBIDDEN');

      await actAs(db, asUser(w.users.accountantA, 'aal1'));
      expect((await failure(db, "select * from public.reverse_payment($1, 'Erreur')", [payment.payment_id])).message).toBe('MFA_REQUIRED');
      expect(await count(db, 'select 1 from public.invoices where clinic_id = $1', [w.clinicA])).toBe(0);

      await actAs(db, asUser(w.users.ownerB));
      for (const [sql, params] of [
        ['select * from public.create_invoice_draft(p_appointment_id => $1)', [w.apptA1]],
        ['select * from public.create_invoice_draft(p_patient_id => $1)', [w.patientA1]],
        ['select * from public.issue_invoice($1, null)', [invoice.invoice_id]],
        ["select * from public.record_payment($1, 1, 'cash')", [invoice.invoice_id]],
        ["select * from public.reverse_payment($1, 'Erreur')", [payment.payment_id]],
        ["select * from public.void_invoice($1, null, 'Erreur')", [invoice.invoice_id]],
        ['select * from public.revenue_summary($1, current_date, current_date)', [w.clinicA]],
      ] as const) {
        expect((await failure(db, sql, [...params])).message, sql).toBe('NOT_FOUND');
      }

      const visible = async (who: string) => {
        await actAs(db, asUser(who));
        return [
          await count(db, 'select 1 from public.invoices where id = $1', [invoice.invoice_id]),
          await count(db, 'select 1 from public.invoice_items where invoice_id = $1', [invoice.invoice_id]),
          await count(db, 'select 1 from public.payments where invoice_id = $1', [invoice.invoice_id]),
        ];
      };
      expect(await visible(w.users.receptionA)).toEqual([1, 1, 1]);
      expect(await visible(w.users.accountantA)).toEqual([1, 1, 1]);
      expect(await visible(w.users.adminA)).toEqual([1, 1, 1]);
      for (const who of [w.users.doctorA, w.users.patientAccount, w.users.ownerB, w.users.outsider]) {
        expect(await visible(who)).toEqual([0, 0, 0]);
      }

      await actAs(db, asPostgres);
      expect(await count(db, "select 1 from public.audit_logs where entity_id = $1 and action like 'invoices.%'", [invoice.invoice_id])).toBeGreaterThanOrEqual(3);
      expect(await count(db, "select 1 from public.audit_logs where entity_id = $1 and action = 'payments.insert'", [payment.payment_id])).toBe(1);
    });
  });
});

describe('revenue summary (K7)', () => {
  it('counts invoiced, voided, collected and reversed amounts per local day, without rewriting past days', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      const { today, yesterday, noon } = await one<{ today: string; yesterday: string; noon: string }>(db,
        `select (now() at time zone c.timezone)::date::text as today, ((now() at time zone c.timezone)::date - 1)::text as yesterday,
                ((((now() at time zone c.timezone)::date - 1) + time '12:00') at time zone c.timezone)::text as noon
         from public.clinics c where c.id = $1`, [w.clinicA]);

      const x = await issuedInvoice(db, w, 200);
      await pay(db, x.invoice_id, 150, 'cash');
      const y = await issuedInvoice(db, w, 200);
      // A card payment received yesterday (inserted directly: commands always use now()).
      await actAs(db, asPostgres);
      const yPayment = (await one<{ id: string }>(db,
        `insert into public.payments (clinic_id, invoice_id, amount_mad, method, paid_at, receipt_year, receipt_seq, receipt_number, received_by)
         values ($1, $2, 100, 'card', $3::timestamptz, 1999, 1, 'R1999-000001', $4) returning id`,
        [w.clinicA, y.invoice_id, noon, w.users.receptionA])).id;
      const z = await issuedInvoice(db, w, 200);
      await actAs(db, asUser(w.users.accountantA));
      await db.query("select * from public.reverse_payment($1, 'Carte refusée')", [yPayment]);
      await db.query("select * from public.void_invoice($1, $2, 'Doublon')", [z.invoice_id, z.version]);

      const summary = 'select day::text, invoices_issued, invoiced_mad::text, invoices_voided, voided_mad::text, payments_count, collected_mad::text, reversed_mad::text, net_mad::text, by_method from public.revenue_summary($1, $2::date, $3::date)';
      const rows = (await db.query(summary, [w.clinicA, yesterday, today])).rows;
      expect(rows).toEqual([
        { day: yesterday, invoices_issued: 0, invoiced_mad: '0', invoices_voided: 0, voided_mad: '0', payments_count: 1,
          collected_mad: '100.00', reversed_mad: '0', net_mad: '100.00', by_method: { card: 100 } },
        { day: today, invoices_issued: 3, invoiced_mad: '600.00', invoices_voided: 1, voided_mad: '200.00', payments_count: 1,
          collected_mad: '150.00', reversed_mad: '100.00', net_mad: '50.00', by_method: { cash: 150, card: -100 } },
      ]);

      expect((await failure(db, 'select * from public.revenue_summary($1, $2::date, $3::date)', [w.clinicA, today, yesterday])).message).toBe('VALIDATION_FAILED');
      expect((await failure(db, "select * from public.revenue_summary($1, $2::date, $2::date + 400)", [w.clinicA, today])).message).toBe('VALIDATION_FAILED');
      await actAs(db, asUser(w.users.receptionA));
      expect((await failure(db, 'select * from public.revenue_summary($1, $2::date, $2::date)', [w.clinicA, today])).message).toBe('FORBIDDEN');
    });
  });
});
