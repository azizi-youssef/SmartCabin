-- Minimal emulation of the Supabase platform objects that SmartCabin migrations depend on,
-- for running database tests on a plain PostgreSQL (embedded, no Docker).
-- Mirrors Supabase's definitions of roles, auth.uid()/auth.jwt() and default privileges.
-- NOT a migration: never applied to a Supabase project (which already provides these).

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
-- The role Supabase Auth runs its hooks as (migration 0030 grants it the before-user-created hook).
create role supabase_auth_admin nologin noinherit;
grant anon, authenticated, service_role to postgres;

create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Supabase grants Data API roles everything by default in public; SmartCabin's first
-- migration revokes these defaults, so they must exist here for that code path to be tested.
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

-- Subset of GoTrue's auth.users used by migrations, seed and tests.
create table auth.users (
  instance_id            uuid,
  id                     uuid primary key,
  aud                    varchar(255),
  role                   varchar(255),
  email                  varchar(255),
  encrypted_password     varchar(255),
  email_confirmed_at     timestamptz,
  invited_at             timestamptz,
  confirmation_token     varchar(255),
  confirmation_sent_at   timestamptz,
  recovery_token         varchar(255),
  recovery_sent_at       timestamptz,
  email_change_token_new varchar(255),
  email_change           varchar(255),
  email_change_sent_at   timestamptz,
  last_sign_in_at        timestamptz,
  raw_app_meta_data      jsonb,
  raw_user_meta_data     jsonb,
  is_super_admin         boolean,
  created_at             timestamptz,
  updated_at             timestamptz,
  phone                  text unique default null,
  phone_confirmed_at     timestamptz,
  banned_until           timestamptz,
  deleted_at             timestamptz,
  is_anonymous           boolean not null default false
);
create unique index users_email_partial_key on auth.users (email) where email is not null;

create table auth.identities (
  provider_id     text not null,
  user_id         uuid not null references auth.users (id) on delete cascade,
  identity_data   jsonb not null,
  provider        text not null,
  last_sign_in_at timestamptz,
  created_at      timestamptz,
  updated_at      timestamptz,
  email           text generated always as (lower(identity_data ->> 'email')) stored,
  id              uuid primary key default gen_random_uuid(),
  unique (provider_id, provider)
);

create function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.role() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Realtime (minimal stand-in for Supabase Realtime's database interface)
-- realtime.send() records broadcasts in realtime.messages; realtime.topic() returns the topic a
-- client is authorizing for (set by tests through the realtime.topic setting). On Supabase,
-- private-channel authorization evaluates SELECT policies on realtime.messages the same way.
-- ---------------------------------------------------------------------------
create schema realtime;
grant usage on schema realtime to anon, authenticated, service_role;

create table realtime.messages (
  id          bigint generated always as identity primary key,
  topic       text not null,
  extension   text not null default 'broadcast',
  payload     jsonb,
  event       text,
  private     boolean default true,
  inserted_at timestamptz not null default now()
);
alter table realtime.messages enable row level security;
grant select on realtime.messages to authenticated;

create function realtime.topic() returns text
language sql stable as $$
  select nullif(current_setting('realtime.topic', true), '')
$$;
grant execute on function realtime.topic() to anon, authenticated, service_role;

create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
language sql volatile as $$
  insert into realtime.messages (topic, extension, payload, event, private) values (topic, 'broadcast', payload, event, private);
$$;
