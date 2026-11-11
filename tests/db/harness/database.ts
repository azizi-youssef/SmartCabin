import { readdirSync, readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '../../..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const SEED = join(ROOT, 'supabase', 'seed.sql');
const SHIM = join(import.meta.dirname, 'supabase-shim.sql');

export interface TestDatabase {
  url: string;
  stop: () => Promise<void>;
}

/** Applies the Supabase shim, every migration in order, then the development seed. */
export async function migrate(url: string, log: (line: string) => void = () => undefined): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(readFileSync(SHIM, 'utf8'));
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      try {
        await client.query('begin');
        await client.query(readFileSync(join(MIGRATIONS, file), 'utf8'));
        await client.query('commit');
        log(`applied ${file}`);
      } catch (error) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
      }
    }
    try {
      await client.query(readFileSync(SEED, 'utf8'));
      log('applied seed.sql');
    } catch (error) {
      throw new Error(`seed.sql failed: ${(error as Error).message}`);
    }
  } finally {
    await client.end();
  }
}

/**
 * Fresh, throw-away PostgreSQL 17 cluster for one test run (no Docker): initdb in a temp
 * directory, start, create the database, migrate, seed. Deleted on stop.
 */
export async function startEmbeddedDatabase(port = 55432, log: (line: string) => void = () => undefined): Promise<TestDatabase> {
  const dir = mkdtempSync(join(tmpdir(), 'smartcabin-pg-'));
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--no-locale'],
    postgresFlags: ['-c', 'max_connections=60', '-c', 'shared_buffers=64MB', '-c', 'fsync=off', '-c', 'timezone=UTC'],
    onLog: () => undefined,
    onError: (message) => log(`[postgres] ${String(message)}`),
  });
  await server.initialise();
  await server.start();
  await server.createDatabase('smartcabin_test');
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/smartcabin_test`;
  await migrate(url, log);
  return {
    url,
    stop: async () => {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
