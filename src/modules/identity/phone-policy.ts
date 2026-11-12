/*
 * Which numbers may receive a portal sign-in code (SC-AUD-01): Moroccan mobile numbers only
 * (+212 6…, +212 7…), so premium-rate and foreign ranges never receive an SMS from the platform.
 * Outside production, the synthetic +999 numbers of the test data are accepted too (no real
 * patient data before CNDP clearance).
 */

const MOROCCAN_MOBILE = /^\+212[67]\d{8}$/;
const SYNTHETIC = /^\+999\d{6,12}$/;

export function portalPhoneAllowed(e164: string, production = process.env.NODE_ENV === 'production'): boolean {
  return MOROCCAN_MOBILE.test(e164) || (!production && SYNTHETIC.test(e164));
}
