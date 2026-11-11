/**
 * Normalize a Moroccan or international phone number to E.164 (+212…).
 * Accepts what people type: "0612 34 56 78", "06-12-34-56-78", "+212 6 12 34 56 78",
 * "00212612345678". Returns null when it cannot be valid.
 */
export function normalizePhone(input: string): string | null {
  let digits = input.trim().replace(/[\s.\-()]/g, '');
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  // Moroccan national format: 0 + 9 digits (05 landline, 06/07 mobile, 08 VoIP).
  if (/^0[5-8]\d{8}$/.test(digits)) digits = `+212${digits.slice(1)}`;
  if (/^\+212[5-8]\d{8}$/.test(digits)) return digits;
  // Other countries: plain E.164 shape (staff or patients may use foreign numbers).
  if (/^\+[1-9]\d{7,14}$/.test(digits) && !digits.startsWith('+212')) return digits;
  return null;
}

/** Display form: "+212 6 12 34 56 78" for Moroccan numbers, E.164 otherwise. */
export function formatPhone(e164: string): string {
  const match = /^\+212(\d)(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(e164);
  return match ? `+212 ${match.slice(1).join(' ')}` : e164;
}
