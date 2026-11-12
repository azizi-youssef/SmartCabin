'use server';

import { z } from 'zod';

import { toErrorCode } from '@/shared/lib/errors';
import type { ActionResult } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

import { PAYMENT_METHODS } from './domain';

/*
 * Billing commands (module 10). Totals, numbering, balances and permissions are decided by the
 * database with the caller's session; these only validate the shape before sending.
 */

const uuid = z.uuid();
const version = z.number().int().min(1);
const reason = z.string().trim().min(3).max(300);
const key = z.string().min(8).max(100);
/** Decimal strings, at most two decimals (BR-F-08). */
const amount = z.string().trim().regex(/^\d{1,8}(\.\d{1,2})?$/);
const quantity = z.string().trim().regex(/^\d{1,3}(\.\d{1,2})?$/);

async function rpc(fn: string, args: Record<string, unknown>): Promise<ActionResult<unknown>> {
  const supabase = await getSupabase();
  if (!supabase) return { ok: false, code: 'UNAVAILABLE' };
  const { data, error } = await supabase.rpc(fn, args);
  return error ? { ok: false, code: toErrorCode(error) } : { ok: true, data };
}

function first(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === 'object' ? (row as Record<string, unknown>) : null;
}

/** From an appointment (its booked price) or for a patient (empty draft). */
export async function createInvoiceDraft(input: { appointmentId?: string; patientId?: string; idempotencyKey: string }): Promise<ActionResult<{ invoiceId: string }>> {
  const parsed = z.object({ appointmentId: uuid.optional(), patientId: uuid.optional(), idempotencyKey: key })
    .refine((v) => Boolean(v.appointmentId) !== Boolean(v.patientId)).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const result = await rpc('create_invoice_draft', {
    p_appointment_id: parsed.data.appointmentId ?? null,
    p_patient_id: parsed.data.patientId ?? null,
    p_idempotency_key: parsed.data.idempotencyKey,
  });
  if (!result.ok) return result;
  const id = uuid.safeParse(first(result.data)?.['invoice_id']);
  return id.success ? { ok: true, data: { invoiceId: id.data } } : { ok: false, code: 'INTERNAL' };
}

const itemInput = z.object({
  serviceId: uuid.nullable(),
  description: z.string().trim().min(1).max(200),
  quantity,
  unitPriceMad: amount,
});

export async function saveInvoiceDraft(input: {
  invoiceId: string;
  version: number;
  items: z.input<typeof itemInput>[];
  discountMad: string;
  notes: string;
}): Promise<ActionResult<{ version: number }>> {
  const parsed = z.object({
    invoiceId: uuid,
    version,
    items: z.array(itemInput).max(50),
    discountMad: amount,
    notes: z.string().trim().max(500),
  }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const d = parsed.data;
  const result = await rpc('update_invoice_draft', {
    p_invoice_id: d.invoiceId,
    p_expected_version: d.version,
    p_items: d.items.map((i) => ({ service_id: i.serviceId, description: i.description, quantity: i.quantity, unit_price_mad: i.unitPriceMad })),
    p_discount_mad: d.discountMad,
    p_notes: d.notes || null,
  });
  if (!result.ok) return result;
  const v = version.safeParse(first(result.data)?.['version']);
  return v.success ? { ok: true, data: { version: v.data } } : { ok: false, code: 'INTERNAL' };
}

export async function discardInvoiceDraft(input: { invoiceId: string; version: number }): Promise<ActionResult> {
  const parsed = z.object({ invoiceId: uuid, version }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const result = await rpc('discard_invoice_draft', { p_invoice_id: parsed.data.invoiceId, p_expected_version: parsed.data.version });
  return result.ok ? { ok: true, data: undefined } : result;
}

/** BR-F-01: the number is assigned here, by the database. */
export async function issueInvoice(input: { invoiceId: string; version: number }): Promise<ActionResult<{ number: string }>> {
  const parsed = z.object({ invoiceId: uuid, version }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const result = await rpc('issue_invoice', { p_invoice_id: parsed.data.invoiceId, p_expected_version: parsed.data.version });
  if (!result.ok) return result;
  const number = z.string().safeParse(first(result.data)?.['invoice_number']);
  return number.success ? { ok: true, data: { number: number.data } } : { ok: false, code: 'INTERNAL' };
}

export async function voidInvoice(input: { invoiceId: string; version: number; reason: string }): Promise<ActionResult> {
  const parsed = z.object({ invoiceId: uuid, version, reason }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const result = await rpc('void_invoice', { p_invoice_id: parsed.data.invoiceId, p_expected_version: parsed.data.version, p_reason: parsed.data.reason });
  return result.ok ? { ok: true, data: undefined } : result;
}

/** BR-F-04 and BR-F-07: no overpayment; each payment gets a receipt number. */
export async function recordPayment(input: {
  invoiceId: string;
  amountMad: string;
  method: string;
  reference: string;
  idempotencyKey: string;
}): Promise<ActionResult<{ receiptNumber: string }>> {
  const parsed = z.object({
    invoiceId: uuid,
    amountMad: amount.refine((v) => Number(v) > 0),
    method: z.enum(PAYMENT_METHODS),
    reference: z.string().trim().max(100),
    idempotencyKey: key,
  }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const d = parsed.data;
  const result = await rpc('record_payment', {
    p_invoice_id: d.invoiceId,
    p_amount_mad: d.amountMad,
    p_method: d.method,
    p_reference: d.reference || null,
    p_idempotency_key: d.idempotencyKey,
  });
  if (!result.ok) return result;
  const receipt = z.string().safeParse(first(result.data)?.['receipt_number']);
  return receipt.success ? { ok: true, data: { receiptNumber: receipt.data } } : { ok: false, code: 'INTERNAL' };
}

/** BR-F-05: a reversal with a reason (owner, admin, accountant with MFA). */
export async function reversePayment(input: { paymentId: string; reason: string }): Promise<ActionResult> {
  const parsed = z.object({ paymentId: uuid, reason }).safeParse(input);
  if (!parsed.success) return { ok: false, code: 'VALIDATION_FAILED' };
  const result = await rpc('reverse_payment', { p_payment_id: parsed.data.paymentId, p_reason: parsed.data.reason });
  return result.ok ? { ok: true, data: undefined } : result;
}
