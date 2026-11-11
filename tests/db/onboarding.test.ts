import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { actAs, asAnon, asPostgres, asUser, count, createPool, failure, one, withRollback, type Db } from './helpers/db';
import { acceptCurrentTerms, createWorld, type World } from './helpers/fixtures';

/** Module 1 — onboarding rules enforced in the database (migration 0015). */
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

describe('create_clinic and legal acceptance', () => {
  it('refuses to create a clinic before the terms and privacy policy are accepted', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asUser(w.users.outsider, 'aal1'));
      expect((await failure(db, "select public.create_clinic('Cabinet Test', 'cabinet-test-legal', 'Nador')")).message).toBe('LEGAL_ACCEPTANCE_REQUIRED');
    });
  });

  it('requires both documents, then creates the clinic', async () => {
    await scenario(async (db, w) => {
      await acceptCurrentTerms(db, w.users.outsider, ['terms_of_service']);
      await actAs(db, asUser(w.users.outsider, 'aal1'));
      expect((await failure(db, "select public.create_clinic('Cabinet Test', 'cabinet-test-legal', 'Nador')")).message).toBe('LEGAL_ACCEPTANCE_REQUIRED');
      await acceptCurrentTerms(db, w.users.outsider, ['privacy_policy']);
      await actAs(db, asUser(w.users.outsider, 'aal1'));
      const created = await one<{ create_clinic: string }>(db, "select public.create_clinic('Cabinet Test', 'cabinet-test-legal', 'Nador')");
      expect(created.create_clinic).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  it('records acceptances only for the caller', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      const doc = await one<{ id: string }>(db, "select id from public.legal_documents where kind = 'terms_of_service' and is_current limit 1");
      await actAs(db, asUser(w.users.outsider, 'aal1'));
      // user_id is not a grantable column: it always comes from the session.
      expect((await failure(db, "insert into public.legal_acceptances (document_id, user_id, context) values ($1, $2, 'signup')", [doc.id, w.users.ownerB])).code).toBe('42501');
      await db.query("insert into public.legal_acceptances (document_id, context) values ($1, 'signup')", [doc.id]);
      expect(await count(db, 'select 1 from public.legal_acceptances where user_id = $1', [w.users.outsider])).toBe(1);
      // Acceptances are append-only.
      await actAs(db, asPostgres);
      expect((await failure(db, 'delete from public.legal_acceptances where user_id = $1', [w.users.outsider])).message).toBe('APPEND_ONLY');
    });
  });

  it('lets only an MFA-verified owner accept the clinic data processing agreement', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      const dpa = await one<{ id: string }>(db, "select id from public.legal_documents where kind = 'clinic_dpa' and is_current limit 1");
      const insert = "insert into public.legal_acceptances (document_id, clinic_id, context) values ($1, $2, 'clinic_creation')";
      await actAs(db, asUser(w.users.receptionA));
      expect((await failure(db, insert, [dpa.id, w.clinicA])).code).toBe('42501');
      await actAs(db, asUser(w.users.ownerA, 'aal1'));
      expect((await failure(db, insert, [dpa.id, w.clinicA])).code).toBe('42501');
      await actAs(db, asUser(w.users.ownerA, 'aal2'));
      await db.query(insert, [dpa.id, w.clinicA]);
      expect(await count(db, 'select 1 from public.legal_acceptances where clinic_id = $1', [w.clinicA])).toBe(1);
    });
  });
});

describe('is_slug_available', () => {
  it('reports taken, reserved and malformed slugs as unavailable', async () => {
    await scenario(async (db, w) => {
      await actAs(db, asPostgres);
      const taken = await one<{ slug: string }>(db, 'select slug::text as slug from public.clinics where id = $1', [w.clinicA]);
      await actAs(db, asUser(w.users.outsider, 'aal1'));
      const check = async (slug: string) => (await one<{ ok: boolean }>(db, 'select public.is_slug_available($1) as ok', [slug])).ok;
      expect(await check(taken.slug)).toBe(false);
      expect(await check(taken.slug.toUpperCase())).toBe(false);
      expect(await check('admin')).toBe(false);
      expect(await check('a')).toBe(false);
      expect(await check('Cabinet Avec Espaces')).toBe(false);
      expect(await check(`cabinet-libre-${Date.now()}`)).toBe(true);
    });
  });

  it('is not callable anonymously', async () => {
    await scenario(async (db) => {
      await actAs(db, asAnon);
      expect((await failure(db, "select public.is_slug_available('cabinet-x')")).code).toBe('42501');
    });
  });
});
