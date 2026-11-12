-- SmartCabin 0025 — Module 8b: SmartFlow live (realtime hints, display screens, portal status, jobs).
--
-- SECURITY_MODEL §5:
--   Realtime topics: clinic:<clinic_id>:board:<date> (queue.view) and
--   clinic:<clinic_id>:doctor:<doctor_id>:<date> (queue.view; a practitioner-only member needs that
--   doctor id). A policy on realtime.messages parses realtime.topic(). Payloads carry ids and
--   versions only (BR-Q-09), so even a wrongly authorized subscriber learns nothing about patients.
--   Display screens: a 256-bit token, stored hashed, revocable, last_seen_at tracked; the snapshot
--   holds ticket numbers and doctor display names only.
-- The realtime parts are guarded: they apply where Supabase Realtime's database interface exists
-- (and in the test shim, which reproduces it). pg_cron jobs are scheduled only where pg_cron exists.

-- Display screens use queue.displays.manage (owner, admin), defined in 0008.

-- ---------------------------------------------------------------------------
-- Realtime: topic authorization and broadcast hints
-- ---------------------------------------------------------------------------
create function private.can_receive_queue_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts  text[];
  v_clinic uuid;
  v_doctor uuid;
begin
  if p_topic is null then
    return false;
  end if;
  v_parts := string_to_array(p_topic, ':');
  if v_parts[1] is distinct from 'clinic' or array_length(v_parts, 1) not in (4, 5) then
    return false;
  end if;
  begin
    v_clinic := v_parts[2]::uuid;
  exception when others then
    return false;
  end;
  if v_clinic not in (select private.clinics_with_permission('queue.view')) then
    return false;
  end if;
  if array_length(v_parts, 1) = 4 then
    return v_parts[3] = 'board' and v_parts[4] ~ '^\d{4}-\d{2}-\d{2}$';
  end if;
  if v_parts[3] <> 'doctor' or v_parts[5] !~ '^\d{4}-\d{2}-\d{2}$' then
    return false;
  end if;
  begin
    v_doctor := v_parts[4]::uuid;
  exception when others then
    return false;
  end;
  return v_clinic not in (select private.practitioner_only_clinics()) or v_doctor in (select private.my_doctor_ids());
end;
$$;
revoke all on function private.can_receive_queue_topic(text) from public, anon;
grant execute on function private.can_receive_queue_topic(text) to authenticated;

do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute $policy$
      create policy smartcabin_queue_topics on realtime.messages for select to authenticated
        using (realtime.messages.extension = 'broadcast' and private.can_receive_queue_topic(realtime.topic()))
    $policy$;
  end if;
end;
$$;

-- BR-Q-08: every queue change bumps queue_version; a hint follows at commit, on both topics.
create function private.broadcast_queue_hint()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return null;
  end if;
  v_payload := jsonb_build_object('session_id', new.id, 'doctor_id', new.doctor_id, 'queue_version', new.queue_version);
  perform realtime.send(v_payload, 'queue_changed', format('clinic:%s:board:%s', new.clinic_id, new.service_date), true);
  perform realtime.send(v_payload, 'queue_changed', format('clinic:%s:doctor:%s:%s', new.clinic_id, new.doctor_id, new.service_date), true);
  return null;
end;
$$;
create constraint trigger doctor_sessions_broadcast_hint
  after update on public.doctor_sessions
  deferrable initially deferred
  for each row
  when (new.queue_version is distinct from old.queue_version)
  execute function private.broadcast_queue_hint();

-- ---------------------------------------------------------------------------
-- queue_display_screens — waiting-room screens (command table)
-- ---------------------------------------------------------------------------
create table public.queue_display_screens (
  id           uuid primary key default gen_random_uuid(),
  clinic_id    uuid not null references public.clinics (id),
  name         text not null,
  doctor_ids   uuid[],
  token_hash   text not null,
  created_by   uuid references auth.users (id),
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  last_seen_at timestamptz,
  constraint queue_display_screens_clinic_id_id_key unique (clinic_id, id),
  constraint queue_display_screens_token_hash_key unique (token_hash),
  constraint queue_display_screens_token_format check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint queue_display_screens_name check (char_length(btrim(name)) between 2 and 60),
  constraint queue_display_screens_doctors check (doctor_ids is null or cardinality(doctor_ids) between 1 and 20)
);
create trigger queue_display_screens_tenant_immutable
  before update on public.queue_display_screens
  for each row execute function private.forbid_clinic_id_change();
alter table public.queue_display_screens enable row level security;
-- The token hash is never readable.
grant select (id, clinic_id, name, doctor_ids, created_by, created_at, revoked_at, last_seen_at)
  on public.queue_display_screens to authenticated;
create policy queue_display_screens_select on public.queue_display_screens for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('queue.displays.manage')));

-- Returns the token ONCE; only its SHA-256 is stored.
create function public.create_display_screen(p_clinic_id uuid, p_name text, p_doctor_ids uuid[] default null)
returns table (screen_id uuid, display_token text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_token text;
  v_id    uuid;
begin
  perform private.require_clinic_access(p_clinic_id);
  perform private.require_permission(p_clinic_id, 'queue.displays.manage');
  if p_name is null or char_length(btrim(p_name)) not between 2 and 60
     or (p_doctor_ids is not null and (cardinality(p_doctor_ids) not between 1 and 20
         or (select count(distinct d.id) from public.doctors d where d.clinic_id = p_clinic_id and d.id = any(p_doctor_ids))
            <> cardinality(p_doctor_ids))) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'name or doctors';
  end if;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.queue_display_screens (clinic_id, name, doctor_ids, token_hash, created_by)
  values (p_clinic_id, btrim(p_name), p_doctor_ids, encode(extensions.digest(v_token, 'sha256'), 'hex'), auth.uid())
  returning id into v_id;
  return query select v_id, v_token;
end;
$$;

create function public.revoke_display_screen(p_screen_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid;
begin
  select s.clinic_id into v_clinic_id from public.queue_display_screens s where s.id = p_screen_id;
  if v_clinic_id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.require_clinic_access(v_clinic_id);
  perform private.require_permission(v_clinic_id, 'queue.displays.manage');
  update public.queue_display_screens set revoked_at = now() where id = p_screen_id and revoked_at is null;
end;
$$;

-- Snapshot for a waiting-room screen (no login: the token is the credential). Ticket numbers and
-- doctor display names only (BR-Q-09). One error for unknown, revoked and suspended (no oracle).
create function public.display_snapshot(p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_screen public.queue_display_screens;
  v_clinic public.clinics;
  v_today  date;
  v_doctors jsonb;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  select * into v_screen from public.queue_display_screens s
  where s.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') and s.revoked_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  select * into v_clinic from public.clinics c where c.id = v_screen.clinic_id;
  if v_clinic.status <> 'active' then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if v_screen.last_seen_at is null or v_screen.last_seen_at < now() - interval '1 minute' then
    update public.queue_display_screens set last_seen_at = now() where id = v_screen.id;
  end if;
  v_today := (now() at time zone v_clinic.timezone)::date;

  select coalesce(jsonb_agg(x.doc order by x.name), '[]'::jsonb) into v_doctors
  from (
    select d.full_name as name,
           jsonb_build_object(
             'name', d.full_name,
             'name_ar', d.full_name_ar,
             'session', s.status,
             'serving', (select q.ticket_number from public.queue_entries q where q.session_id = s.id and q.state = 'in_consultation'),
             'called', coalesce((select jsonb_agg(q.ticket_number order by q.called_at) from public.queue_entries q
                                 where q.session_id = s.id and q.state = 'called'), '[]'::jsonb),
             'next', coalesce((select jsonb_agg(n.ticket_number order by n.priority_level desc, n.sort_key, n.ticket_number)
                               from (select q.ticket_number, q.priority_level, q.sort_key from public.queue_entries q
                                     where q.session_id = s.id and q.state = 'waiting'
                                     order by q.priority_level desc, q.sort_key, q.ticket_number limit 5) n), '[]'::jsonb),
             'waiting', (select count(*) from public.queue_entries q where q.session_id = s.id and q.state in ('waiting', 'called'))
           ) as doc
    from public.doctors d
    left join public.doctor_sessions s on s.clinic_id = d.clinic_id and s.doctor_id = d.id and s.service_date = v_today
    where d.clinic_id = v_clinic.id and d.status = 'active'
      and (v_screen.doctor_ids is null or d.id = any(v_screen.doctor_ids))
  ) x;

  return jsonb_build_object('clinic', v_clinic.display_name, 'screen', v_screen.name, 'timezone', v_clinic.timezone,
                            'generated_at', now(), 'doctors', v_doctors);
end;
$$;

-- ---------------------------------------------------------------------------
-- Patient portal: my place in today's queue (linked records only)
-- ---------------------------------------------------------------------------
create function public.portal_get_my_queue_status()
returns table (
  appointment_id     uuid,
  clinic_name        text,
  clinic_timezone    text,
  doctor_name        text,
  ticket_number      integer,
  state              public.queue_state,
  ahead              integer,
  estimated_start_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_authenticated();
  return query
  select a.id, c.display_name, c.timezone, d.full_name, q.ticket_number, q.state,
         (select count(*)::integer from public.queue_entries o
          where o.session_id = q.session_id and o.id <> q.id and o.state in ('waiting', 'called')
            and (o.priority_level > q.priority_level
                 or (o.priority_level = q.priority_level and (o.sort_key, o.ticket_number) < (q.sort_key, q.ticket_number)))),
         q.estimated_start_at
  from public.patient_accounts pa
  join public.clinics c       on c.id = pa.clinic_id
  join public.appointments a  on a.clinic_id = pa.clinic_id and a.patient_id = pa.patient_id
  join public.queue_entries q on q.clinic_id = a.clinic_id and q.appointment_id = a.id and q.state <> 'closed'
  join public.doctors d       on d.clinic_id = a.clinic_id and d.id = a.doctor_id
  where pa.user_id = (select auth.uid())
    and pa.revoked_at is null
    and c.status in ('active', 'suspended')
  order by q.checked_in_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- Jobs (scheduled with pg_cron where available; times in UTC, after local midnight in both
-- Morocco offsets)
-- ---------------------------------------------------------------------------
-- §3.3 "planned → closed: end-of-day job": past days still not closed are closed.
create function private.close_stale_sessions()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  update public.doctor_sessions s
     set status = 'closed', closed_at = now(), queue_version = s.queue_version + 1
    from public.clinics c
   where c.id = s.clinic_id and s.status <> 'closed'
     and s.service_date < (now() at time zone c.timezone)::date;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;
revoke all on function private.close_stale_sessions() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule('smartcabin-duration-stats', '30 2 * * *', 'select private.rebuild_consultation_duration_stats()');
    perform cron.schedule('smartcabin-overdue-estimates', '* * * * *', 'select private.refresh_overdue_estimates()');
    perform cron.schedule('smartcabin-close-stale-sessions', '10 0 * * *', 'select private.close_stale_sessions()');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.create_display_screen(uuid, text, uuid[]) from public, anon;
revoke all on function public.revoke_display_screen(uuid) from public, anon;
revoke all on function public.display_snapshot(text) from public;
revoke all on function public.portal_get_my_queue_status() from public, anon;
grant execute on function public.create_display_screen(uuid, text, uuid[]) to authenticated;
grant execute on function public.revoke_display_screen(uuid) to authenticated;
-- The only function callable without a session: the token is the credential.
grant execute on function public.display_snapshot(text) to anon, authenticated;
grant execute on function public.portal_get_my_queue_status() to authenticated;
