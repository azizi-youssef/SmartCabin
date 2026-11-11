import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { actAs, asPostgres, asUser, createPool, failure, one, withRollback, type Db } from './helpers/db';
import { createWorld, type World } from './helpers/fixtures';

/** Module 3 — doctor management (migration 0017 + managed-table RLS). */
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

async function offerings(db: Db, doctorId: string) {
  await actAs(db, asPostgres);
  return (await db.query<{ service_id: string; is_active: boolean; duration_minutes: number | null; price_mad: string | null }>(
    'select service_id, is_active, duration_minutes, price_mad from public.doctor_services where doctor_id = $1 order by service_id', [doctorId])).rows;
}

describe('doctor records', () => {
  it('lets admins create a doctor without a login, and link one only to a member of the same clinic', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.adminA));
      const created = await one<{ id: string }>(db, "insert into public.doctors (clinic_id, full_name) values ($1, 'Dr Sans Compte') returning id", [w.clinicA]);
      expect(created.id).toBeTruthy();
      // receptionA is a member of A: linking works.
      expect((await db.query('update public.doctors set user_id = $2 where id = $1', [created.id, w.users.receptionA])).rowCount).toBe(1);
      // receptionB is not a member of A: composite FK rejects the link.
      expect((await failure(db, 'update public.doctors set user_id = $2 where id = $1', [created.id, w.users.receptionB])).code).toBe('23503');
    });
  });

  it('refuses doctor management to receptionists and doctors', async () => {
    await scenario(async (db, w) => {
      for (const who of ['receptionA', 'doctorA'] as const) {
        await actAs(db, asUser(w.users[who]));
        expect((await failure(db, "insert into public.doctors (clinic_id, full_name) values ($1, 'Dr X')", [w.clinicA])).code, who).toBe('42501');
        expect((await db.query("update public.doctors set full_name = 'Renamed' where id = $1", [w.doctorA1])).rowCount, who).toBe(0);
      }
    });
  });
});

describe('set_doctor_services', () => {
  it('replaces the offered services atomically, deactivating (not deleting) unselected ones', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.adminA));
      await db.query('select public.set_doctor_services($1, $2::jsonb)', [
        w.doctorA2,
        JSON.stringify([{ service_id: w.serviceA2, duration_minutes: 45, price_mad: '400.00', online_bookable: false }]),
      ]);
      const rows = await offerings(db, w.doctorA2);
      expect(rows.find((r) => r.service_id === w.serviceA2)).toMatchObject({ is_active: true, duration_minutes: 45, price_mad: '400.00' });
      // serviceA was offered and has an appointment: kept as an inactive row, not deleted.
      expect(rows.find((r) => r.service_id === w.serviceA)).toMatchObject({ is_active: false });
    });
  });

  it('rolls back entirely when one item is invalid', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.adminA));
      const before = await offerings(db, w.doctorA2);
      await actAs(db, asUser(w.users.adminA));
      const err = await failure(db, 'select public.set_doctor_services($1, $2::jsonb)', [
        w.doctorA2,
        JSON.stringify([{ service_id: w.serviceA2 }, { service_id: w.serviceA, duration_minutes: 7 }]),
      ]);
      expect(err.code).toBe('23514');
      expect(await offerings(db, w.doctorA2)).toEqual(before);
    });
  });

  it('rejects services of another clinic and callers without doctors.manage', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.adminA));
      expect((await failure(db, 'select public.set_doctor_services($1, $2::jsonb)', [w.doctorA1, JSON.stringify([{ service_id: w.serviceB }])])).message).toBe('NOT_FOUND');
      await actAs(db, asUser(w.users.receptionA));
      expect((await failure(db, 'select public.set_doctor_services($1, $2::jsonb)', [w.doctorA1, '[]'])).message).toBe('FORBIDDEN');
      await actAs(db, asUser(w.users.ownerB));
      expect((await failure(db, 'select public.set_doctor_services($1, $2::jsonb)', [w.doctorA1, '[]'])).message).toBe('NOT_FOUND');
    });
  });
});

describe('count_future_appointments', () => {
  it('counts the doctor future pending/confirmed appointments for managers', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.adminA));
      expect((await one<{ n: number }>(db, 'select public.count_future_appointments($1) as n', [w.doctorA2])).n).toBe(1);
      await actAs(db, asUser(w.users.receptionA));
      expect((await failure(db, 'select public.count_future_appointments($1)', [w.doctorA2])).message).toBe('FORBIDDEN');
    });
  });
});
