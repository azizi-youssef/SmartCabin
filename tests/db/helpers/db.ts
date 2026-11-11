import pg from 'pg';
import { inject } from 'vitest';

/**
 * Database test harness.
 *
 * Tests connect as `postgres` (to the embedded test database, or to the local Supabase database
 * when TEST_DATABASE_URL is set) and impersonate API callers the same way PostgREST does:
 * `SET LOCAL ROLE anon|authenticated` plus `request.jwt.claims`. RLS, grants and `auth.uid()`
 * therefore behave as for real API requests.
 */
export const DATABASE_URL = inject('databaseUrl');

// Keep timestamps as strings: tests compare instants computed by PostgreSQL itself.
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (value) => value);
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

export type Db = pg.PoolClient;

export function createPool(max = 4): pg.Pool {
  return new pg.Pool({ connectionString: DATABASE_URL, max });
}

export type Principal =
  | { kind: 'postgres' }
  | { kind: 'anon' }
  | { kind: 'user'; id: string; aal?: 'aal1' | 'aal2' };

export const asPostgres: Principal = { kind: 'postgres' };
export const asAnon: Principal = { kind: 'anon' };
export function asUser(id: string, aal: 'aal1' | 'aal2' = 'aal2'): Principal {
  return { kind: 'user', id, aal };
}

/** Switches the current transaction to the given principal (transaction-local settings). */
export async function actAs(db: Db, principal: Principal): Promise<void> {
  await db.query('reset role');
  if (principal.kind === 'postgres') {
    await db.query("select set_config('request.jwt.claims', '', true)");
    return;
  }
  if (principal.kind === 'anon') {
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'anon' })]);
    await db.query("select set_config('role', 'anon', true)");
    return;
  }
  const claims = { sub: principal.id, role: 'authenticated', aal: principal.aal ?? 'aal2' };
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  await db.query("select set_config('role', 'authenticated', true)");
}

/** Runs `fn` inside a transaction that is always rolled back. */
export async function withRollback<T>(pool: pg.Pool, fn: (db: Db) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('begin');
    return await fn(db);
  } finally {
    await db.query('rollback').catch(() => undefined);
    db.release();
  }
}

export interface PgFailure {
  code: string | undefined;
  message: string;
  detail: string | undefined;
}

/**
 * Runs a statement that is expected to fail, inside a savepoint so the surrounding test
 * transaction stays usable. Returns the error, or throws if the statement succeeded.
 */
export async function failure(db: Db, sql: string, params: unknown[] = []): Promise<PgFailure> {
  await db.query('savepoint expect_failure');
  try {
    await db.query(sql, params);
  } catch (error) {
    await db.query('rollback to savepoint expect_failure');
    const e = error as { code?: string; message: string; detail?: string };
    return { code: e.code, message: e.message, detail: e.detail };
  }
  await db.query('release savepoint expect_failure');
  throw new Error(`Expected failure but statement succeeded: ${sql}`);
}

/** Runs a statement inside a savepoint; returns affected rows (for "0 rows" RLS checks). */
export async function rowCount(db: Db, sql: string, params: unknown[] = []): Promise<number> {
  const result = await db.query(sql, params);
  return result.rowCount ?? 0;
}

export async function one<T extends pg.QueryResultRow>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const result = await db.query<T>(sql, params);
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined) {
    throw new Error(`Expected exactly one row, got ${result.rows.length}: ${sql}`);
  }
  return row;
}

export async function count(db: Db, sql: string, params: unknown[] = []): Promise<number> {
  const row = await one<{ n: number }>(db, `select count(*)::int as n from (${sql}) as q`, params);
  return row.n;
}
