import 'server-only';

import { z } from 'zod';

import { toErrorCode } from '@/shared/lib/errors';
import type { Loaded } from '@/shared/lib/result';
import { getSupabase } from '@/shared/lib/supabase/server';

import { INVOICE_STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES, statusesFor, type InvoiceFilter, type InvoiceStatus, type PaymentMethod, type PaymentStatus } from './domain';

/*
 * Billing reads (module 10). RLS limits every row to invoices.view (owner, admin, receptionist,
 * accountant). Patient names come from the invoice's own bill_to_name, so an accountant never
 * needs patients.view to read an invoice.
 */

export const INVOICE_PAGE_SIZE = 100;

export interface InvoiceSummary {
  id: string;
  status: InvoiceStatus;
  number: string | null;
  issuedAt: string | null;
  createdAt: string;
  billTo: string;
  totalMad: string;
  paidMad: string;
}

export interface InvoiceItem {
  id: string;
  serviceId: string | null;
  description: string;
  quantity: string;
  unitPriceMad: string;
  lineTotalMad: string;
}

export interface Payment {
  id: string;
  amountMad: string;
  method: PaymentMethod;
  paidAt: string;
  reference: string | null;
  receiptNumber: string;
  status: PaymentStatus;
  reversedAt: string | null;
  reversalReason: string | null;
}

export interface ClinicSnapshot {
  displayName: string | null;
  legalName: string | null;
  ice: string | null;
  addressLine: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
}

export interface InvoiceFile extends InvoiceSummary {
  patientId: string;
  appointmentId: string | null;
  subtotalMad: string;
  discountMad: string;
  notes: string | null;
  voidReason: string | null;
  voidedAt: string | null;
  version: number;
  clinic: ClinicSnapshot | null;
  items: InvoiceItem[];
  payments: Payment[];
}

const status = z.enum(INVOICE_STATUSES);

const summaryRow = z.object({
  id: z.uuid(),
  status,
  invoice_number: z.string().nullable(),
  issued_at: z.string().nullable(),
  created_at: z.string(),
  bill_to_name: z.string(),
  total_mad: z.union([z.string(), z.number()]).transform(String),
  amount_paid_mad: z.union([z.string(), z.number()]).transform(String),
});

const money = z.union([z.string(), z.number()]).transform((v) => Number(v).toFixed(2));

const fileRow = summaryRow.extend({
  patient_id: z.uuid(),
  appointment_id: z.uuid().nullable(),
  subtotal_mad: money,
  discount_mad: money,
  notes: z.string().nullable(),
  void_reason: z.string().nullable(),
  voided_at: z.string().nullable(),
  version: z.number().int(),
  clinic_snapshot: z.record(z.string(), z.unknown()).nullable(),
});

const itemRows = z.array(z.object({
  id: z.uuid(),
  service_id: z.uuid().nullable(),
  description: z.string(),
  quantity: money,
  unit_price_mad: money,
  line_total_mad: money,
}));

const paymentRows = z.array(z.object({
  id: z.uuid(),
  amount_mad: money,
  method: z.enum(PAYMENT_METHODS),
  paid_at: z.string(),
  reference: z.string().nullable(),
  receipt_number: z.string(),
  status: z.enum(PAYMENT_STATUSES),
  reversed_at: z.string().nullable(),
  reversal_reason: z.string().nullable(),
}));

function summary(r: z.infer<typeof summaryRow>): InvoiceSummary {
  return {
    id: r.id,
    status: r.status,
    number: r.invoice_number,
    issuedAt: r.issued_at,
    createdAt: r.created_at,
    billTo: r.bill_to_name,
    totalMad: Number(r.total_mad).toFixed(2),
    paidMad: Number(r.amount_paid_mad).toFixed(2),
  };
}

function failed<T>(error: unknown): Loaded<T> {
  const code = toErrorCode(error);
  return code === 'UNAVAILABLE' ? { status: 'unavailable' } : { status: 'error', code };
}

/** Removes what PostgREST filter syntax would interpret (commas, parentheses, wildcards). */
export function sanitizeInvoiceSearch(q: string): string {
  return q.replace(/[,()*%\\:"'.]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** Newest first; a filter by status group and an optional search on number or name. */
export async function loadInvoices(params: { clinicId: string; filter: InvoiceFilter; query: string }): Promise<Loaded<{ rows: InvoiceSummary[]; hasMore: boolean }>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  let request = supabase
    .from('invoices')
    .select('id, status, invoice_number, issued_at, created_at, bill_to_name, total_mad, amount_paid_mad')
    .eq('clinic_id', params.clinicId);
  const statuses = statusesFor(params.filter);
  if (statuses) request = request.in('status', statuses);
  const q = sanitizeInvoiceSearch(params.query);
  if (q) request = request.or(`invoice_number.ilike.*${q}*,bill_to_name.ilike.*${q}*`);
  const { data, error } = await request.order('created_at', { ascending: false }).limit(INVOICE_PAGE_SIZE + 1);
  if (error) return failed(error);
  const parsed = z.array(summaryRow).safeParse(data);
  if (!parsed.success) return { status: 'error', code: 'INTERNAL' };
  return { status: 'ok', data: { rows: parsed.data.slice(0, INVOICE_PAGE_SIZE).map(summary), hasMore: parsed.data.length > INVOICE_PAGE_SIZE } };
}

/** The invoice with its lines and payments (receipts), or NOT_FOUND (missing or another clinic). */
export async function loadInvoice(clinicId: string, invoiceId: string): Promise<Loaded<InvoiceFile>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const [invoice, items, payments] = await Promise.all([
    supabase
      .from('invoices')
      .select('id, status, invoice_number, issued_at, created_at, bill_to_name, total_mad, amount_paid_mad, patient_id, appointment_id, subtotal_mad, discount_mad, notes, void_reason, voided_at, version, clinic_snapshot')
      .eq('clinic_id', clinicId)
      .eq('id', invoiceId)
      .maybeSingle(),
    supabase
      .from('invoice_items')
      .select('id, service_id, description, quantity, unit_price_mad, line_total_mad')
      .eq('clinic_id', clinicId)
      .eq('invoice_id', invoiceId)
      .order('position', { ascending: true }),
    supabase
      .from('payments')
      .select('id, amount_mad, method, paid_at, reference, receipt_number, status, reversed_at, reversal_reason')
      .eq('clinic_id', clinicId)
      .eq('invoice_id', invoiceId)
      .order('paid_at', { ascending: true }),
  ]);
  const error = invoice.error ?? items.error ?? payments.error;
  if (error) return failed(error);
  if (!invoice.data) return { status: 'error', code: 'NOT_FOUND' };
  const f = fileRow.safeParse(invoice.data);
  const it = itemRows.safeParse(items.data);
  const p = paymentRows.safeParse(payments.data);
  if (!f.success || !it.success || !p.success) return { status: 'error', code: 'INTERNAL' };
  const snap = f.data.clinic_snapshot;
  const text = (key: string) => (snap && typeof snap[key] === 'string' ? (snap[key] as string) : null);
  return {
    status: 'ok',
    data: {
      ...summary(f.data),
      patientId: f.data.patient_id,
      appointmentId: f.data.appointment_id,
      subtotalMad: f.data.subtotal_mad,
      discountMad: f.data.discount_mad,
      notes: f.data.notes,
      voidReason: f.data.void_reason,
      voidedAt: f.data.voided_at,
      version: f.data.version,
      clinic: snap
        ? { displayName: text('display_name'), legalName: text('legal_name'), ice: text('ice'), addressLine: text('address_line'), city: text('city'), phone: text('phone_e164'), email: text('email') }
        : null,
      items: it.data.map((r) => ({ id: r.id, serviceId: r.service_id, description: r.description, quantity: r.quantity, unitPriceMad: r.unit_price_mad, lineTotalMad: r.line_total_mad })),
      payments: p.data.map((r) => ({
        id: r.id, amountMad: r.amount_mad, method: r.method, paidAt: r.paid_at, reference: r.reference,
        receiptNumber: r.receipt_number, status: r.status, reversedAt: r.reversed_at, reversalReason: r.reversal_reason,
      })),
    },
  };
}

/** The appointment's open (not void) invoice, if any: one per appointment. */
export async function loadAppointmentInvoice(clinicId: string, appointmentId: string): Promise<Loaded<{ id: string; status: InvoiceStatus; number: string | null } | null>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const { data, error } = await supabase
    .from('invoices')
    .select('id, status, invoice_number')
    .eq('clinic_id', clinicId)
    .eq('appointment_id', appointmentId)
    .neq('status', 'void')
    .maybeSingle();
  if (error) return failed(error);
  const parsed = z.object({ id: z.uuid(), status, invoice_number: z.string().nullable() }).nullable().safeParse(data);
  if (!parsed.success) return { status: 'error', code: 'INTERNAL' };
  return { status: 'ok', data: parsed.data ? { id: parsed.data.id, status: parsed.data.status, number: parsed.data.invoice_number } : null };
}

export interface RevenueDay {
  day: string;
  invoicesIssued: number;
  invoicedMad: string;
  invoicesVoided: number;
  voidedMad: string;
  paymentsCount: number;
  collectedMad: string;
  reversedMad: string;
  netMad: string;
  byMethod: Partial<Record<PaymentMethod, string>>;
}

const revenueRows = z.array(z.object({
  day: z.string(),
  invoices_issued: z.number().int(),
  invoiced_mad: money,
  invoices_voided: z.number().int(),
  voided_mad: money,
  payments_count: z.number().int(),
  collected_mad: money,
  reversed_mad: money,
  net_mad: money,
  by_method: z.record(z.string(), z.union([z.number(), z.string()])),
}));

/** K7 per local day (BUSINESS_RULES §8): needs billing.reports (owner, admin, accountant). */
export async function loadRevenue(clinicId: string, from: string, to: string): Promise<Loaded<RevenueDay[]>> {
  const supabase = await getSupabase();
  if (!supabase) return { status: 'unavailable' };
  const { data, error } = await supabase.rpc('revenue_summary', { p_clinic_id: clinicId, p_from: from, p_to: to });
  if (error) return failed(error);
  const parsed = revenueRows.safeParse(data);
  if (!parsed.success) return { status: 'error', code: 'INTERNAL' };
  return {
    status: 'ok',
    data: parsed.data.map((r) => ({
      day: r.day,
      invoicesIssued: r.invoices_issued,
      invoicedMad: r.invoiced_mad,
      invoicesVoided: r.invoices_voided,
      voidedMad: r.voided_mad,
      paymentsCount: r.payments_count,
      collectedMad: r.collected_mad,
      reversedMad: r.reversed_mad,
      netMad: r.net_mad,
      byMethod: Object.fromEntries(
        Object.entries(r.by_method)
          .filter((e): e is [PaymentMethod, number | string] => (PAYMENT_METHODS as readonly string[]).includes(e[0]))
          .map(([k, v]) => [k, Number(v).toFixed(2)]),
      ),
    })),
  };
}
