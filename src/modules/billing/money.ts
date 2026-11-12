/*
 * Money on the client (BR-F-08): amounts travel as decimal strings ("350.00") and are computed
 * here in integer cents, never in floating point. The database recomputes every total; these
 * helpers only preview it and validate input before sending.
 */

const AMOUNT = /^(\d{1,8})(?:[.,](\d{1,2}))?$/;
const QUANTITY = /^(\d{1,3})(?:[.,](\d{1,2}))?$/;

/** "12", "12.5", "12,50" → 1250. Null for anything else (negative, 3 decimals, text). */
export function parseCents(input: string): number | null {
  const m = AMOUNT.exec(input.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** Quantity in hundredths: "1.5" → 150. Must be > 0 and ≤ 999 (the database limits). */
export function parseQuantity(input: string): number | null {
  const m = QUANTITY.exec(input.trim());
  if (!m) return null;
  const value = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return value > 0 && value <= 99_900 ? value : null;
}

/** 1250 → "12.50" (the format the database and the API exchange). */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

/** "350.00" → 35000, "-100.5" → -10050: decimals as the database returns them. */
export function decimalToCents(value: string): number {
  const m = DECIMAL.exec(value.trim());
  if (!m) return 0;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

/** quantity (hundredths) × unit price (cents), rounded half-up to the cent, as the database does. */
export function lineTotalCents(quantityHundredths: number, unitCents: number): number {
  return Math.floor((quantityHundredths * unitCents + 50) / 100);
}

/** "1.50" → "1.5", "2.00" → "2": quantities shown the way people type them. */
export function quantityLabel(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}
