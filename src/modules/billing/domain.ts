import type { BadgeTone } from '@/shared/ui/badge';

/** BUSINESS_RULES §5. The database decides every transition; these drive what the UI offers. */
export const INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'cheque', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['recorded', 'reversed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** List filters: "unpaid" groups issued and partially paid invoices (money still due). */
export const INVOICE_FILTERS = ['all', 'draft', 'unpaid', 'paid', 'void'] as const;
export type InvoiceFilter = (typeof INVOICE_FILTERS)[number];

export const INVOICE_STATUS_TONE: Record<InvoiceStatus, BadgeTone> = {
  draft: 'neutral',
  issued: 'warning',
  partially_paid: 'info',
  paid: 'success',
  void: 'danger',
};

export function statusesFor(filter: InvoiceFilter): InvoiceStatus[] | null {
  switch (filter) {
    case 'draft':
      return ['draft'];
    case 'unpaid':
      return ['issued', 'partially_paid'];
    case 'paid':
      return ['paid'];
    case 'void':
      return ['void'];
    default:
      return null;
  }
}

/** Payments are accepted while money is due (BR-F-04); voiding needs no recorded payment (BR-F-06). */
export function invoiceActions(status: InvoiceStatus): { edit: boolean; pay: boolean; void: boolean } {
  return {
    edit: status === 'draft',
    pay: status === 'issued' || status === 'partially_paid',
    void: status === 'issued',
  };
}
