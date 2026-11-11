-- SmartCabin 0002 — Identity & Access and Tenancy tables (BC1, BC2).
-- Policies and grants are in 0009; command functions in 0011.

-- ---------------------------------------------------------------------------
-- clinics — the tenant
-- ---------------------------------------------------------------------------
create table public.clinics (
  id               uuid primary key default gen_random_uuid(),
  slug             extensions.citext not null,
  display_name     text not null,
  legal_name       text,
  city             text not null,
  address_line     text,
  phone_e164       text,
  email            extensions.citext,
  timezone         text not null default 'Africa/Casablanca',
  default_locale   text not null default 'fr',
  ice              text,
  logo_path        text,
  status           public.clinic_status not null default 'pending_approval',
  approved_at      timestamptz,
  approved_by      uuid references auth.users (id),
  suspended_reason text,
  closed_at        timestamptz,
  created_by       uuid not null references auth.users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint clinics_slug_key unique (slug),
  constraint clinics_slug_format check (slug::text ~ '^[a-z0-9](-?[a-z0-9]){2,40}$'),
  constraint clinics_slug_not_reserved check (slug::text not in
    ('admin', 'api', 'app', 'auth', 'platform', 'www', 'static', 'assets', 'login', 'register', 'book', 'me', 'w', 'c')),
  constraint clinics_display_name_length check (char_length(btrim(display_name)) between 2 and 120),
  constraint clinics_legal_name_length check (legal_name is null or char_length(legal_name) <= 200),
  constraint clinics_city_length check (char_length(btrim(city)) between 2 and 80),
  constraint clinics_address_length check (address_line is null or char_length(address_line) <= 300),
  constraint clinics_phone_format check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  constraint clinics_email_format check (email is null or email::text ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  constraint clinics_locale check (default_locale in ('fr', 'ar')),
  constraint clinics_ice_format check (ice is null or ice ~ '^[0-9]{15}$'),
  constraint clinics_logo_path check (logo_path is null or char_length(logo_path) <= 300),
  constraint clinics_approved_coherent check (status not in ('active', 'suspended') or approved_at is not null),
  constraint clinics_closed_coherent check ((status = 'closed') = (closed_at is not null)),
  constraint clinics_suspended_coherent check (status = 'suspended' or suspended_reason is null)
);
comment on table public.clinics is 'Tenant root. Status is changed only through platform commands.';

create index clinics_created_by_idx on public.clinics (created_by);

-- Rejects time-zone names PostgreSQL does not know (they would break every local-time computation).
create function private.validate_clinic_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'unknown time zone';
  end if;
  return new;
end;
$$;

create trigger clinics_validate_timezone
  before insert or update of timezone on public.clinics
  for each row execute function private.validate_clinic_timezone();
create trigger clinics_set_updated_at
  before update on public.clinics
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- clinic_settings — operational policy, 1:1 with clinics
-- ---------------------------------------------------------------------------
create table public.clinic_settings (
  clinic_id                   uuid primary key references public.clinics (id),
  online_booking_enabled      boolean not null default false,
  auto_confirm_online         boolean not null default false,
  min_lead_minutes            integer not null default 60,
  max_horizon_days            integer not null default 60,
  patient_cancel_cutoff_hours integer not null default 2,
  max_active_online_bookings  integer not null default 3,
  reminder_offsets_minutes    integer[] not null default '{1440}',
  checkin_grace_minutes       integer not null default 15,
  turn_approaching_positions  integer not null default 2,
  sms_sender_name             text,
  updated_by                  uuid references auth.users (id),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint clinic_settings_lead check (min_lead_minutes between 0 and 10080),
  constraint clinic_settings_horizon check (max_horizon_days between 1 and 365),
  constraint clinic_settings_cutoff check (patient_cancel_cutoff_hours between 0 and 168),
  constraint clinic_settings_max_active check (max_active_online_bookings between 1 and 20),
  constraint clinic_settings_reminders check (
    cardinality(reminder_offsets_minutes) <= 3
    and 30 <= all (reminder_offsets_minutes)
    and 10080 >= all (reminder_offsets_minutes)),
  constraint clinic_settings_grace check (checkin_grace_minutes between 0 and 120),
  constraint clinic_settings_turn check (turn_approaching_positions between 1 and 10),
  -- Neutral alphanumeric sender id (no specialty in the sender name, BR-N-05).
  constraint clinic_settings_sender check (sms_sender_name is null or sms_sender_name ~ '^[A-Za-z0-9 ]{3,11}$')
);

create trigger clinic_settings_set_updated_at
  before update on public.clinic_settings
  for each row execute function private.set_updated_at();
create trigger clinic_settings_tenant_immutable
  before update on public.clinic_settings
  for each row execute function private.forbid_clinic_id_change();

-- ---------------------------------------------------------------------------
-- user_profiles — application profile for every account (not tenant-scoped)
-- ---------------------------------------------------------------------------
create table public.user_profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text not null default '',
  phone_e164 text,
  locale     text not null default 'fr',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_profiles_name_length check (char_length(full_name) <= 120),
  constraint user_profiles_phone_format check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  constraint user_profiles_locale check (locale in ('fr', 'ar'))
);

create trigger user_profiles_set_updated_at
  before update on public.user_profiles
  for each row execute function private.set_updated_at();

-- Creates the profile when Supabase Auth creates an account.
create function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_locale text := new.raw_user_meta_data ->> 'locale';
  v_phone  text := case when new.phone ~ '^\+?[1-9][0-9]{7,14}$' then '+' || ltrim(new.phone, '+') end;
begin
  insert into public.user_profiles (id, full_name, phone_e164, locale)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120),
    v_phone,
    case when v_locale in ('fr', 'ar') then v_locale else 'fr' end)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- platform_admins — SUPER_ADMIN, deliberately not a clinic role (MD-18)
-- ---------------------------------------------------------------------------
create table public.platform_admins (
  user_id    uuid primary key references auth.users (id),
  granted_by uuid references auth.users (id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint platform_admins_revocation check (revoked_at is null or revoked_at >= granted_at)
);

-- ---------------------------------------------------------------------------
-- permissions / role_permissions — single source of truth for RBAC (seeded in 0008)
-- ---------------------------------------------------------------------------
create table public.permissions (
  key         text primary key,
  context     text not null,
  access      text not null,
  description text not null,
  constraint permissions_key_format check (key ~ '^[a-z_]+(\.[a-z_]+)+$'),
  constraint permissions_access check (access in ('read', 'write'))
);
comment on column public.permissions.access is
  'read permissions stay available while a clinic is suspended; write permissions do not.';

create table public.role_permissions (
  role           public.clinic_role not null,
  permission_key text not null references public.permissions (key),
  primary key (role, permission_key)
);

-- ---------------------------------------------------------------------------
-- clinic_members — membership with one administrative role (command table)
-- ---------------------------------------------------------------------------
create table public.clinic_members (
  id                uuid primary key default gen_random_uuid(),
  clinic_id         uuid not null references public.clinics (id),
  user_id           uuid not null references auth.users (id),
  role              public.clinic_role not null,
  status            public.member_status not null default 'active',
  invited_by        uuid references auth.users (id),
  joined_at         timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint clinic_members_clinic_user_key unique (clinic_id, user_id),
  constraint clinic_members_clinic_id_id_key unique (clinic_id, id)
);

create index clinic_members_user_active_idx on public.clinic_members (user_id) where status = 'active';

create trigger clinic_members_set_updated_at
  before update on public.clinic_members
  for each row execute function private.set_updated_at();
create trigger clinic_members_tenant_immutable
  before update on public.clinic_members
  for each row execute function private.forbid_clinic_id_change();

-- BR-T-04 / BR-M-04: a clinic that is not closed keeps at least one active owner.
-- Deferred to commit so that a swap (promote then demote) inside one transaction is allowed.
create function private.ensure_clinic_has_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid := coalesce(new.clinic_id, old.clinic_id);
begin
  if exists (select 1 from public.clinics c where c.id = v_clinic_id and c.status <> 'closed')
     and not exists (
       select 1 from public.clinic_members m
       where m.clinic_id = v_clinic_id and m.role = 'clinic_owner' and m.status = 'active') then
    raise exception using errcode = 'P0001', message = 'LAST_OWNER',
      detail = 'a clinic must keep at least one active owner';
  end if;
  return null;
end;
$$;

create constraint trigger clinic_members_keep_owner
  after update or delete on public.clinic_members
  deferrable initially deferred
  for each row execute function private.ensure_clinic_has_owner();

-- ---------------------------------------------------------------------------
-- clinic_invitations — single-use staff invitations (command table)
-- ---------------------------------------------------------------------------
create table public.clinic_invitations (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null references public.clinics (id),
  email       extensions.citext not null,
  role        public.clinic_role not null,
  token_hash  text not null,
  invited_by  uuid not null references auth.users (id),
  expires_at  timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id),
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  constraint clinic_invitations_token_hash_key unique (token_hash),
  constraint clinic_invitations_clinic_id_id_key unique (clinic_id, id),
  constraint clinic_invitations_email_format check (
    email::text ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email::text) <= 254),
  constraint clinic_invitations_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint clinic_invitations_expiry check (expires_at > created_at),
  constraint clinic_invitations_single_outcome check (not (accepted_at is not null and revoked_at is not null)),
  constraint clinic_invitations_acceptance_coherent check ((accepted_at is null) = (accepted_by is null))
);

-- At most one open invitation per email per clinic (re-inviting revokes the previous one).
create unique index clinic_invitations_one_open_per_email
  on public.clinic_invitations (clinic_id, email)
  where accepted_at is null and revoked_at is null;

create trigger clinic_invitations_tenant_immutable
  before update on public.clinic_invitations
  for each row execute function private.forbid_clinic_id_change();

-- ---------------------------------------------------------------------------
-- clinic_closures — whole-clinic closed days (managed table)
-- ---------------------------------------------------------------------------
create table public.clinic_closures (
  id         uuid primary key default gen_random_uuid(),
  clinic_id  uuid not null references public.clinics (id),
  dates      daterange not null,
  reason     text not null,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clinic_closures_clinic_id_id_key unique (clinic_id, id),
  constraint clinic_closures_bounded check (not isempty(dates) and not lower_inf(dates) and not upper_inf(dates)),
  constraint clinic_closures_reason_length check (char_length(btrim(reason)) between 2 and 200),
  constraint clinic_closures_no_overlap exclude using gist (clinic_id with =, dates with &&)
);

create trigger clinic_closures_set_updated_at
  before update on public.clinic_closures
  for each row execute function private.set_updated_at();
create trigger clinic_closures_tenant_immutable
  before update on public.clinic_closures
  for each row execute function private.forbid_clinic_id_change();

-- ---------------------------------------------------------------------------
-- private.clinic_counters — gapless per-clinic numbering (MD-16)
-- ---------------------------------------------------------------------------
create table private.clinic_counters (
  clinic_id   uuid not null references public.clinics (id),
  counter_key text not null,
  next_value  bigint not null,
  updated_at  timestamptz not null default now(),
  primary key (clinic_id, counter_key),
  constraint clinic_counters_key_format check (counter_key ~ '^[a-z_]+(:[0-9]{4})?$'),
  constraint clinic_counters_positive check (next_value >= 1)
);

-- Returns the next number and keeps the counter row locked until the caller's transaction ends,
-- so numbers are gapless: a rollback also rolls back the increment.
create function private.next_counter_value(p_clinic_id uuid, p_counter_key text)
returns bigint
language sql
volatile
security definer
set search_path = ''
as $$
  insert into private.clinic_counters as c (clinic_id, counter_key, next_value)
  values (p_clinic_id, p_counter_key, 2)
  on conflict (clinic_id, counter_key)
    do update set next_value = c.next_value + 1, updated_at = now()
  returning c.next_value - 1;
$$;
