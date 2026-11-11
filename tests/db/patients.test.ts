import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { actAs, asPostgres, asUser, count, createPool, failure, one, withRollback, type Db } from './helpers/db';
import { createWorld, type World } from './helpers/fixtures';

/** Module 4 — patient management commands (migration 0018). */
let pool: pg.Pool;
beforeAll(() => {
  pool = createPool(2);
});
afterAll(async () => {
  await pool.end();
});

async function scenario(fn: (db: Db, w: World) => Promise<void>): Promise<void> {
  await withRollback(pool, async (db) => fn(db, await createWorld(db)));
}

const patient = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ first_name: 'Nadia', last_name: 'Test', phone_e164: '+99944444444', preferred_locale: 'ar', preferred_channel: 'sms', ...overrides });
const consents = JSON.stringify([
  { purpose: 'data_processing', granted: true },
  { purpose: 'reminders_sms', granted: false },
]);

describe('register_patient', () => {
  it('creates the record and its consents in one transaction', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const created = await one<{ patient_id: string; file_number: string }>(db, 'select * from public.register_patient($1, $2::jsonb, $3::jsonb)', [w.clinicA, patient(), consents]);
      expect(created.file_number).toBe('P000003');
      expect(await count(db, 'select 1 from public.patient_consents where patient_id = $1', [created.patient_id])).toBe(2);
    });
  });

  it('leaves nothing behind when a consent is invalid', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const bad = JSON.stringify([{ purpose: 'data_processing', granted: true }, { purpose: 'marketing', granted: true }]);
      expect((await failure(db, 'select * from public.register_patient($1, $2::jsonb, $3::jsonb)', [w.clinicA, patient(), bad])).code).toBe('22P02');
      await actAs(db, asPostgres);
      expect(await count(db, "select 1 from public.patients where clinic_id = $1 and first_name = 'Nadia'", [w.clinicA])).toBe(0);
    });
  });

  it('refuses doctors, other clinics and the online origin', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.doctorA));
      expect((await failure(db, 'select * from public.register_patient($1, $2::jsonb)', [w.clinicA, patient()])).message).toBe('FORBIDDEN');
      await actAs(db, asUser(w.users.receptionB));
      expect((await failure(db, 'select * from public.register_patient($1, $2::jsonb)', [w.clinicA, patient()])).message).toBe('NOT_FOUND');
      await actAs(db, asUser(w.users.receptionA));
      expect((await failure(db, 'select * from public.register_patient($1, $2::jsonb)', [w.clinicA, patient({ created_via: 'online' })])).message).toBe('VALIDATION_FAILED');
    });
  });
});

describe('get_patient', () => {
  it('returns the record and writes patient.viewed to the audit log', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const row = await one<{ id: string; first_name: string }>(db, 'select id, first_name from public.get_patient($1)', [w.patientA1]);
      expect(row.first_name).toBe('Alice');
      await actAs(db, asPostgres);
      const audit = await one<{ actor_user_id: string; changed_fields: string[] }>(db,
        "select actor_user_id, changed_fields from public.audit_logs where action = 'patient.viewed' and entity_id = $1", [w.patientA1]);
      expect(audit.actor_user_id).toBe(w.users.receptionA);
      expect(audit.changed_fields).toEqual([]);
    });
  });

  it('limits practitioner-only doctors to their own patients', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.doctorA));
      expect((await one<{ id: string }>(db, 'select id from public.get_patient($1)', [w.patientA1])).id).toBe(w.patientA1);
      expect((await failure(db, 'select * from public.get_patient($1)', [w.patientA2])).message).toBe('NOT_FOUND');
      await actAs(db, asUser(w.users.accountantA));
      expect((await failure(db, 'select * from public.get_patient($1)', [w.patientA1])).message).toBe('FORBIDDEN');
    });
  });
});

describe('archive, duplicates and merge', () => {
  it('archives and restores a record (admins only)', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      expect((await failure(db, 'select public.set_patient_archived($1, true)', [w.patientA2])).message).toBe('FORBIDDEN');
      await actAs(db, asUser(w.users.adminA));
      await db.query('select public.set_patient_archived($1, true)', [w.patientA2]);
      expect((await one<{ status: string }>(db, 'select status from public.patients where id = $1', [w.patientA2])).status).toBe('archived');
      await db.query('select public.set_patient_archived($1, false)', [w.patientA2]);
      expect((await one<{ status: string; archived_at: string | null }>(db, 'select status, archived_at from public.patients where id = $1', [w.patientA2]))).toEqual({ status: 'active', archived_at: null });
    });
  });

  it('lists records sharing the phone number as possible duplicates', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.adminA));
      const rows = (await db.query<{ patient_id: string; reason: string }>('select patient_id, reason from public.list_patient_duplicates($1)', [w.patientA1])).rows;
      expect(rows).toEqual([{ patient_id: w.patientA2, reason: 'phone' }]);
    });
  });

  it('merges a duplicate: source becomes history, portal links move to the target', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.adminA));
      await db.query('select public.merge_patients($1, $2)', [w.patientA1, w.patientA2]);
      await actAs(db, asPostgres);
      expect(await one(db, 'select status, merged_into_id from public.patients where id = $1', [w.patientA1])).toEqual({ status: 'merged', merged_into_id: w.patientA2 });
      expect(await count(db, 'select 1 from public.patient_accounts where patient_id = $1 and revoked_at is null', [w.patientA2])).toBe(1);
      // History stays attached to the original record.
      expect(await count(db, 'select 1 from public.appointments where id = $1 and patient_id = $2', [w.apptA1, w.patientA1])).toBe(1);
      await actAs(db, asUser(w.users.adminA));
      expect((await failure(db, 'select public.merge_patients($1, $2)', [w.patientA1, w.patientA2])).message).toBe('VALIDATION_FAILED');
      expect((await failure(db, 'select public.merge_patients($1, $2)', [w.patientA2, w.patientB1])).message).toBe('NOT_FOUND');
    });
  });
});
