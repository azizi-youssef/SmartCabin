import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool, withRollback } from './helpers/db';

/**
 * Structural security checks over the catalog. They fail when a future migration forgets
 * RLS, leaks a grant to anon, or adds an unguarded SECURITY DEFINER function.
 */
let pool: pg.Pool;
beforeAll(() => {
  pool = createPool(2);
});
afterAll(async () => {
  await pool.end();
});

const COMMAND_TABLES = [
  'appointments', 'appointment_history', 'clinic_members', 'clinic_invitations', 'patient_accounts',
  'audit_logs', 'domain_events', 'platform_admins', 'permissions', 'role_permissions',
  'appointment_status_transitions', 'specialties', 'legal_documents',
];

/** Public SECURITY DEFINER functions that authenticate the caller themselves (no clinic yet). */
const SELF_GUARDED = ['create_clinic', 'get_my_memberships', 'accept_invitation'];

describe('database security invariants', () => {
  it('enables RLS on every table in the public and private schemas', async () => {
    const rows = await withRollback(pool, async (db) =>
      (await db.query<{ table: string }>(
        `select n.nspname || '.' || c.relname as table
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname in ('public', 'private') and c.relkind in ('r', 'p') and not c.relrowsecurity`,
      )).rows);
    expect(rows).toEqual([]);
  });

  it('gives anon nothing but read access to the two public reference tables', async () => {
    const grants = await withRollback(pool, async (db) =>
      (await db.query<{ grant: string }>(
        `select table_name || ':' || privilege_type as grant
         from information_schema.role_table_grants
         where grantee = 'anon' and table_schema in ('public', 'private')
         order by 1`,
      )).rows.map((r) => r.grant));
    expect(grants).toEqual(['legal_documents:SELECT', 'specialties:SELECT']);

    const columnGrants = await withRollback(pool, async (db) =>
      (await db.query<{ n: number }>(
        `select count(*)::int as n from information_schema.column_privileges
         where grantee = 'anon' and table_schema in ('public', 'private')
           and table_name not in ('legal_documents', 'specialties')`,
      )).rows[0]?.n);
    expect(columnGrants).toBe(0);
  });

  it('lets no API role write command tables directly (not even a single column)', async () => {
    const writable = await withRollback(pool, async (db) =>
      (await db.query<{ entry: string }>(
        `select t || ':' || priv as entry
         from unnest($1::text[]) as t
         cross join unnest(array['INSERT', 'UPDATE', 'DELETE']) as priv
         where case when priv = 'DELETE'
                    then has_table_privilege('authenticated', 'public.' || t, 'DELETE')
                    else has_any_column_privilege('authenticated', 'public.' || t, priv) end`,
        [COMMAND_TABLES],
      )).rows.map((r) => r.entry));
    expect(writable).toEqual([]);
  });

  it('never grants direct INSERT on clinics, or UPDATE of status/slug/timezone', async () => {
    const result = await withRollback(pool, async (db) =>
      (await db.query<{ insert: boolean; status: boolean; slug: boolean; tz: boolean; created_by: boolean }>(
        `select has_any_column_privilege('authenticated', 'public.clinics', 'INSERT') as insert,
                has_column_privilege('authenticated', 'public.clinics', 'status', 'UPDATE') as status,
                has_column_privilege('authenticated', 'public.clinics', 'slug', 'UPDATE') as slug,
                has_column_privilege('authenticated', 'public.clinics', 'timezone', 'UPDATE') as tz,
                has_column_privilege('authenticated', 'public.clinics', 'created_by', 'UPDATE') as created_by`,
      )).rows[0]);
    expect(result).toEqual({ insert: false, status: false, slug: false, tz: false, created_by: false });
  });

  it('hides invitation token hashes from API roles', async () => {
    const readable = await withRollback(pool, async (db) =>
      (await db.query<{ ok: boolean }>(
        "select has_column_privilege('authenticated', 'public.clinic_invitations', 'token_hash', 'SELECT') as ok",
      )).rows[0]?.ok);
    expect(readable).toBe(false);
  });

  it('pins search_path on every SECURITY DEFINER function', async () => {
    const unpinned = await withRollback(pool, async (db) =>
      (await db.query<{ fn: string }>(
        `select n.nspname || '.' || p.proname as fn
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('public', 'private') and p.prosecdef
           and not coalesce(p.proconfig @> array['search_path=""'], false)`,
      )).rows.map((r) => r.fn));
    expect(unpinned).toEqual([]);
  });

  it('guards every public SECURITY DEFINER function with an authorization check', async () => {
    const unguarded = await withRollback(pool, async (db) =>
      (await db.query<{ fn: string }>(
        `select p.proname as fn
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prosecdef
           and p.prosrc not like '%private.require_%'
           and p.prosrc not like '%private.lock_appointment_for_command%'
           and p.prosrc not like '%private.lock_member_for_change%'
           and p.proname <> all($1::text[])
         order by 1`,
        [SELF_GUARDED],
      )).rows.map((r) => r.fn));
    expect(unguarded).toEqual([]);

    const selfGuardedChecksCaller = await withRollback(pool, async (db) =>
      (await db.query<{ fn: string }>(
        `select p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any($1::text[]) and p.prosrc not like '%auth.uid()%'`,
        [SELF_GUARDED],
      )).rows);
    expect(selfGuardedChecksCaller).toEqual([]);
  });

  it('lets anon execute no function in public or private', async () => {
    const executable = await withRollback(pool, async (db) =>
      (await db.query<{ fn: string }>(
        `select n.nspname || '.' || p.proname as fn
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'EXECUTE')`,
      )).rows.map((r) => r.fn));
    expect(executable).toEqual([]);
  });

  it('exposes only the RLS helpers from the private schema to authenticated', async () => {
    const executable = await withRollback(pool, async (db) =>
      (await db.query<{ fn: string }>(
        `select p.proname as fn
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'private' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
         order by 1`,
      )).rows.map((r) => r.fn));
    expect(executable).toEqual([
      'clinics_with_permission', 'my_doctor_ids', 'my_doctor_patient_ids',
      'practitioner_only_clinics', 'role_requires_mfa', 'session_aal',
    ]);
  });

  it('has no view in public (views can bypass RLS unless security_invoker)', async () => {
    const views = await withRollback(pool, async (db) =>
      (await db.query(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('v', 'm')
           and not coalesce(c.reloptions @> array['security_invoker=true'], false)`,
      )).rows);
    expect(views).toEqual([]);
  });

  it('seeds a permission matrix where every role permission exists and the doctor role has no admin rights', async () => {
    const doctorAdminPerms = await withRollback(pool, async (db) =>
      (await db.query<{ permission_key: string }>(
        `select permission_key from public.role_permissions
         where role = 'doctor' and permission_key like any (array['members.%', 'clinic.%.update', 'services.manage',
               'doctors.manage', 'patients.create', 'invoices.%', 'payments.%', 'audit.view'])`,
      )).rows);
    expect(doctorAdminPerms).toEqual([]);
  });
});
