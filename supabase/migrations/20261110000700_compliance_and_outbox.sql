-- SmartCabin 0007 — Compliance (BC12) and the domain-event outbox (BC8 shared kernel).

-- ---------------------------------------------------------------------------
-- audit_logs — append-only; field names only, never values (BR-D-04)
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id             bigint generated always as identity primary key,
  occurred_at    timestamptz not null default now(),
  actor_type     public.actor_type not null,
  actor_user_id  uuid,  -- no FK: the trail survives account deletion
  clinic_id      uuid references public.clinics (id),
  action         text not null,
  entity_type    text not null,
  entity_id      uuid,
  changed_fields text[] not null default '{}',
  metadata       jsonb not null default '{}',
  request_id     text,
  constraint audit_logs_action_format check (action ~ '^[a-z_]+\.[a-z_]+$'),
  constraint audit_logs_request_id_length check (request_id is null or char_length(request_id) <= 100)
);

create index audit_logs_clinic_time_idx on public.audit_logs (clinic_id, occurred_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);

create trigger audit_logs_append_only
  before update or delete on public.audit_logs
  for each row execute function private.forbid_mutation();

-- ---------------------------------------------------------------------------
-- legal_documents / legal_acceptances — proof of acceptance (MD-20)
-- ---------------------------------------------------------------------------
create table public.legal_documents (
  id           uuid primary key default gen_random_uuid(),
  kind         public.legal_kind not null,
  locale       text not null,
  version      text not null,
  published_at timestamptz not null default now(),
  content_path text not null,
  is_current   boolean not null default false,
  constraint legal_documents_version_key unique (kind, locale, version),
  constraint legal_documents_locale check (locale in ('fr', 'ar')),
  constraint legal_documents_version_length check (char_length(version) between 1 and 20),
  constraint legal_documents_path_length check (char_length(content_path) between 1 and 300)
);

create unique index legal_documents_one_current on public.legal_documents (kind, locale) where is_current;

create table public.legal_acceptances (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.legal_documents (id),
  user_id     uuid not null default auth.uid() references auth.users (id),
  clinic_id   uuid references public.clinics (id),
  context     public.acceptance_context not null,
  accepted_at timestamptz not null default now(),
  constraint legal_acceptances_once unique nulls not distinct (document_id, user_id, clinic_id)
);

create index legal_acceptances_user_idx on public.legal_acceptances (user_id);

create trigger legal_acceptances_append_only
  before update or delete on public.legal_acceptances
  for each row execute function private.forbid_mutation();

-- ---------------------------------------------------------------------------
-- domain_events — transactional outbox (MD-15). Payloads carry identifiers only.
-- Read by the worker through the service role; no access for API roles.
-- ---------------------------------------------------------------------------
create table public.domain_events (
  id             bigint generated always as identity primary key,
  clinic_id      uuid references public.clinics (id),
  aggregate_type text not null,
  aggregate_id   uuid not null,
  event_type     text not null,
  payload        jsonb not null default '{}',
  occurred_at    timestamptz not null default now(),
  processed_at   timestamptz,
  attempts       integer not null default 0,
  last_error     text,
  constraint domain_events_type_format check (event_type ~ '^[a-z_]+\.[a-z_]+$'),
  constraint domain_events_attempts check (attempts >= 0)
);

create index domain_events_unprocessed_idx on public.domain_events (id) where processed_at is null;

create function private.emit_event(
  p_clinic_id uuid, p_aggregate_type text, p_aggregate_id uuid, p_event_type text, p_payload jsonb default '{}')
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.domain_events (clinic_id, aggregate_type, aggregate_id, event_type, payload)
  values (p_clinic_id, p_aggregate_type, p_aggregate_id, p_event_type, coalesce(p_payload, '{}'));
$$;
