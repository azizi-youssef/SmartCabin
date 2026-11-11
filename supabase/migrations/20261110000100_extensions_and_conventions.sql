-- SmartClinic 0001 — extensions, schemas, privileges, enum types, shared trigger functions.
-- Additive only. See docs/DATABASE_SCHEMA.md.

-- ---------------------------------------------------------------------------
-- Extensions (Supabase keeps extensions in the `extensions` schema)
-- ---------------------------------------------------------------------------
create extension if not exists btree_gist with schema extensions;  -- uuid/text "=" inside exclusion constraints
create extension if not exists citext     with schema extensions;  -- case-insensitive email and slug
create extension if not exists pg_trgm    with schema extensions;  -- patient name search
create extension if not exists pgcrypto   with schema extensions;  -- random tokens, digests

-- ---------------------------------------------------------------------------
-- private schema: helpers and internal tables. Never exposed through the Data API.
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;
-- RLS policies call a few helpers from `private`; the roles need USAGE to resolve them.
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------------
-- Secure-by-default privileges: objects created by `postgres` grant nothing to the
-- Data API roles until a migration grants it explicitly.
-- ---------------------------------------------------------------------------
alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema private revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema private revoke all on functions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Enumerated types (values can be added later, never removed: keep them minimal)
-- ---------------------------------------------------------------------------
create type public.clinic_role          as enum ('clinic_owner', 'clinic_admin', 'doctor', 'receptionist', 'accountant');
create type public.member_status        as enum ('active', 'suspended', 'removed');
create type public.clinic_status        as enum ('pending_approval', 'active', 'suspended', 'closed');
create type public.catalog_status       as enum ('active', 'archived');
create type public.doctor_status        as enum ('active', 'inactive');
create type public.time_off_reason      as enum ('leave', 'training', 'sick', 'personal', 'other');
create type public.sex                  as enum ('female', 'male');
create type public.contact_channel      as enum ('sms', 'whatsapp', 'email', 'none');
create type public.patient_status       as enum ('active', 'archived', 'merged');
create type public.patient_origin       as enum ('reception', 'online', 'walk_in', 'import');
create type public.patient_relationship as enum ('self', 'child', 'other_dependent');
create type public.link_origin          as enum ('online_booking', 'staff');
create type public.consent_purpose      as enum ('data_processing', 'reminders_sms', 'reminders_whatsapp', 'reminders_email');
create type public.consent_source       as enum ('online', 'reception', 'paper');
create type public.appointment_status   as enum ('pending', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show');
create type public.appointment_source   as enum ('staff', 'online', 'walk_in');
create type public.cancellation_actor   as enum ('patient', 'clinic', 'system');
create type public.cancellation_reason  as enum ('patient_request', 'clinic_request', 'doctor_unavailable', 'duplicate',
                                                 'left_before_consultation', 'not_confirmed_in_time', 'other');
create type public.history_event        as enum ('created', 'status_changed', 'rescheduled', 'details_changed');
create type public.actor_type           as enum ('user', 'patient', 'platform_admin', 'system');
create type public.legal_kind           as enum ('terms_of_service', 'privacy_policy', 'clinic_dpa', 'patient_privacy_notice');
create type public.acceptance_context   as enum ('signup', 'clinic_creation', 'online_booking');

-- ---------------------------------------------------------------------------
-- Shared trigger functions
-- ---------------------------------------------------------------------------

-- Maintains updated_at on every UPDATE.
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- BR-T-01: a row never moves to another tenant.
create function private.forbid_clinic_id_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.clinic_id is distinct from old.clinic_id then
    raise exception using errcode = 'P0001', message = 'TENANT_IMMUTABLE',
      detail = format('%I.clinic_id cannot change', tg_table_name);
  end if;
  return new;
end;
$$;

-- Append-only guard for log tables (defense in depth on top of revoked privileges).
create function private.forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = 'APPEND_ONLY',
    detail = format('%I is append-only', tg_table_name);
end;
$$;

-- Raises a domain error. Codes are stable (docs/API_SPECIFICATION.md §4.2).
create function private.raise_error(p_code text, p_detail text default null, p_errcode text default 'P0001')
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = p_errcode, message = p_code, detail = coalesce(p_detail, '');
end;
$$;
