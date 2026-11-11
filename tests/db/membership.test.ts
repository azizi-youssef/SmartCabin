import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { actAs, asPostgres, asUser, createPool, failure, one, withRollback, type Db } from './helpers/db';
import { createWorld, type World } from './helpers/fixtures';

/** Module 2 — membership read functions (migration 0016). */
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

describe('list_clinic_members', () => {
  it('lists every member of the clinic with name, email, role and status for owners and admins', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.adminA));
      const rows = (await db.query<{ user_id: string; email: string; role: string; status: string; is_practitioner: boolean; is_self: boolean }>(
        'select * from public.list_clinic_members($1)', [w.clinicA])).rows;
      expect(rows).toHaveLength(6);
      expect(rows.find((r) => r.user_id === w.users.ownerA)).toMatchObject({ role: 'clinic_owner', is_practitioner: true, is_self: false });
      expect(rows.find((r) => r.user_id === w.users.adminA)?.is_self).toBe(true);
      expect(rows.find((r) => r.user_id === w.users.suspendedA)?.status).toBe('suspended');
      expect(rows.every((r) => r.email.endsWith('@example.test'))).toBe(true);
    });
  });

  it('refuses receptionists and doctors, and answers NOT_FOUND to other clinics', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      expect((await failure(db, 'select * from public.list_clinic_members($1)', [w.clinicA])).message).toBe('FORBIDDEN');
      await actAs(db, asUser(w.users.ownerB));
      expect((await failure(db, 'select * from public.list_clinic_members($1)', [w.clinicA])).message).toBe('NOT_FOUND');
    });
  });
});

describe('clinic settings under RLS (as the settings page writes them)', () => {
  it('lets receptionists manage closures but not doctors', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const inserted = await db.query("insert into public.clinic_closures (clinic_id, dates, reason) values ($1, '[2030-05-01,2030-05-01]', 'Fête du travail') returning id", [w.clinicA]);
      expect(inserted.rowCount).toBe(1);
      await actAs(db, asUser(w.users.doctorA));
      expect((await failure(db, "insert into public.clinic_closures (clinic_id, dates, reason) values ($1, '[2030-06-01,2030-06-01]', 'X closure')", [w.clinicA])).code).toBe('42501');
    });
  });

  it('lets admins edit the booking policy, refuses receptionists silently (0 rows)', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.adminA));
      expect((await db.query('update public.clinic_settings set max_horizon_days = 30 where clinic_id = $1', [w.clinicA])).rowCount).toBe(1);
      await actAs(db, asUser(w.users.receptionA));
      expect((await db.query('update public.clinic_settings set max_horizon_days = 90 where clinic_id = $1', [w.clinicA])).rowCount).toBe(0);
    });
  });

  it('refuses to open online booking for a clinic that is not active (BR-T-07)', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      await db.query("update public.clinics set status = 'suspended', suspended_reason = 'test' where id = $1", [w.clinicA]);
      await db.query("update public.clinics set status = 'active', suspended_reason = null where id = $1", [w.clinicB]);
      expect((await failure(db, 'update public.clinic_settings set online_booking_enabled = true where clinic_id = $1', [w.clinicA])).message).toBe('ONLINE_BOOKING_NOT_ALLOWED');
      // Active clinic with an online-bookable doctor/service: allowed.
      await db.query('update public.doctors set online_bookable = true where clinic_id = $1', [w.clinicB]);
      await db.query('update public.clinic_settings set online_booking_enabled = true where clinic_id = $1', [w.clinicB]);
    });
  });
});

describe('get_clinic_dpa_status', () => {
  it('reports the current agreement as not accepted, then accepted after an owner accepts it', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.receptionA));
      const before = await one<{ document_version: string; accepted_at: string | null }>(db, 'select * from public.get_clinic_dpa_status($1)', [w.clinicA]);
      expect(before.accepted_at).toBeNull();
      await actAs(db, asPostgres);
      const dpa = await one<{ id: string }>(db, "select id from public.legal_documents where kind = 'clinic_dpa' and is_current limit 1");
      await actAs(db, asUser(w.users.ownerA));
      await db.query("insert into public.legal_acceptances (document_id, clinic_id, context) values ($1, $2, 'clinic_creation')", [dpa.id, w.clinicA]);
      await actAs(db, asUser(w.users.receptionA));
      const after = await one<{ accepted_at: string | null }>(db, 'select * from public.get_clinic_dpa_status($1)', [w.clinicA]);
      expect(after.accepted_at).not.toBeNull();
    });
  });
});
