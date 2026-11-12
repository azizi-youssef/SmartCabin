import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { createPool } from './helpers/db';

/**
 * Application ↔ database contract (quality audit, 2026-11-11).
 *
 * The Supabase client is untyped (types cannot be generated without Docker), so a misspelled
 * RPC parameter, a renamed column or a missing column grant would only fail at runtime. This
 * test extracts every `.rpc(...)` call and every `.from(table)` chain from src/ and checks them
 * against the migrated schema, including the privileges of the `authenticated` role (all app
 * queries run with the user's session).
 */
const SRC = fileURLToPath(new URL('../../src', import.meta.url));

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Returns the text between the bracket at `open` and its match (exclusive), skipping strings. */
function balanced(text: string, open: number): string {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < text.length && text.charAt(i) !== quote) i += text.charAt(i) === String.fromCharCode(92) ? 2 : 1;
      continue;
    }
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error(`Unbalanced bracket at ${open}`);
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    if ('({['.includes(ch)) depth++;
    if (')}]'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Keys of an object literal body; null when it contains a spread (keys unknown). */
function objectKeys(body: string): string[] | null {
  const keys: string[] = [];
  for (const part of splitTopLevel(body)) {
    if (part.startsWith('...')) return null;
    const m = /^([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(part);
    if (m?.[1]) keys.push(m[1]);
  }
  return keys;
}

interface Use {
  where: string;
  table: string;
  column: string;
  privilege: 'SELECT' | 'INSERT' | 'UPDATE';
}
interface RpcUse {
  where: string;
  fn: string;
  keys: string[];
}
interface FkUse {
  where: string;
  name: string;
}

/** Parses a PostgREST select list (with embedded relations) into column uses. */
function parseSelect(where: string, table: string, list: string, uses: Use[], fks: FkUse[]): void {
  for (const item of splitTopLevel(list)) {
    const paren = item.indexOf('(');
    if (paren >= 0) {
      const head = item.slice(0, paren).replace(/^[\w]+:/, '');
      const [relTable, hint] = head.split('!');
      if (hint) fks.push({ where, name: hint });
      parseSelect(where, relTable ?? head, balanced(item, paren), uses, fks);
      continue;
    }
    const column = item.replace(/^[\w]+:/, '').replace(/::\w+$/, '').trim();
    if (column && column !== '*') uses.push({ where, table, column, privilege: 'SELECT' });
  }
}

function extract(): { rpcs: RpcUse[]; uses: Use[]; fks: FkUse[]; dynamicSelects: string[] } {
  const rpcs: RpcUse[] = [];
  const uses: Use[] = [];
  const fks: FkUse[] = [];
  const dynamicSelects: string[] = [];
  for (const file of files(SRC)) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(SRC, file);

    for (const m of text.matchAll(/\brpc\(\s*'([a-z_]+)'\s*(,\s*)?/g)) {
      const after = (m.index ?? 0) + m[0].length;
      const keys = m[2] && text.charAt(after) === '{' ? objectKeys(balanced(text, after)) : [];
      if (keys) rpcs.push({ where: rel, fn: m[1] ?? '', keys });
    }

    const froms = [...text.matchAll(/\.from\(\s*'([a-z_]+)'\s*\)/g)].map((m) => ({ table: m[1] ?? '', at: m.index ?? 0 }));
    const tableAt = (index: number): string | undefined => froms.filter((f) => f.at < index).at(-1)?.table;

    for (const m of text.matchAll(/\.select\(/g)) {
      const table = tableAt(m.index ?? 0);
      if (!table) continue;
      const args = balanced(text, (m.index ?? 0) + m[0].length - 1);
      const first = splitTopLevel(args)[0] ?? '';
      const literals = [...first.matchAll(/'([^']*)'/g)].map((x) => x[1]).join('');
      if (/[`$]/.test(first) || (!literals && first)) {
        dynamicSelects.push(`${rel}: ${first.slice(0, 60)}`);
        continue;
      }
      parseSelect(`${rel} (${table})`, table, literals || '*', uses, fks);
    }

    for (const m of text.matchAll(/\.(eq|neq|gt|gte|lt|lte|like|ilike|is|in|contains|order)\(\s*'([a-z_]+)'/g)) {
      const table = tableAt(m.index ?? 0);
      if (table) uses.push({ where: `${rel} (${table})`, table, column: m[2] ?? '', privilege: 'SELECT' });
    }

    for (const m of text.matchAll(/\.(insert|update|upsert)\(\s*\{/g)) {
      const table = tableAt(m.index ?? 0);
      if (!table) continue;
      const keys = objectKeys(balanced(text, (m.index ?? 0) + m[0].length - 1));
      for (const column of keys ?? []) {
        // An upsert needs INSERT, plus UPDATE when it resolves a conflict.
        uses.push({ where: `${rel} (${table})`, table, column, privilege: m[1] === 'update' ? 'UPDATE' : 'INSERT' });
      }
    }
  }
  return { rpcs, uses, fks, dynamicSelects };
}

let pool: pg.Pool;
let db: pg.PoolClient;
beforeAll(async () => {
  pool = createPool(1);
  db = await pool.connect();
});
afterAll(async () => {
  db.release();
  await pool.end();
});

describe('application to database contract', () => {
  const { rpcs, uses, fks, dynamicSelects } = extract();

  it('finds the calls it is meant to check', () => {
    expect(rpcs.length).toBeGreaterThan(20);
    expect(uses.length).toBeGreaterThan(60);
    expect(dynamicSelects).toEqual([]);
  });

  it('calls only existing functions, with existing parameter names, all required ones, and EXECUTE granted', async () => {
    const problems: string[] = [];
    for (const call of rpcs) {
      const fn = (await db.query<{ oid: number; args: string[] | null; required: number; exec: boolean }>(
        `select p.oid::int as oid,
                (select array_agg(n order by o) from unnest(p.proargnames, p.proargmodes::text[]) with ordinality as a(n, m, o)
                  where coalesce(m, 'i') in ('i', 'b')) as args,
                p.pronargs - p.pronargdefaults as required,
                -- Worker functions (jobs_*) are called by the job endpoint as anon, guarded by the job key.
                has_function_privilege(case when p.proname like 'jobs\_%' then 'anon' else 'authenticated' end, p.oid, 'EXECUTE') as exec
         from pg_proc p join pg_namespace s on s.oid = p.pronamespace
         where s.nspname = 'public' and p.proname = $1`, [call.fn])).rows;
      if (fn.length !== 1 || !fn[0]) {
        problems.push(`${call.where}: function public.${call.fn} not found (or overloaded: ${fn.length})`);
        continue;
      }
      const { required, exec } = fn[0];
      // proargmodes is NULL when every argument is IN; then proargnames lists inputs only.
      const args = fn[0].args ?? (await db.query<{ n: string[] | null }>(
        'select proargnames as n from pg_proc where oid = $1', [fn[0].oid])).rows[0]?.n ?? [];
      for (const key of call.keys) if (!args.includes(key)) problems.push(`${call.where}: ${call.fn} has no parameter ${key}`);
      for (const name of args.slice(0, required)) if (!call.keys.includes(name)) problems.push(`${call.where}: ${call.fn} misses required ${name}`);
      if (!exec) problems.push(`${call.where}: ${call.fn.startsWith('jobs_') ? 'anon' : 'authenticated'} cannot EXECUTE ${call.fn}`);
    }
    expect(problems).toEqual([]);
  });

  it('uses only existing columns that the authenticated role is granted', async () => {
    const problems = new Set<string>();
    for (const use of uses) {
      const row = (await db.query<{ exists: boolean; granted: boolean | null }>(
        `select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2) as exists,
                case when to_regclass('public.' || $1) is null then null
                     when not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2) then null
                     else has_column_privilege('authenticated', ('public.' || $1)::regclass, $2, $3) end as granted`,
        [use.table, use.column, use.privilege])).rows[0];
      if (!row?.exists) problems.add(`${use.where}: column ${use.table}.${use.column} does not exist`);
      else if (!row.granted) problems.add(`${use.where}: authenticated lacks ${use.privilege} on ${use.table}.${use.column}`);
    }
    expect([...problems]).toEqual([]);
  });

  it('names only existing foreign keys in embedded selects', async () => {
    const problems: string[] = [];
    for (const fk of fks) {
      const n = (await db.query('select 1 from pg_constraint where conname = $1 and contype = $2', [fk.name, 'f'])).rowCount;
      if (!n) problems.push(`${fk.where}: foreign key ${fk.name} not found`);
    }
    expect(problems).toEqual([]);
  });
});
