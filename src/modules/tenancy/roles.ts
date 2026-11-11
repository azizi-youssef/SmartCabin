/** Clinic roles and lifecycle values, importable by client and server code alike. */
export const CLINIC_ROLES = ['clinic_owner', 'clinic_admin', 'doctor', 'receptionist', 'accountant'] as const;
export type ClinicRole = (typeof CLINIC_ROLES)[number];

export const MEMBER_STATUSES = ['active', 'suspended', 'removed'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/** Roles an actor may grant or manage (mirrors the database rules; the database decides). */
export function manageableRoles(actor: ClinicRole): ClinicRole[] {
  if (actor === 'clinic_owner') return [...CLINIC_ROLES];
  if (actor === 'clinic_admin') return ['doctor', 'receptionist', 'accountant'];
  return [];
}
