import { describe, expect, it } from 'vitest';

import { invoiceActions, statusesFor } from './domain';
import { centsToDecimal, decimalToCents, lineTotalCents, parseCents, parseQuantity, quantityLabel } from './money';

describe('money in cents (BR-F-08)', () => {
  it('parses amounts typed with a dot or a comma, at most two decimals, never negative', () => {
    expect(parseCents('350')).toBe(35_000);
    expect(parseCents('12.5')).toBe(1250);
    expect(parseCents(' 12,50 ')).toBe(1250);
    expect(parseCents('0')).toBe(0);
    for (const bad of ['', '-5', '10.005', 'abc', '1e3', '12.', '.5', '123456789']) expect(parseCents(bad), bad).toBeNull();
  });

  it('parses quantities above zero and up to 999', () => {
    expect(parseQuantity('1')).toBe(100);
    expect(parseQuantity('1,5')).toBe(150);
    expect(parseQuantity('999')).toBe(99_900);
    for (const bad of ['0', '0.00', '1000', '-1', '1.234', 'x']) expect(parseQuantity(bad), bad).toBeNull();
  });

  it('rounds each line half-up to the cent, like the database', () => {
    expect(lineTotalCents(150, 3333)).toBe(5000); // 1.5 × 33.33 = 49.995 → 50.00
    expect(lineTotalCents(100, 20_000)).toBe(20_000);
    expect(lineTotalCents(33, 1)).toBe(0); // 0.33 × 0.01 = 0.0033 → 0.00
    expect(lineTotalCents(50, 1)).toBe(1); // 0.5 × 0.01 = 0.005 → 0.01
    expect(lineTotalCents(99_900, 100_000_000)).toBe(99_900_000_000);
  });

  it('formats cents for the API and reads database decimals back', () => {
    expect(centsToDecimal(1250)).toBe('12.50');
    expect(centsToDecimal(5)).toBe('0.05');
    expect(centsToDecimal(-10_000)).toBe('-100.00');
    expect(decimalToCents('350.00')).toBe(35_000);
    expect(decimalToCents('-100.5')).toBe(-10_050);
    expect(decimalToCents('9999999999.99')).toBe(999_999_999_999);
    expect(quantityLabel('1.50')).toBe('1.5');
    expect(quantityLabel('2.00')).toBe('2');
    expect(quantityLabel('10.00')).toBe('10');
    expect(quantityLabel('10')).toBe('10');
  });
});

describe('invoice lifecycle in the UI (BUSINESS_RULES §5)', () => {
  it('offers editing for drafts, payment while money is due, and voiding only before any payment', () => {
    expect(invoiceActions('draft')).toEqual({ edit: true, pay: false, void: false });
    expect(invoiceActions('issued')).toEqual({ edit: false, pay: true, void: true });
    expect(invoiceActions('partially_paid')).toEqual({ edit: false, pay: true, void: false });
    expect(invoiceActions('paid')).toEqual({ edit: false, pay: false, void: false });
    expect(invoiceActions('void')).toEqual({ edit: false, pay: false, void: false });
  });

  it('maps list filters to statuses', () => {
    expect(statusesFor('unpaid')).toEqual(['issued', 'partially_paid']);
    expect(statusesFor('all')).toBeNull();
  });
});
