-- =============================================================================
-- 0029 SaaS administration (module 12): plans and limits, clinic subscriptions, read-only
-- clinics on expiry, platform functions with aggregates only.
-- BUSINESS_RULES §7 (BR-P-01), BR-T-08, BR-N-08; DOMAIN_MODEL BC11; RBAC §4.
--
-- Plans, prices and trial or grace lengths are commercial decisions: one neutral "pilot" plan
-- (0 MAD, no limit) is seeded so that every clinic has a subscription; the platform creates the
-- real plans. Platform functions need a platform admin with MFA (private.require_platform_admin)
-- and return clinic metadata and counts, never patient-level rows (RBAC §4, MD-18).
-- =============================================================================

create type public.subscription_status as enum ('trialing', 'active', 'past_due', 'cancelled', 'expired');

-- ---------------------------------------------------------------------------
-- Plans and limits
-- ---------------------------------------------------------------------------
create table public.subscription_plans (
  id                uuid primary key default gen_random_uuid(),
  code              text not null,
  name_fr           text not null,
  name_ar           text not null,
  monthly_price_mad numeric(12, 2) not null default 0,
  grace_days        smallint not null default 7,
  is_public         boolean not null default true,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint subscription_plans_code_key unique (code),
  constraint subscription_plans_code_format check (code ~ '^[a-z][a-z0-9_]{1,29}$'),
  constraint subscription_plans_names check (char_length(btrim(name_fr)) between 2 and 60 and char_length(btrim(name_ar)) between 2 and 60),
  constraint subscription_plans_price check (monthly_price_mad >= 0 and monthly_price_mad <= 1000000),
  constraint subscription_plans_grace check (grace_days between 0 and 60)
);
comment on table public.subscription_plans is 'BC11. Platform-owned; read through functions only.';
create trigger subscription_plans_set_updated_at
  before update on public.subscription_plans
  for each row execute function private.set_updated_at();

-- BR-T-08 limits; no row, or a null limit, means unlimited.
create table public.subscription_features (
  plan_id     uuid not null references public.subscription_plans (id) on delete cascade,
  feature_key text not null,
  limit_value integer,
  constraint subscription_features_pkey primary key (plan_id, feature_key),
  constraint subscription_features_key check (feature_key in ('max_doctors', 'max_staff', 'monthly_sms_quota')),
  constraint subscription_features_limit check (limit_value is null or limit_value between 0 and 1000000),
  -- The owner is a member: a plan always allows at least one.
  constraint subscription_features_staff check (feature_key <> 'max_staff' or limit_value is null or limit_value >= 1)
);

insert into public.subscription_plans (code, name_fr, name_ar, monthly_price_mad, is_public)
values ('pilot', 'Pilote', 'تجريبي', 0, false);

-- ---------------------------------------------------------------------------
-- Subscriptions
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  clinic_id            uuid not null references public.clinics (id),
  plan_id              uuid not null references public.subscription_plans (id),
  status               public.subscription_status not null default 'trialing',
  started_at           timestamptz not null default now(),
  current_period_start timestamptz,
  current_period_end   timestamptz,
  trial_ends_at        timestamptz,
  cancelled_at         timestamptz,
  ended_at             timestamptz,
  managed_by           uuid references auth.users (id),
  notes                text,
  version              integer not null default 1,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint subscriptions_clinic_id_id_key unique (clinic_id, id),
  constraint subscriptions_period check (current_period_start is null or current_period_end is null or current_period_end > current_period_start),
  constraint subscriptions_paid_period check (status not in ('active', 'past_due', 'cancelled')
                                              or (current_period_start is not null and current_period_end is not null)),
  constraint subscriptions_cancel_coherent check ((status = 'cancelled') <= (cancelled_at is not null)),
  constraint subscriptions_ended_coherent check ((status = 'expired') = (ended_at is not null)),
  constraint subscriptions_notes_length check (notes is null or char_length(notes) <= 500),
  constraint subscriptions_version check (version >= 1)
);
comment on table public.subscriptions is 'BC11. Written by the platform (manual billing in the pilot); read by the clinic (subscription.view).';
-- One live subscription per clinic (a cancelled one runs until its period ends).
create unique index subscriptions_one_live on public.subscriptions (clinic_id)
  where status in ('trialing', 'active', 'past_due', 'cancelled');
create index subscriptions_clinic_idx on public.subscriptions (clinic_id, started_at desc);
create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function private.set_updated_at();
create trigger subscriptions_tenant_immutable
  before update on public.subscriptions
  for each row execute function private.forbid_clinic_id_change();
create trigger subscriptions_audit
  after insert or update or delete on public.subscriptions
  for each row execute function private.audit_row_change();

create table public.subscription_change_requests (
  id           uuid primary key default gen_random_uuid(),
  clinic_id    uuid not null references public.clinics (id),
  plan_id      uuid not null references public.subscription_plans (id),
  note         text,
  requested_by uuid not null references auth.users (id),
  status       text not null default 'open',
  handled_at   timestamptz,
  handled_by   uuid references auth.users (id),
  created_at   timestamptz not null default now(),
  constraint subscription_change_requests_status check (status in ('open', 'handled', 'withdrawn')),
  constraint subscription_change_requests_handled check ((status = 'open') = (handled_at is null)),
  constraint subscription_change_requests_note check (note is null or char_length(note) <= 500)
);
create unique index subscription_change_requests_one_open on public.subscription_change_requests (clinic_id) where status = 'open';
create trigger subscription_change_requests_tenant_immutable
  before update on public.subscription_change_requests
  for each row execute function private.forbid_clinic_id_change();

-- RLS: plans and features are read through functions; a clinic reads its own subscription and
-- requests with subscription.view (owner, admin, accountant).
alter table public.subscription_plans enable row level security;
alter table public.subscription_features enable row level security;
alter table public.subscriptions enable row level security;
alter table public.subscription_change_requests enable row level security;
grant select on public.subscriptions to authenticated;
grant select on public.subscription_change_requests to authenticated;
create policy subscriptions_select on public.subscriptions for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('subscription.view')));
create policy subscription_change_requests_select on public.subscription_change_requests for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('subscription.view')));

-- Every clinic starts on a trial of the pilot plan; existing clinics get one now.
create function private.start_clinic_subscription()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.subscriptions (clinic_id, plan_id, status)
  select new.id, p.id, 'trialing' from public.subscription_plans p where p.code = 'pilot';
  return null;
end;
$$;
revoke all on function private.start_clinic_subscription() from public, anon, authenticated;
create trigger clinics_start_subscription
  after insert on public.clinics
  for each row execute function private.start_clinic_subscription();

insert into public.subscriptions (clinic_id, plan_id, status)
select c.id, p.id, 'trialing'
from public.clinics c cross join public.subscription_plans p
where p.code = 'pilot' and not exists (select 1 from public.subscriptions s where s.clinic_id = c.id);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- The clinic's current subscription: the live one, else the latest one.
create function private.current_subscription(p_clinic_id uuid)
returns public.subscriptions
language sql
stable
security definer
set search_path = ''
as $$
  select s.* from public.subscriptions s
  where s.clinic_id = p_clinic_id
  order by (s.status in ('trialing', 'active', 'past_due', 'cancelled')) desc, s.started_at desc
  limit 1;
$$;

-- BR-P-01: the subscription ended and none is live: the clinic is read-only.
create function private.subscription_expired(p_clinic_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.subscriptions s where s.clinic_id = p_clinic_id and s.status = 'expired')
     and not exists (select 1 from public.subscriptions s
                     where s.clinic_id = p_clinic_id and s.status in ('trialing', 'active', 'past_due', 'cancelled'));
$$;

-- A plan limit of the clinic's current subscription; null means unlimited.
create function private.plan_limit(p_clinic_id uuid, p_feature text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select f.limit_value
  from public.subscription_features f
  where f.plan_id = (private.current_subscription(p_clinic_id)).plan_id and f.feature_key = p_feature;
$$;

create function private.sms_sent_this_month(p_clinic_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.notifications n
  join public.clinics c on c.id = n.clinic_id
  where n.clinic_id = p_clinic_id and n.channel = 'sms' and n.status in ('processing', 'sent', 'delivered')
    and coalesce(n.sent_at, n.processing_started_at) >= (date_trunc('month', now() at time zone c.timezone) at time zone c.timezone);
$$;

-- BR-N-08: the plan's monthly SMS quota (the email fallback of BR-N-08 is not built yet).
create function private.sms_quota_reached(p_clinic_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := private.plan_limit(p_clinic_id, 'monthly_sms_quota');
begin
  return v_limit is not null and private.sms_sent_this_month(p_clinic_id) >= v_limit;
end;
$$;

create function private.clinic_read_only_reason(p_clinic_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when c.status = 'suspended' then 'suspended'
    when c.status = 'closed' then 'closed'
    when private.subscription_expired(c.id) then 'subscription_expired'
  end
  from public.clinics c where c.id = p_clinic_id;
$$;

revoke all on function private.current_subscription(uuid) from public, anon, authenticated;
revoke all on function private.subscription_expired(uuid) from public, anon, authenticated;
revoke all on function private.plan_limit(uuid, text) from public, anon, authenticated;
revoke all on function private.sms_sent_this_month(uuid) from public, anon, authenticated;
revoke all on function private.sms_quota_reached(uuid) from public, anon, authenticated;
revoke all on function private.clinic_read_only_reason(uuid) from public, anon, authenticated;

-- BR-P-01, in the one helper every RLS policy and command uses: with an expired subscription,
-- write permissions disappear (reads stay, and the owner can still ask for a plan).
create or replace function private.clinics_with_permission(p_permission text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.clinic_id
  from public.clinic_members m
  join public.clinics c           on c.id = m.clinic_id
  join public.role_permissions rp on rp.role = m.role and rp.permission_key = p_permission
  join public.permissions p       on p.key = rp.permission_key
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and (c.status in ('active', 'pending_approval') or (c.status = 'suspended' and p.access = 'read'))
    and (p.access = 'read' or p.key = 'subscription.request_change' or not private.subscription_expired(c.id))
    and (not private.role_requires_mfa(m.role) or private.session_aal() = 'aal2');
$$;

-- ---------------------------------------------------------------------------
-- BR-T-08: limits checked where they would be exceeded, serialized per clinic and limit.
-- ---------------------------------------------------------------------------
create function private.assert_within_limit(p_clinic_id uuid, p_feature text, p_current integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_limit integer := private.plan_limit(p_clinic_id, p_feature);
begin
  if v_limit is not null and p_current >= v_limit then
    raise exception using errcode = 'P0001', message = 'PLAN_LIMIT_REACHED', detail = p_feature;
  end if;
end;
$$;
revoke all on function private.assert_within_limit(uuid, text, integer) from public, anon, authenticated;

create function private.enforce_doctor_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'active' and (tg_op = 'INSERT' or old.status <> 'active') then
    perform pg_advisory_xact_lock(hashtextextended('plan-limit:' || new.clinic_id || ':max_doctors', 0));
    perform private.assert_within_limit(new.clinic_id, 'max_doctors',
      (select count(*)::integer from public.doctors d where d.clinic_id = new.clinic_id and d.status = 'active' and d.id <> new.id));
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_doctor_limit() from public, anon, authenticated;
create trigger doctors_plan_limit
  before insert or update of status on public.doctors
  for each row execute function private.enforce_doctor_limit();

-- Staff = active members; an open invitation reserves a seat until it is accepted or expires.
create function private.enforce_staff_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_members integer;
  v_open    integer := 0;
begin
  -- Invitations have no status column: only a member becoming active is checked here.
  if tg_table_name = 'clinic_members' then
    if not (new.status = 'active' and (tg_op = 'INSERT' or old.status <> 'active')) then
      return new;
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('plan-limit:' || new.clinic_id || ':max_staff', 0));
  select count(*)::integer into v_members from public.clinic_members m
  where m.clinic_id = new.clinic_id and m.status = 'active' and (tg_table_name <> 'clinic_members' or m.id <> new.id);
  if tg_table_name = 'clinic_invitations' then
    select count(*)::integer into v_open from public.clinic_invitations i
    where i.clinic_id = new.clinic_id and i.accepted_at is null and i.revoked_at is null and i.expires_at > now();
  end if;
  perform private.assert_within_limit(new.clinic_id, 'max_staff', v_members + v_open);
  return new;
end;
$$;
revoke all on function private.enforce_staff_limit() from public, anon, authenticated;
create trigger clinic_members_plan_limit
  before insert or update of status on public.clinic_members
  for each row execute function private.enforce_staff_limit();
create trigger clinic_invitations_plan_limit
  before insert on public.clinic_invitations
  for each row execute function private.enforce_staff_limit();

-- ---------------------------------------------------------------------------
-- Subscription lifecycle job (BUSINESS_RULES §7), daily: trial ended → expired; period ended →
-- past due; past due beyond the plan's grace days → expired; cancelled at period end → expired.
-- ---------------------------------------------------------------------------
create function private.refresh_subscription_states()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_n     integer;
begin
  perform set_config('smartcabin.actor_type', 'system', true);
  update public.subscriptions s set status = 'expired', ended_at = now(), version = s.version + 1
   where s.status = 'trialing' and s.trial_ends_at is not null and s.trial_ends_at <= now();
  get diagnostics v_n = row_count; v_count := v_count + v_n;
  update public.subscriptions s set status = 'past_due', version = s.version + 1
   where s.status = 'active' and s.current_period_end <= now();
  get diagnostics v_n = row_count; v_count := v_count + v_n;
  update public.subscriptions s set status = 'expired', ended_at = now(), version = s.version + 1
    from public.subscription_plans p
   where p.id = s.plan_id and s.status = 'past_due' and s.current_period_end + make_interval(days => p.grace_days) <= now();
  get diagnostics v_n = row_count; v_count := v_count + v_n;
  update public.subscriptions s set status = 'expired', ended_at = now(), version = s.version + 1
   where s.status = 'cancelled' and s.current_period_end <= now();
  get diagnostics v_n = row_count; v_count := v_count + v_n;
  return v_count;
end;
$$;
revoke all on function private.refresh_subscription_states() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule('smartcabin-subscription-states', '15 1 * * *', 'select private.refresh_subscription_states()');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Clinic side: the subscription, the plans one may ask for, a change request (owner).
-- ---------------------------------------------------------------------------
create function private.plan_limits(p_plan_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'max_doctors', (select f.limit_value from public.subscription_features f where f.plan_id = p_plan_id and f.feature_key = 'max_doctors'),
    'max_staff', (select f.limit_value from public.subscription_features f where f.plan_id = p_plan_id and f.feature_key = 'max_staff'),
    'monthly_sms_quota', (select f.limit_value from public.subscription_features f where f.plan_id = p_plan_id and f.feature_key = 'monthly_sms_quota'));
$$;
revoke all on function private.plan_limits(uuid) from public, anon, authenticated;

create function public.get_my_subscription(p_clinic_id uuid)
returns table (
  plan_code text, plan_name_fr text, plan_name_ar text, monthly_price_mad numeric, status public.subscription_status,
  started_at timestamptz, current_period_start timestamptz, current_period_end timestamptz, trial_ends_at timestamptz,
  limits jsonb, usage jsonb, read_only_reason text, open_request_plan_code text, open_request_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_sub public.subscriptions;
begin
  perform private.require_clinic_access(p_clinic_id);
  perform private.require_permission(p_clinic_id, 'subscription.view');
  v_sub := private.current_subscription(p_clinic_id);
  return query
  select p.code, p.name_fr, p.name_ar, p.monthly_price_mad, v_sub.status,
         v_sub.started_at, v_sub.current_period_start, v_sub.current_period_end, v_sub.trial_ends_at,
         private.plan_limits(p.id),
         jsonb_build_object(
           'max_doctors', (select count(*) from public.doctors d where d.clinic_id = p_clinic_id and d.status = 'active'),
           'max_staff', (select count(*) from public.clinic_members m where m.clinic_id = p_clinic_id and m.status = 'active')
                        + (select count(*) from public.clinic_invitations i where i.clinic_id = p_clinic_id
                             and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()),
           'monthly_sms_quota', private.sms_sent_this_month(p_clinic_id)),
         private.clinic_read_only_reason(p_clinic_id),
         rp.code, r.created_at
  from public.subscription_plans p
  left join public.subscription_change_requests r on r.clinic_id = p_clinic_id and r.status = 'open'
  left join public.subscription_plans rp on rp.id = r.plan_id
  where p.id = v_sub.plan_id;
end;
$$;

create function public.list_available_plans(p_clinic_id uuid)
returns table (code text, name_fr text, name_ar text, monthly_price_mad numeric, limits jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.require_clinic_access(p_clinic_id);
  perform private.require_permission(p_clinic_id, 'subscription.view');
  return query
  select p.code, p.name_fr, p.name_ar, p.monthly_price_mad, private.plan_limits(p.id)
  from public.subscription_plans p where p.is_public and p.is_active
  order by p.monthly_price_mad, p.code;
end;
$$;

-- One open request per clinic: a new one replaces it. The platform applies it (manual billing).
create function public.request_plan_change(p_clinic_id uuid, p_plan_code text, p_note text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_plan uuid;
  v_id   uuid;
begin
  perform private.require_clinic_access(p_clinic_id);
  perform private.require_permission(p_clinic_id, 'subscription.request_change');
  select p.id into v_plan from public.subscription_plans p where p.code = p_plan_code and p.is_public and p.is_active;
  if v_plan is null then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'plan';
  end if;
  if p_note is not null and char_length(p_note) > 500 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'note';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('plan-request:' || p_clinic_id, 0));
  update public.subscription_change_requests r set status = 'withdrawn', handled_at = now(), handled_by = auth.uid()
   where r.clinic_id = p_clinic_id and r.status = 'open';
  insert into public.subscription_change_requests (clinic_id, plan_id, note, requested_by)
  values (p_clinic_id, v_plan, nullif(btrim(p_note), ''), auth.uid())
  returning id into v_id;
  perform private.emit_event(p_clinic_id, 'subscription', v_id, 'subscription.change_requested', jsonb_build_object('plan', p_plan_code));
  return v_id;
end;
$$;

-- The caller's effective permissions in a clinic right now (MFA, clinic status, subscription),
-- so the interface shows read-only clinics as read-only. The database still checks every call.
create function public.get_my_clinic_access(p_clinic_id uuid)
returns table (permissions text[], read_only_reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_clinic_access(p_clinic_id);
  return query
  select coalesce(array(
           select rp.permission_key
           from public.clinic_members m
           join public.role_permissions rp on rp.role = m.role
           where m.clinic_id = p_clinic_id and m.user_id = (select auth.uid()) and m.status = 'active'
             and private.has_permission(p_clinic_id, rp.permission_key)
           order by rp.permission_key), '{}'::text[]),
         private.clinic_read_only_reason(p_clinic_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Platform functions (platform admin with MFA). Counts and metadata only.
-- ---------------------------------------------------------------------------
create function public.platform_list_plans()
returns table (plan_id uuid, code text, name_fr text, name_ar text, monthly_price_mad numeric, grace_days smallint,
               is_public boolean, is_active boolean, limits jsonb, live_subscriptions integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.require_platform_admin();
  return query
  select p.id, p.code, p.name_fr, p.name_ar, p.monthly_price_mad, p.grace_days, p.is_public, p.is_active,
         private.plan_limits(p.id),
         (select count(*)::integer from public.subscriptions s
          where s.plan_id = p.id and s.status in ('trialing', 'active', 'past_due', 'cancelled'))
  from public.subscription_plans p
  order by p.is_active desc, p.monthly_price_mad, p.code;
end;
$$;

-- Creates (p_plan_id null) or updates a plan. The code never changes once created. A plan is
-- retired (is_active false), never deleted. p_limits: {"max_doctors": 3, "max_staff": null, ...}.
create function public.platform_save_plan(
  p_plan_id           uuid,
  p_code              text,
  p_name_fr           text,
  p_name_ar           text,
  p_monthly_price_mad numeric,
  p_grace_days        integer,
  p_is_public         boolean,
  p_is_active         boolean,
  p_limits            jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id  uuid := p_plan_id;
  v_key text;
  v_val jsonb;
begin
  perform private.require_platform_admin();
  perform set_config('smartcabin.actor_type', 'platform_admin', true);
  if p_limits is null or jsonb_typeof(p_limits) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_limits) k where k not in ('max_doctors', 'max_staff', 'monthly_sms_quota'))
     or p_monthly_price_mad is null or p_monthly_price_mad <> round(p_monthly_price_mad, 2) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'plan';
  end if;
  begin
    if v_id is null then
      insert into public.subscription_plans (code, name_fr, name_ar, monthly_price_mad, grace_days, is_public, is_active)
      values (p_code, btrim(p_name_fr), btrim(p_name_ar), p_monthly_price_mad, p_grace_days, coalesce(p_is_public, true), coalesce(p_is_active, true))
      returning id into v_id;
    else
      update public.subscription_plans p
         set name_fr = btrim(p_name_fr), name_ar = btrim(p_name_ar), monthly_price_mad = p_monthly_price_mad,
             grace_days = p_grace_days, is_public = coalesce(p_is_public, p.is_public), is_active = coalesce(p_is_active, p.is_active)
       where p.id = v_id and p.code = p_code;
      if not found then
        raise exception using errcode = 'P0002', message = 'NOT_FOUND';
      end if;
    end if;
  exception
    when unique_violation then raise exception using errcode = 'P0001', message = 'DUPLICATE', detail = 'plan code';
    when check_violation or not_null_violation or numeric_value_out_of_range then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'plan';
  end;
  for v_key, v_val in select key, value from jsonb_each(p_limits) loop
    if jsonb_typeof(v_val) not in ('number', 'null') or (jsonb_typeof(v_val) = 'number' and (v_val::text)::numeric <> floor((v_val::text)::numeric)) then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = v_key;
    end if;
    begin
      insert into public.subscription_features (plan_id, feature_key, limit_value)
      values (v_id, v_key, case when jsonb_typeof(v_val) = 'null' then null else (v_val::text)::integer end)
      on conflict (plan_id, feature_key) do update set limit_value = excluded.limit_value;
    exception when check_violation or numeric_value_out_of_range then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = v_key;
    end;
  end loop;
  return v_id;
end;
$$;

-- Assigns the plan, status and period of a clinic's subscription (manual billing in the pilot).
-- Dates are local dates of the clinic: a period runs from the start date 00:00 to the end date
-- 24:00. From an expired (or no) subscription, a new one starts.
create function public.platform_set_subscription(
  p_clinic_id     uuid,
  p_plan_code     text,
  p_status        public.subscription_status,
  p_period_start  date default null,
  p_period_end    date default null,
  p_trial_ends_on date default null,
  p_notes         text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tz    text;
  v_plan  uuid;
  v_live  public.subscriptions;
  v_from  public.subscription_status;
  v_id    uuid;
  v_start timestamptz;
  v_end   timestamptz;
  v_trial timestamptz;
begin
  perform private.require_platform_admin();
  perform set_config('smartcabin.actor_type', 'platform_admin', true);
  select c.timezone into v_tz from public.clinics c where c.id = p_clinic_id for update;
  if v_tz is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  select p.id into v_plan from public.subscription_plans p where p.code = p_plan_code;
  if v_plan is null or p_status is null or (p_notes is not null and char_length(p_notes) > 500) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'plan, status or notes';
  end if;
  v_start := case when p_period_start is not null then p_period_start::timestamp at time zone v_tz end;
  v_end := case when p_period_end is not null then (p_period_end + 1)::timestamp at time zone v_tz end;
  v_trial := case when p_trial_ends_on is not null then (p_trial_ends_on + 1)::timestamp at time zone v_tz end;
  if p_status in ('active', 'past_due', 'cancelled') and (v_start is null or v_end is null or v_end <= v_start) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'period';
  end if;

  select * into v_live from public.subscriptions s
  where s.clinic_id = p_clinic_id and s.status in ('trialing', 'active', 'past_due', 'cancelled') for update;
  v_from := coalesce(v_live.status, 'expired');
  if not ((v_from, p_status) in (
      ('trialing'::public.subscription_status, 'trialing'::public.subscription_status), ('trialing', 'active'), ('trialing', 'expired'),
      ('active', 'active'), ('active', 'past_due'), ('active', 'cancelled'),
      ('past_due', 'past_due'), ('past_due', 'active'), ('past_due', 'expired'),
      ('cancelled', 'cancelled'), ('cancelled', 'active'), ('cancelled', 'expired'),
      ('expired', 'trialing'), ('expired', 'active'))) then
    raise exception using errcode = 'P0001', message = 'SUBSCRIPTION_INVALID_TRANSITION', detail = format('%s -> %s', v_from, p_status);
  end if;

  if v_live.id is null then
    insert into public.subscriptions (clinic_id, plan_id, status, current_period_start, current_period_end, trial_ends_at, managed_by, notes)
    values (p_clinic_id, v_plan, p_status, v_start, v_end, v_trial, auth.uid(), nullif(btrim(p_notes), ''))
    returning id into v_id;
  else
    update public.subscriptions s
       set plan_id = v_plan, status = p_status,
           current_period_start = coalesce(v_start, s.current_period_start),
           current_period_end = coalesce(v_end, s.current_period_end),
           trial_ends_at = case when p_status = 'trialing' then v_trial else s.trial_ends_at end,
           cancelled_at = case when p_status = 'cancelled' then coalesce(s.cancelled_at, now()) when p_status = 'active' then null else s.cancelled_at end,
           ended_at = case when p_status = 'expired' then now() end,
           managed_by = auth.uid(), notes = coalesce(nullif(btrim(p_notes), ''), s.notes), version = s.version + 1
     where s.id = v_live.id
    returning s.id into v_id;
  end if;
  -- An open request is answered by this decision.
  update public.subscription_change_requests r set status = 'handled', handled_at = now(), handled_by = auth.uid()
   where r.clinic_id = p_clinic_id and r.status = 'open';
  perform private.emit_event(p_clinic_id, 'subscription', v_id, 'subscription.changed',
    jsonb_build_object('plan', p_plan_code, 'status', p_status));
  return v_id;
end;
$$;

-- A payment received for the next period: active until the given local date (included).
create function public.platform_mark_subscription_paid(p_clinic_id uuid, p_paid_until date, p_notes text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tz   text;
  v_sub  public.subscriptions;
  v_code text;
  v_from date;
begin
  perform private.require_platform_admin();
  select c.timezone into v_tz from public.clinics c where c.id = p_clinic_id;
  if v_tz is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_sub := private.current_subscription(p_clinic_id);
  select p.code into v_code from public.subscription_plans p where p.id = v_sub.plan_id;
  -- The paid period continues the current one; a new or lapsed subscription starts today.
  v_from := case when v_sub.status in ('active', 'past_due') and v_sub.current_period_end is not null
                 then (v_sub.current_period_end at time zone v_tz)::date
                 else (now() at time zone v_tz)::date end;
  if p_paid_until is null or p_paid_until < v_from then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'paid until';
  end if;
  return public.platform_set_subscription(p_clinic_id, v_code, 'active',
    case when v_sub.status in ('active', 'past_due') then (v_sub.current_period_start at time zone v_tz)::date else v_from end,
    p_paid_until, null, p_notes);
end;
$$;

-- Per clinic: subscription, open request and activity counts. Never a patient-level row.
create function public.platform_kpi_overview()
returns table (
  clinic_id uuid, plan_code text, plan_name_fr text, plan_name_ar text, subscription_status public.subscription_status,
  current_period_end timestamptz, trial_ends_at timestamptz, open_request_plan_code text,
  appointments_30d integer, completed_30d integer, online_bookings_30d integer, sms_this_month integer,
  active_members integer, active_doctors integer, patients_total integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.require_platform_admin();
  return query
  select c.id, p.code, p.name_fr, p.name_ar, s.status, s.current_period_end, s.trial_ends_at, rp.code,
         (select count(*)::integer from public.appointments a where a.clinic_id = c.id and a.starts_at >= now() - interval '30 days' and a.starts_at < now()),
         (select count(*)::integer from public.appointments a where a.clinic_id = c.id and a.status = 'completed' and a.starts_at >= now() - interval '30 days'),
         (select count(*)::integer from public.appointments a where a.clinic_id = c.id and a.source = 'online' and a.created_at >= now() - interval '30 days'),
         private.sms_sent_this_month(c.id),
         (select count(*)::integer from public.clinic_members m where m.clinic_id = c.id and m.status = 'active'),
         (select count(*)::integer from public.doctors d where d.clinic_id = c.id and d.status = 'active'),
         (select count(*)::integer from public.patients pt where pt.clinic_id = c.id and pt.status = 'active')
  from public.clinics c
  left join lateral (select (private.current_subscription(c.id)).*) s on true
  left join public.subscription_plans p on p.id = s.plan_id
  left join public.subscription_change_requests r on r.clinic_id = c.id and r.status = 'open'
  left join public.subscription_plans rp on rp.id = r.plan_id
  order by c.created_at desc;
end;
$$;

revoke all on function public.get_my_subscription(uuid) from public, anon;
revoke all on function public.list_available_plans(uuid) from public, anon;
revoke all on function public.request_plan_change(uuid, text, text) from public, anon;
revoke all on function public.get_my_clinic_access(uuid) from public, anon;
revoke all on function public.platform_list_plans() from public, anon;
revoke all on function public.platform_save_plan(uuid, text, text, text, numeric, integer, boolean, boolean, jsonb) from public, anon;
revoke all on function public.platform_set_subscription(uuid, text, public.subscription_status, date, date, date, text) from public, anon;
revoke all on function public.platform_mark_subscription_paid(uuid, date, text) from public, anon;
revoke all on function public.platform_kpi_overview() from public, anon;
grant execute on function public.get_my_subscription(uuid) to authenticated;
grant execute on function public.list_available_plans(uuid) to authenticated;
grant execute on function public.request_plan_change(uuid, text, text) to authenticated;
grant execute on function public.get_my_clinic_access(uuid) to authenticated;
grant execute on function public.platform_list_plans() to authenticated;
grant execute on function public.platform_save_plan(uuid, text, text, text, numeric, integer, boolean, boolean, jsonb) to authenticated;
grant execute on function public.platform_set_subscription(uuid, text, public.subscription_status, date, date, date, text) to authenticated;
grant execute on function public.platform_mark_subscription_paid(uuid, date, text) to authenticated;
grant execute on function public.platform_kpi_overview() to authenticated;

-- ---------------------------------------------------------------------------
-- BR-N-08 / BR-T-08: the dispatcher no longer sends SMS beyond the plan's monthly quota.
-- Forward-only replacement of migration 0026's function: same signature, same body, plus the
-- quota check right before the template lookup.
-- ---------------------------------------------------------------------------
create or replace function public.jobs_claim_notifications(p_job_key text, p_limit integer default 50, p_lease_seconds integer default 120)
returns table (notification_id uuid, channel public.notification_channel, recipient text, sender text,
               subject text, body text, attempt_no integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_n         public.notifications;
  v_appt      public.appointments;
  v_patient   public.patients;
  v_clinic    public.clinics;
  v_sender    text;
  v_template  public.notification_templates;
  v_ticket    integer;
  v_entry     public.queue_state;
  v_skip      text;
  v_to        text;
  v_text      text;
  v_subject   text;
begin
  perform private.require_job_key(p_job_key);

  -- A lease that expired means the worker died mid-send: record a timeout, then retry or fail.
  for v_n in
    select * from public.notifications n where n.status = 'processing' and n.locked_until < now()
    for update skip locked
  loop
    insert into public.notification_attempts (clinic_id, notification_id, attempt_no, recipient_masked, started_at, outcome)
    values (v_n.clinic_id, v_n.id, v_n.attempt_count, v_n.recipient_masked, v_n.processing_started_at, 'timeout')
    on conflict (notification_id, attempt_no) do nothing;
    if v_n.attempt_count >= 5 then
      update public.notifications set status = 'failed', failed_at = now(), locked_until = null, last_error = 'timeout' where id = v_n.id;
    else
      update public.notifications set status = 'scheduled', locked_until = null, next_attempt_at = now() + private.retry_delay(v_n.attempt_count)
      where id = v_n.id;
    end if;
  end loop;

  for v_n in
    select * from public.notifications n
    where n.status = 'scheduled' and n.scheduled_for <= now() and (n.next_attempt_at is null or n.next_attempt_at <= now())
    order by n.scheduled_for
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
    for update skip locked
  loop
    v_skip := null;
    v_appt := null;
    if v_n.appointment_id is not null then
      select * into v_appt from public.appointments a where a.id = v_n.appointment_id;
    end if;
    -- BR-N-02: re-read the appointment or queue entry right before sending.
    if v_n.event_type in ('appointment_confirmation', 'appointment_reminder')
       and (v_appt.status is distinct from 'confirmed' or v_appt.starts_at is distinct from v_n.context_starts_at) then
      v_skip := 'stale';
    elsif v_n.event_type = 'appointment_rescheduled'
       and (v_appt.status not in ('pending', 'confirmed') or v_appt.starts_at is distinct from v_n.context_starts_at) then
      v_skip := 'stale';
    elsif v_n.event_type = 'appointment_cancellation' and v_appt.status is distinct from 'cancelled' then
      v_skip := 'stale';
    elsif v_n.event_type = 'doctor_delay' and v_appt.status not in ('confirmed', 'checked_in') then
      v_skip := 'stale';
    elsif v_n.event_type = 'turn_approaching' then
      select q.state, q.ticket_number into v_entry, v_ticket from public.queue_entries q where q.id = v_n.queue_entry_id;
      if v_entry is distinct from 'waiting' then
        v_skip := 'stale';
      end if;
    end if;

    -- BR-N-04: consent for this channel, and the address as it is now.
    select * into v_patient from public.patients p where p.clinic_id = v_n.clinic_id and p.id = v_n.patient_id;
    if v_skip is null and not private.has_channel_consent(v_n.clinic_id, v_n.patient_id, v_n.channel) then
      v_skip := 'no_consent';
    end if;
    v_to := case v_n.channel when 'email' then v_patient.email::text else v_patient.phone_e164 end;
    if v_skip is null and v_to is null then
      v_skip := 'no_address';
    end if;
    if v_skip is not null then
      update public.notifications set status = 'skipped', skip_reason = v_skip where id = v_n.id;
      continue;
    end if;

    -- BR-N-08: SMS beyond the plan's monthly quota are not sent (the email fallback is not built yet).
    if v_n.channel = 'sms' and private.sms_quota_reached(v_n.clinic_id) then
      update public.notifications set status = 'skipped', skip_reason = 'quota_exceeded' where id = v_n.id;
      continue;
    end if;

    select * into v_template from public.notification_templates t
    where t.event_type = v_n.event_type and t.channel = v_n.channel and t.locale = v_n.locale and t.is_active
      and (t.clinic_id = v_n.clinic_id or t.clinic_id is null)
    order by (t.clinic_id is null)
    limit 1;
    if not found then
      update public.notifications set status = 'skipped', skip_reason = 'no_template' where id = v_n.id;
      continue;
    end if;

    select * into v_clinic from public.clinics c where c.id = v_n.clinic_id;
    select s.sms_sender_name into v_sender from public.clinic_settings s where s.clinic_id = v_n.clinic_id;
    v_text := v_template.body;
    v_subject := v_template.subject;
    v_text := replace(v_text, '{clinic}', v_clinic.display_name);
    v_text := replace(v_text, '{date}', coalesce(to_char(v_n.context_starts_at at time zone v_clinic.timezone, 'DD/MM/YYYY'), ''));
    v_text := replace(v_text, '{time}', coalesce(to_char(v_n.context_starts_at at time zone v_clinic.timezone, 'HH24:MI'), ''));
    v_text := replace(v_text, '{ticket}', coalesce(v_ticket::text, ''));
    v_text := replace(v_text, '{delay}', coalesce(v_n.delay_minutes::text, ''));
    if v_subject is not null then
      v_subject := replace(v_subject, '{clinic}', v_clinic.display_name);
    end if;

    update public.notifications
       set status = 'processing', attempt_count = attempt_count + 1, locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 30)),
           processing_started_at = now(), template_id = v_template.id, recipient_masked = private.mask_recipient(v_n.channel, v_to)
     where id = v_n.id;
    return query select v_n.id, v_n.channel, v_to, v_sender, v_subject, v_text, v_n.attempt_count + 1;
  end loop;
end;
$$;
