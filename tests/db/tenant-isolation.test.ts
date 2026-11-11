import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { actAs, asAnon, asPostgres, asUser, count, createPool, failure, rowCount, withRollback, type Db } from './helpers/db';
import { createWorld, localInstant, TENANT_TABLES, tenantColumn, type World } from './helpers/fixtures';

/**
 * Cross-tenant isolation: a principal from clinic B (or with no clinic at all) must not read,
 * write or reference anything belonging to clinic A — through tables or through commands.
 */
let pool: pg.Pool;
beforeAll(() => {
  pool = createPool(2);
});
afterAll(async () => {
  await pool.end();
});

async function scenario(fn: (db: Db, w: World) => Promise<void>): Promise<void> {
  await withRollback(pool, async (db) => {
    const world = await createWorld(db);
    await fn(db, world);
  });
}

describe('reads across tenants', () => {
  it('shows clinic A rows to clinic A owner (sanity check of the fixture)', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.ownerA));
      expect(await count(db, 'select 1 from public.patients where clinic_id = $1', [w.clinicA])).toBe(2);
      expect(await count(db, 'select 1 from public.appointments where clinic_id = $1', [w.clinicA])).toBe(2);
    });
  });

  it.each([
    ['owner of B (aal2)', 'ownerB'],
    ['receptionist of B', 'receptionB'],
    ['doctor of B', 'doctorB'],
    ['authenticated user without membership', 'outsider'],
    ['patient portal account', 'patientAccount'],
    ['platform admin (aal2)', 'platformAdmin'],
    ['suspended member of A', 'suspendedA'],
  ] as const)('returns zero rows of clinic A to %s, on every tenant table', async (_label, who) => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users[who]));
      for (const table of TENANT_TABLES) {
        if (table === 'domain_events') {
          // No privilege at all on the outbox.
          const err = await failure(db, 'select 1 from public.domain_events limit 1');
          expect(err.code).toBe('42501');
          continue;
        }
        // A user may always see their own membership rows (e.g. "suspended"): that is their own
        // data, not another tenant's. Everything else of clinic A must be invisible.
        const ownRows = table === 'clinic_members' ? ' and user_id <> $2' : '';
        const params = table === 'clinic_members' ? [w.clinicA, w.users[who]] : [w.clinicA];
        const n = await count(db, `select 1 from public.${table} where ${tenantColumn(table)} = $1${ownRows}`, params);
        expect(n, `${who} must not see ${table} of clinic A`).toBe(0);
      }
    });
  });

  it('gives anon no access to tenant tables (permission denied, not just zero rows)', async () => {
    await scenario(async (db) => {
      await actAs(db, asAnon);
      for (const table of TENANT_TABLES) {
        const err = await failure(db, `select 1 from public.${table} limit 1`);
        expect(err.code, `anon on ${table}`).toBe('42501');
      }
      expect(await count(db, 'select 1 from public.specialties')).toBeGreaterThan(0);
    });
  });

  it('hides everything from an owner whose session lacks MFA (aal1)', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.ownerA, 'aal1'));
      expect(await count(db, 'select 1 from public.patients where clinic_id = $1', [w.clinicA])).toBe(0);
      expect(await count(db, 'select 1 from public.clinics where id = $1', [w.clinicA])).toBe(0);
      // Own membership stays visible so the app can prompt for MFA.
      expect(await count(db, 'select 1 from public.clinic_members where user_id = $1', [w.users.ownerA])).toBe(1);
    });
  });
});

describe('writes across tenants', () => {
  it('rejects inserts into clinic A from the owner of clinic B (RLS WITH CHECK)', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.ownerB));
      const attempts: Array<[string, unknown[]]> = [
        ['insert into public.services (clinic_id, name_fr, default_duration_minutes, price_mad) values ($1, $2, 20, 100)', [w.clinicA, 'Intrusion']],
        ['insert into public.doctors (clinic_id, full_name) values ($1, $2)', [w.clinicA, 'Intrusion']],
        ['insert into public.patients (clinic_id, first_name, last_name) values ($1, $2, $2)', [w.clinicA, 'Intrusion']],
        ["insert into public.clinic_closures (clinic_id, dates, reason) values ($1, daterange('2030-01-01', '2030-01-02'), 'x x')", [w.clinicA]],
        ["insert into public.doctor_time_off (clinic_id, doctor_id, period) values ($1, $2, tstzrange('2030-01-01', '2030-01-02'))", [w.clinicA, w.doctorA1]],
        ["insert into public.doctor_schedules (clinic_id, doctor_id, name, valid_from) values ($1, $2, 'xx', '2030-01-01')", [w.clinicA, w.doctorA1]],
        ["insert into public.patient_consents (clinic_id, patient_id, purpose, granted, document_version, source) values ($1, $2, 'reminders_sms', true, 'v1', 'reception')", [w.clinicA, w.patientA1]],
      ];
      for (const [sql, params] of attempts) {
        const err = await failure(db, sql, params);
        expect(err.code, sql).toBe('42501');
      }
    });
  });

  it('updates and deletes nothing in clinic A for the owner of clinic B', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.ownerB));
      expect(await rowCount(db, "update public.services set name_fr = 'hijacked' where clinic_id = $1", [w.clinicA])).toBe(0);
      expect(await rowCount(db, "update public.patients set first_name = 'hijacked' where clinic_id = $1", [w.clinicA])).toBe(0);
      expect(await rowCount(db, "update public.clinics set display_name = 'hijacked' where id = $1", [w.clinicA])).toBe(0);
      expect(await rowCount(db, 'delete from public.doctor_time_off where clinic_id = $1', [w.clinicA])).toBe(0);
      expect(await rowCount(db, 'delete from public.clinic_closures where clinic_id = $1', [w.clinicA])).toBe(0);
      await actAs(db, asPostgres);
      expect(await count(db, "select 1 from public.services where name_fr = 'hijacked'")).toBe(0);
    });
  });

  it('answers NOT_FOUND (never FORBIDDEN) to commands aimed at clinic A from clinic B', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionB));
      const startsAt = await localInstant(db, w.day, '11:00');
      const commands: Array<[string, unknown[]]> = [
        ['select public.book_appointment($1, $2, $3, $4)', [w.patientA1, w.doctorA1, w.serviceA, startsAt]],
        ['select public.book_appointment($1, $2, $3, $4)', [w.patientB1, w.doctorA1, w.serviceA, startsAt]],
        ['select public.confirm_appointment($1)', [w.apptA1]],
        ["select public.cancel_appointment($1, 'clinic_request')", [w.apptA1]],
        ['select public.reschedule_appointment($1, $2)', [w.apptA1, startsAt]],
        ['select public.mark_no_show($1)', [w.apptA1]],
        ['select * from public.get_available_slots($1, $2, $3::date, $3::date)', [w.doctorA1, w.serviceA, w.day]],
      ];
      for (const [sql, params] of commands) {
        const err = await failure(db, sql, params);
        expect(err.message, sql).toBe('NOT_FOUND');
      }
      await actAs(db, asUser(w.users.ownerB));
      expect((await failure(db, "select * from public.invite_member($1, 'x@example.test', 'receptionist')", [w.clinicA])).message)
        .toBe('NOT_FOUND');
    });
  });

  it('cannot book a patient of clinic B with a doctor of clinic B through a clinic A doctor id mix', async () => {
    await scenario(async (db, w) => {
      // Receptionist of A, patient of B: the patient check runs inside A and finds nothing.
      await actAs(db, asUser(w.users.receptionA));
      const startsAt = await localInstant(db, w.day, '11:00');
      const err = await failure(db, 'select public.book_appointment($1, $2, $3, $4)', [w.patientB1, w.doctorA1, w.serviceA, startsAt]);
      expect(err.message).toBe('NOT_FOUND');
    });
  });
});

describe('database-level tenant consistency (even for privileged code)', () => {
  it('rejects cross-tenant references through composite foreign keys', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      const s = await localInstant(db, w.day, '12:00');
      const e = await localInstant(db, w.day, '12:20');
      const cases: Array<[string, unknown[]]> = [
        // appointment in A with a patient of B
        [`insert into public.appointments (clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, source, price_mad)
          values ($1, $2, $3, $4, $5, $6, 'confirmed', 'staff', 0)`, [w.clinicA, w.patientB1, w.doctorA1, w.serviceA, s, e]],
        // appointment in A with a doctor of B
        [`insert into public.appointments (clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, source, price_mad)
          values ($1, $2, $3, $4, $5, $6, 'confirmed', 'staff', 0)`, [w.clinicA, w.patientA1, w.doctorB1, w.serviceA, s, e]],
        // doctor_services pairing a doctor of A with a service of B
        ['insert into public.doctor_services (clinic_id, doctor_id, service_id) values ($1, $2, $3)', [w.clinicA, w.doctorA1, w.serviceB]],
        // doctor of A linked to a login that is only a member of B
        ["insert into public.doctors (clinic_id, user_id, full_name) values ($1, $2, 'Cross link')", [w.clinicA, w.users.receptionB]],
        // consent in A for a patient of B
        ["insert into public.patient_consents (clinic_id, patient_id, purpose, granted, document_version, source) values ($1, $2, 'reminders_sms', true, 'v1', 'paper')", [w.clinicA, w.patientB1]],
        // portal link in A to a patient of B
        ["insert into public.patient_accounts (user_id, clinic_id, patient_id, relationship, linked_via) values ($1, $2, $3, 'self', 'staff')", [w.users.patientAccount, w.clinicA, w.patientB1]],
      ];
      for (const [sql, params] of cases) {
        const err = await failure(db, sql, params);
        expect(err.code, sql).toBe('23503');
      }
    });
  });

  it('rejects an appointment for a service the doctor does not provide', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      const err = await failure(db,
        `insert into public.appointments (clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, source, price_mad)
         values ($1, $2, $3, $4, $5, $6, 'confirmed', 'staff', 0)`,
        [w.clinicA, w.patientA1, w.doctorA1, w.serviceA2, await localInstant(db, w.day, '12:00'), await localInstant(db, w.day, '12:30')]);
      expect(err.code).toBe('23503');
    });
  });

  it('never lets a row move to another tenant', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      for (const table of ['services', 'doctors', 'patients', 'clinic_members', 'doctor_time_off']) {
        const err = await failure(db, `update public.${table} set clinic_id = $1 where clinic_id = $2`, [w.clinicB, w.clinicA]);
        expect(['TENANT_IMMUTABLE', 'APPOINTMENT_FIELD_IMMUTABLE'], `${table}: ${err.message}`).toContain(err.message);
      }
    });
  });
});
