import type { TestProject } from 'vitest/node';

import { startEmbeddedDatabase } from './harness/database';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * Database for the `db` test project:
 * - TEST_DATABASE_URL set → use that database as is (e.g. local Supabase after `supabase db reset`);
 * - otherwise → a fresh embedded PostgreSQL 17 with a Supabase shim, all migrations and the seed.
 */
export default async function setup(project: TestProject) {
  const external = process.env['TEST_DATABASE_URL'];
  if (external) {
    project.provide('databaseUrl', external);
    return undefined;
  }
  const database = await startEmbeddedDatabase(55432, (line) => console.warn(line));
  project.provide('databaseUrl', database.url);
  return async () => {
    await database.stop();
  };
}
