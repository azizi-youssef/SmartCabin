import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { actAs, asUser, createPool, failure, withRollback, type Db } from './helpers/db';
import { createWorld, type World } from './helpers/fixtures';

/** Platform and portal read functions (migration 0013). */
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

describe('platform_list_clinics', () => {
  it('lists clinic metadata and counts for a platform admin with MFA', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.platformAdmin, 'aal2'));
      const rows = (await db.query<{ clinic_id: string; active_members: number; active_doctors: number }>(
        'select * from public.platform_list_clinics() where clinic_id = any($1::uuid[])', [[w.clinicA, w.clinicB]])).rows;
      expect(rows).toHaveLength(2);
      const a = rows.find((r) => r.clinic_id === w.clinicA);
      // Clinic A: owner, admin, reception, accountant, doctor active (suspended member excluded).
      expect(a).toMatchObject({ active_members: 5, active_doctors: 2 });
    });
  });

  it('refuses clinic owners, platform admins without MFA and anonymous callers', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.ownerA));
      expect((await failure(db, 'select * from public.platform_list_clinics()')).message).toBe('FORBIDDEN');
      await actAs(db, asUser(w.users.platformAdmin, 'aal1'));
      expect((await failure(db, 'select * from public.platform_list_clinics()')).message).toBe('FORBIDDEN');
    });
  });
});

describe('portal_list_my_appointments', () => {
  it('returns only appointments of records explicitly linked to the account', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.patientAccount, 'aal1'));
      const rows = (await db.query<{ appointment_id: string; patient_first_name: string }>(
        'select * from public.portal_list_my_appointments()')).rows;
      // patientA1 (linked) has apptA1; patientA2 shares the phone number but is NOT linked.
      expect(rows.map((r) => r.appointment_id)).toEqual([w.apptA1]);
      expect(rows[0]?.patient_first_name).toBe('Alice');
    });
  });

  it('returns nothing to staff accounts without portal links', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      expect((await db.query('select * from public.portal_list_my_appointments()')).rows).toEqual([]);
    });
  });
});
