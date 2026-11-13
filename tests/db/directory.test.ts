import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { actAs, asAnon, asPostgres, asUser, createPool, one, rowCount, withRollback, type Db } from './helpers/db';
import { createWorld, type World } from './helpers/fixtures';

/**
 * Public doctor directory (migration 0032, BR-P-04): a clinic appears only once its owner or
 * administrator agrees; only doctors open to online booking are listed, with the next free
 * online slot computed by the booking page's own rules; nothing about patients.
 */
let pool: pg.Pool;
beforeAll(() => {
  pool = createPool(2);
});
afterAll(async () => {
  await pool.end();
});

// The seed lists its demo clinics too: each test looks only at its own world's doctors.
const LIST = 'select * from public.public_list_directory_doctors() where doctor_id = any($1::uuid[])';
const mine = (w: World) => [[w.doctorA1, w.doctorA2, w.doctorB1]];

async function scenario(fn: (db: Db, w: World) => Promise<void>): Promise<void> {
  await withRollback(pool, async (db) => fn(db, await createWorld(db)));
}

/** Clinics A and B take online bookings; doctors A1 and B1 are bookable online; A1 is a cardiologist. */
async function openOnline(db: Db, w: World): Promise<void> {
  await actAs(db, asPostgres);
  await db.query('update public.doctors set online_bookable = true where id = any($1::uuid[])', [[w.doctorA1, w.doctorB1]]);
  await db.query("update public.doctors set specialty_id = (select id from public.specialties where code = 'cardiology') where id = $1", [w.doctorA1]);
  await db.query('update public.clinic_settings set online_booking_enabled = true where clinic_id = any($1::uuid[])', [[w.clinicA, w.clinicB]]);
}

async function listedDoctors(db: Db, w: World): Promise<string[]> {
  await actAs(db, asAnon);
  return (await db.query<{ doctor_id: string }>(LIST, mine(w))).rows.map((r) => r.doctor_id);
}

async function setListed(db: Db, user: string, clinic: string, listed: boolean): Promise<number> {
  await actAs(db, asUser(user));
  return rowCount(db, 'update public.clinic_settings set listed_in_directory = $2 where clinic_id = $1', [clinic, listed]);
}

describe('public doctor directory (BR-P-04)', () => {
  it('lists no clinic until its owner or administrator agrees; other roles cannot list it', async () => {
    await scenario(async (db, w) => {
      await openOnline(db, w);
      expect(await listedDoctors(db, w)).toEqual([]);

      expect(await setListed(db, w.users.receptionA, w.clinicA, true)).toBe(0); // RLS: no clinic.settings.update
      expect(await setListed(db, w.users.accountantA, w.clinicA, true)).toBe(0);
      expect(await setListed(db, w.users.ownerB, w.clinicA, true)).toBe(0); // another clinic's owner
      expect(await listedDoctors(db, w)).toEqual([]);

      expect(await setListed(db, w.users.adminA, w.clinicA, true)).toBe(1);
      expect(await listedDoctors(db, w)).toEqual([w.doctorA1]); // A2 is not bookable online; B has not agreed
      expect(await setListed(db, w.users.ownerA, w.clinicA, false)).toBe(1);
      expect(await listedDoctors(db, w)).toEqual([]);
    });
  });

  it('shows public profile data, the lowest online price and the next free slot, nothing else', async () => {
    await scenario(async (db, w) => {
      await openOnline(db, w);
      await setListed(db, w.users.ownerA, w.clinicA, true);
      await setListed(db, w.users.ownerB, w.clinicB, true);
      await actAs(db, asAnon);
      const rows = (await db.query<Record<string, unknown>>(LIST, mine(w))).rows;
      expect(rows.map((r) => r['doctor_id'])).toEqual([w.doctorA1, w.doctorB1]); // Cardiologie first, no specialty last
      expect(Object.keys(rows[0]!).sort()).toEqual([
        'clinic_address', 'clinic_city', 'clinic_name', 'clinic_slug', 'clinic_timezone', 'doctor_id', 'doctor_name',
        'doctor_name_ar', 'min_price_mad', 'next_slot_at', 'specialty_code', 'specialty_name_ar', 'specialty_name_fr',
      ]);
      expect(rows[0]).toMatchObject({ doctor_name: 'Doctor A1 (owner)', specialty_code: 'cardiology', specialty_name_fr: 'Cardiologie', clinic_name: 'Test Clinic A' });
      expect(Number(rows[0]!['min_price_mad'])).toBe(200);
      expect(rows[1]).toMatchObject({ specialty_code: null, specialty_name_fr: null });

      // The next slot is the first slot the booking page offers over the same 14 days.
      await actAs(db, asPostgres);
      const clinic = await one<{ slug: string; today: string }>(db,
        `select slug::text, to_char((now() at time zone timezone)::date, 'YYYY-MM-DD') as today from public.clinics where id = $1`, [w.clinicA]);
      await actAs(db, asAnon);
      const first = await one<{ s: string | null }>(db,
        'select min(slot_starts_at) as s from public.public_get_available_slots($1, $2, $3, $4::date, $4::date + 13)',
        [clinic.slug, w.doctorA1, w.serviceA, clinic.today]);
      expect(first.s).not.toBeNull();
      expect(new Date(String(rows[0]!['next_slot_at'])).toISOString()).toBe(new Date(String(first.s)).toISOString());
      expect(new Date(String(rows[0]!['next_slot_at'])).getTime()).toBeGreaterThan(Date.now());
    });
  });

  it('drops a doctor or clinic as soon as online booking stops', async () => {
    await scenario(async (db, w) => {
      await openOnline(db, w);
      await setListed(db, w.users.ownerA, w.clinicA, true);
      await setListed(db, w.users.ownerB, w.clinicB, true);
      expect(await listedDoctors(db, w)).toHaveLength(2);

      await actAs(db, asPostgres);
      await db.query('update public.clinic_settings set online_booking_enabled = false where clinic_id = $1', [w.clinicB]);
      expect(await listedDoctors(db, w)).toEqual([w.doctorA1]);

      await actAs(db, asPostgres);
      await db.query('update public.doctor_services set online_bookable = false where doctor_id = $1', [w.doctorA1]);
      expect(await listedDoctors(db, w)).toEqual([]); // no service left to book online

      await actAs(db, asPostgres);
      await db.query('update public.doctor_services set online_bookable = true where doctor_id = $1', [w.doctorA1]);
      await db.query("update public.clinics set status = 'suspended', suspended_reason = 'test' where id = $1", [w.clinicA]);
      expect(await listedDoctors(db, w)).toEqual([]);
    });
  });

  it('is readable without an account and by signed-in users alike', async () => {
    await scenario(async (db, w) => {
      await openOnline(db, w);
      await setListed(db, w.users.ownerA, w.clinicA, true);
      await actAs(db, asUser(w.users.outsider));
      expect((await db.query(LIST, mine(w))).rowCount).toBe(1);
      await actAs(db, asUser(w.users.patientAccount));
      expect((await db.query(LIST, mine(w))).rowCount).toBe(1);
    });
  });
});
