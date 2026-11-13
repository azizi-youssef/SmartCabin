import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { actAs, asPostgres, createPool, failure, withRollback } from './helpers/db';

/**
 * Audit SC-AUD-09: the development seed creates accounts with a published password, so it must
 * refuse any database but an empty local one (for example `supabase db reset --linked`, which
 * would run it on a remote project).
 */
const SEED = readFileSync(fileURLToPath(new URL('../../supabase/seed.sql', import.meta.url)), 'utf8');

let pool: pg.Pool;
beforeAll(() => {
  pool = createPool(1);
});
afterAll(async () => {
  await pool.end();
});

describe('development seed guard (SC-AUD-09)', () => {
  it('refuses a database holding a real (non-synthetic) account', async () => {
    await withRollback(pool, async (db) => {
      await actAs(db, asPostgres);
      await db.query(
        `insert into auth.users (id, aud, role, email, created_at, updated_at)
         values (gen_random_uuid(), 'authenticated', 'authenticated', 'someone@gmail.com', now(), now())`);
      expect((await failure(db, SEED)).message).toMatch(/^SEED_REFUSED: this database holds accounts that are not synthetic/);
    });
  });

  it('refuses a database that already holds clinics, even with test accounts only', async () => {
    await withRollback(pool, async (db) => {
      await actAs(db, asPostgres);
      // The test database was seeded once at start-up: its clinics are already there.
      expect((await failure(db, SEED)).message).toMatch(/^SEED_REFUSED: this database already holds clinics/);
    });
  });
});
