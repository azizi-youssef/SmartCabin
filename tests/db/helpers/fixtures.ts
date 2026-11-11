import { randomUUID } from 'node:crypto';
import { actAs, asPostgres, one, type Db } from './db';

/**
 * Two isolated tenants (A and B) with every role, inserted as `postgres` (bypassing RLS)
 * with fresh random ids, so tests never depend on the development seed.
 */
export interface World {
  /** Local date (YYYY-MM-DD) at least two weeks ahead, a Monday: bookable in every test. */
  day: string;
  clinicA: string;
  clinicB: string;
  users: {
    ownerA: string; // CLINIC_OWNER of A, also practitioner (doctorA1)
    adminA: string;
    receptionA: string;
    accountantA: string;
    doctorA: string; // DOCTOR role, linked to doctorA2
    suspendedA: string; // receptionist, suspended
    ownerB: string;
    receptionB: string;
    doctorB: string;
    platformAdmin: string;
    patientAccount: string; // portal account linked to patientA1
    outsider: string; // confirmed account with no membership
    unconfirmed: string; // account whose email is not confirmed
  };
  doctorA1: string;
  doctorA2: string;
  doctorB1: string;
  serviceA: string; // 20 min, 200 MAD
  serviceA2: string; // 30 min, offered by doctorA2 only
  serviceB: string;
  patientA1: string;
  patientA2: string;
  patientB1: string;
  apptA1: string; // doctorA2 + patientA1, day 09:00
  apptA2: string; // doctorA1 + patientA2, day 09:00
  apptB1: string;
}

export function nextTestMonday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 14);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Instant (timestamptz text) of a Casablanca local time on `day`, computed by PostgreSQL. */
export async function localInstant(db: Db, day: string, time: string, plusDays = 0): Promise<string> {
  const row = await one<{ t: string }>(
    db,
    "select (($1::date + $3::int) + $2::time) at time zone 'Africa/Casablanca' as t",
    [day, time, plusDays],
  );
  return row.t;
}

export async function createUser(db: Db, opts: { email?: string; phone?: string; confirmed?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  const email = opts.email ?? (opts.phone ? null : `${id}@example.test`);
  await db.query(
    `insert into auth.users (id, aud, role, email, phone, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
     values ($1, 'authenticated', 'authenticated', $2, $3, $4, '{}'::jsonb, now(), now())`,
    [id, email, opts.phone ?? null, opts.confirmed === false || email === null ? null : new Date().toISOString()],
  );
  return id;
}

export async function createWorld(db: Db): Promise<World> {
  await actAs(db, asPostgres);
  const day = nextTestMonday();
  const suffix = randomUUID().slice(0, 8);

  const users = {
    ownerA: await createUser(db),
    adminA: await createUser(db),
    receptionA: await createUser(db),
    accountantA: await createUser(db),
    doctorA: await createUser(db),
    suspendedA: await createUser(db),
    ownerB: await createUser(db),
    receptionB: await createUser(db),
    doctorB: await createUser(db),
    platformAdmin: await createUser(db),
    patientAccount: await createUser(db, { phone: `99977${String(Date.now()).slice(-6)}` }),
    outsider: await createUser(db),
    unconfirmed: await createUser(db, { confirmed: false }),
  };

  await db.query('insert into public.platform_admins (user_id) values ($1)', [users.platformAdmin]);

  const clinicA = randomUUID();
  const clinicB = randomUUID();
  await db.query(
    `insert into public.clinics (id, slug, display_name, city, status, approved_at, created_by) values
       ($1, $3, 'Test Clinic A', 'Nador', 'active', now(), $5),
       ($2, $4, 'Test Clinic B', 'Nador', 'active', now(), $6)`,
    [clinicA, clinicB, `test-a-${suffix}`, `test-b-${suffix}`, users.ownerA, users.ownerB],
  );
  await db.query('insert into public.clinic_settings (clinic_id) values ($1), ($2)', [clinicA, clinicB]);
  await db.query(
    `insert into public.clinic_members (clinic_id, user_id, role, status) values
       ($1, $3, 'clinic_owner', 'active'), ($1, $4, 'clinic_admin', 'active'),
       ($1, $5, 'receptionist', 'active'), ($1, $6, 'accountant', 'active'),
       ($1, $7, 'doctor', 'active'), ($1, $8, 'receptionist', 'suspended'),
       ($2, $9, 'clinic_owner', 'active'), ($2, $10, 'receptionist', 'active'), ($2, $11, 'doctor', 'active')`,
    [clinicA, clinicB, users.ownerA, users.adminA, users.receptionA, users.accountantA, users.doctorA,
     users.suspendedA, users.ownerB, users.receptionB, users.doctorB],
  );

  const [doctorA1, doctorA2, doctorB1] = [randomUUID(), randomUUID(), randomUUID()];
  await db.query(
    `insert into public.doctors (id, clinic_id, user_id, full_name) values
       ($1, $4, $6, 'Doctor A1 (owner)'), ($2, $4, $7, 'Doctor A2'), ($3, $5, $8, 'Doctor B1')`,
    [doctorA1, doctorA2, doctorB1, clinicA, clinicB, users.ownerA, users.doctorA, users.doctorB],
  );

  const [serviceA, serviceA2, serviceB] = [randomUUID(), randomUUID(), randomUUID()];
  await db.query(
    `insert into public.services (id, clinic_id, name_fr, default_duration_minutes, price_mad, online_bookable) values
       ($1, $4, 'Consultation', 20, 200, true), ($2, $4, 'ECG', 30, 300, false), ($3, $5, 'Consultation B', 20, 250, true)`,
    [serviceA, serviceA2, serviceB, clinicA, clinicB],
  );
  await db.query(
    `insert into public.doctor_services (clinic_id, doctor_id, service_id) values
       ($1, $3, $6), ($1, $4, $6), ($1, $4, $7), ($2, $5, $8)`,
    [clinicA, clinicB, doctorA1, doctorA2, doctorB1, serviceA, serviceA2, serviceB],
  );

  // Regular schedule for every doctor: Monday–Saturday 08:00–18:00, valid from 30 days ago.
  await db.query(
    `with s as (
       insert into public.doctor_schedules (clinic_id, doctor_id, name, kind, valid_from)
       select d.clinic_id, d.id, 'Regular', 'regular', current_date - 30
       from public.doctors d where d.id = any($1::uuid[])
       returning id, clinic_id, doctor_id)
     insert into public.doctor_availability (clinic_id, schedule_id, doctor_id, weekday, start_time, end_time)
     select s.clinic_id, s.id, s.doctor_id, w, time '08:00', time '18:00'
     from s cross join generate_series(1, 6) as w`,
    [[doctorA1, doctorA2, doctorB1]],
  );

  const [patientA1, patientA2, patientB1] = [randomUUID(), randomUUID(), randomUUID()];
  await db.query(
    `insert into public.patients (id, clinic_id, first_name, last_name, phone_e164) values
       ($1, $4, 'Alice', 'Alpha', '+99911111111'), ($2, $4, 'Bob', 'Alpha', '+99911111111'),
       ($3, $5, 'Carla', 'Beta', '+99922222222')`,
    [patientA1, patientA2, patientB1, clinicA, clinicB],
  );
  await db.query(
    `insert into public.patient_accounts (user_id, clinic_id, patient_id, relationship, linked_via)
     values ($1, $2, $3, 'self', 'staff')`,
    [users.patientAccount, clinicA, patientA1],
  );
  await db.query(
    `insert into public.patient_consents (clinic_id, patient_id, purpose, granted, document_version, source) values
       ($1, $2, 'data_processing', true, 'v1', 'reception'), ($3, $4, 'data_processing', true, 'v1', 'reception')`,
    [clinicA, patientA1, clinicB, patientB1],
  );

  const at0900 = await localInstant(db, day, '09:00');
  const at0920 = await localInstant(db, day, '09:20');
  const [apptA1, apptA2, apptB1] = [randomUUID(), randomUUID(), randomUUID()];
  await db.query(
    `insert into public.appointments (id, clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, source, price_mad, confirmed_at) values
       ($1, $4, $6, $9, $12, $14, $15, 'confirmed', 'staff', 200, now()),
       ($2, $4, $7, $10, $12, $14, $15, 'confirmed', 'staff', 200, now()),
       ($3, $5, $8, $11, $13, $14, $15, 'confirmed', 'staff', 250, now())`,
    [apptA1, apptA2, apptB1, clinicA, clinicB, patientA1, patientA2, patientB1,
     doctorA2, doctorA1, doctorB1, serviceA, serviceB, at0900, at0920],
  );

  await db.query(
    `insert into public.doctor_time_off (clinic_id, doctor_id, period, reason_category)
     values ($1, $2, tstzrange($3::timestamptz, $4::timestamptz, '[)'), 'training'),
            ($5, $6, tstzrange($3::timestamptz, $4::timestamptz, '[)'), 'training')`,
    [clinicA, doctorA1, await localInstant(db, day, '16:00'), await localInstant(db, day, '18:00'), clinicB, doctorB1],
  );
  await db.query(
    `insert into public.clinic_closures (clinic_id, dates, reason)
     values ($1, daterange($3::date + 5, $3::date + 5, '[]'), 'Closure A'),
            ($2, daterange($3::date + 5, $3::date + 5, '[]'), 'Closure B')`,
    [clinicA, clinicB, day],
  );

  return {
    day, clinicA, clinicB, users, doctorA1, doctorA2, doctorB1, serviceA, serviceA2, serviceB,
    patientA1, patientA2, patientB1, apptA1, apptA2, apptB1,
  };
}

/**
 * Records the caller's acceptance of the currently published legal documents (creating
 * test versions if none is published), as the onboarding form does.
 */
export async function acceptCurrentTerms(
  db: Db,
  userId: string,
  kinds: Array<'terms_of_service' | 'privacy_policy'> = ['terms_of_service', 'privacy_policy'],
): Promise<void> {
  await actAs(db, asPostgres);
  for (const kind of kinds) {
    await db.query(
      `insert into public.legal_documents (kind, locale, version, content_path, is_current)
       select $1::public.legal_kind, 'fr', 'test', 'legal/test.md', true
       where not exists (select 1 from public.legal_documents where kind = $1::public.legal_kind and is_current)`,
      [kind],
    );
  }
  await actAs(db, { kind: 'user', id: userId, aal: 'aal1' });
  for (const kind of kinds) {
    await db.query(
      `insert into public.legal_acceptances (document_id, context)
       select id, 'clinic_creation' from public.legal_documents where kind = $1::public.legal_kind and is_current limit 1`,
      [kind],
    );
  }
  await actAs(db, asPostgres);
}

/** Tenant-owned tables and the column that holds the tenant id. */
export const TENANT_TABLES = [
  'clinics', 'clinic_settings', 'clinic_members', 'clinic_invitations', 'clinic_closures',
  'services', 'doctors', 'doctor_services', 'doctor_schedules', 'doctor_availability', 'doctor_time_off',
  'patients', 'patient_accounts', 'patient_consents', 'appointments', 'appointment_history',
  'audit_logs', 'domain_events',
] as const;

export function tenantColumn(table: (typeof TENANT_TABLES)[number]): string {
  return table === 'clinics' ? 'id' : 'clinic_id';
}
