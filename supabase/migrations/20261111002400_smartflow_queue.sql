-- SmartCabin 0024 — Module 8a: SmartFlow queue flow, doctor's day, corrections, estimates v1.
--
-- BUSINESS_RULES §3 and API BC7:
--   call_next, recall_entry, start_consultation (A10), complete_consultation (A12);
--   set_queue_priority (BR-Q-05), move_queue_entry_before (BR-Q-06), both by a person with a reason;
--   correct_appointment_status: A13 (started by mistake, within 15 min) and A14 (late arrival
--   after a no-show, same day), owner/admin only, with a reason;
--   open_doctor_day, pause/resume/close_doctor_session, report_doctor_delay (§3.3);
--   wait-time estimates v1 (§3.2), recomputed at commit whenever the queue version changes.
-- Realtime broadcasts, display screens, portal status and notifications come later (module 8b/9).
--
-- Global lock order for every queue command (acyclic, so commands cannot deadlock each other):
--   appointment row → doctor bookings (0020) → doctor session row → queue entry rows.
-- mark_left (0023) locked the entry before the session; it is replaced below to follow the order.

-- ---------------------------------------------------------------------------
-- consultation_duration_stats — observed durations (derived, rebuilt nightly)
-- ---------------------------------------------------------------------------
create table public.consultation_duration_stats (
  clinic_id      uuid not null,
  doctor_id      uuid not null,
  service_id     uuid not null,
  sample_size    integer not null,
  median_minutes numeric not null,
  p80_minutes    numeric not null,
  window_days    integer not null default 90,
  computed_at    timestamptz not null default now(),
  primary key (clinic_id, doctor_id, service_id),
  constraint consultation_duration_stats_offer_fkey foreign key (clinic_id, doctor_id, service_id)
    references public.doctor_services (clinic_id, doctor_id, service_id) on delete cascade,
  constraint consultation_duration_stats_sample check (sample_size > 0),
  constraint consultation_duration_stats_minutes check (median_minutes > 0 and p80_minutes >= median_minutes)
);
alter table public.consultation_duration_stats enable row level security;
grant select on public.consultation_duration_stats to authenticated;
create policy consultation_duration_stats_select on public.consultation_duration_stats for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('queue.view'))
         and (clinic_id not in (select private.practitioner_only_clinics())
              or doctor_id in (select private.my_doctor_ids())));

-- Rebuilt from completed consultations of the last 90 days (scheduled nightly at deployment).
create function private.rebuild_consultation_duration_stats(p_clinic_id uuid default null)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  delete from public.consultation_duration_stats st where p_clinic_id is null or st.clinic_id = p_clinic_id;
  insert into public.consultation_duration_stats (clinic_id, doctor_id, service_id, sample_size, median_minutes, p80_minutes, window_days, computed_at)
  select d.clinic_id, d.doctor_id, a.service_id, count(*),
         percentile_cont(0.5) within group (order by d.minutes),
         percentile_cont(0.8) within group (order by d.minutes),
         90, now()
  from (
    select q.clinic_id, q.doctor_id, q.appointment_id,
           extract(epoch from (q.closed_at - q.consultation_started_at)) / 60 as minutes
    from public.queue_entries q
    where q.state = 'closed' and q.outcome = 'completed' and q.consultation_started_at is not null
      and q.closed_at > q.consultation_started_at
      and q.closed_at >= now() - interval '90 days'
      and (p_clinic_id is null or q.clinic_id = p_clinic_id)) as d
  join public.appointments a on a.clinic_id = d.clinic_id and a.id = d.appointment_id
  group by d.clinic_id, d.doctor_id, a.service_id;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- ---------------------------------------------------------------------------
-- Estimates v1 (BUSINESS_RULES §3.2)
-- ---------------------------------------------------------------------------
-- Expected minutes of a consultation: the observed median once 20 or more were measured,
-- otherwise the duration booked for the appointment (the effective service duration).
create function private.expected_minutes(p_clinic_id uuid, p_doctor_id uuid, p_service_id uuid, p_starts timestamptz, p_ends timestamptz)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select st.median_minutes from public.consultation_duration_stats st
     where st.clinic_id = p_clinic_id and st.doctor_id = p_doctor_id and st.service_id = p_service_id and st.sample_size >= 20),
    extract(epoch from (p_ends - p_starts)) / 60);
$$;

-- First window start of a doctor's local day (override beats regular), or null when not working.
create function private.first_window_start(p_doctor_id uuid, p_day date)
returns time
language sql
stable
security definer
set search_path = ''
as $$
  select min(a.start_time)
  from (select s.id from public.doctor_schedules s
        where s.doctor_id = p_doctor_id and s.valid_from <= p_day and (s.valid_until is null or s.valid_until >= p_day)
        order by (s.kind = 'override') desc
        limit 1) as sch
  join public.doctor_availability a on a.schedule_id = sch.id and a.weekday = extract(isodow from p_day)::smallint;
$$;

create function private.recompute_session_estimates(p_session_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session   public.doctor_sessions;
  v_tz        text;
  v_current   record;
  v_first     time;
  v_available timestamptz;
  v_entry     record;
begin
  select * into v_session from public.doctor_sessions s where s.id = p_session_id;
  if not found then
    return;
  end if;
  if v_session.status = 'closed' then
    update public.queue_entries q set estimated_start_at = null, estimate_computed_at = now()
     where q.session_id = p_session_id and q.state in ('waiting', 'called') and q.estimated_start_at is not null;
    return;
  end if;
  select c.timezone into v_tz from public.clinics c where c.id = v_session.clinic_id;

  select q.consultation_started_at,
         private.expected_minutes(q.clinic_id, q.doctor_id, a.service_id, a.starts_at, a.ends_at) as minutes
    into v_current
  from public.queue_entries q
  join public.appointments a on a.clinic_id = q.clinic_id and a.id = q.appointment_id
  where q.session_id = p_session_id and q.state = 'in_consultation';

  if found then
    v_available := greatest(now(), v_current.consultation_started_at + v_current.minutes * interval '1 minute');
  elsif v_session.status = 'paused' then
    v_available := now() + make_interval(mins => v_session.announced_delay_minutes);
  elsif v_session.status = 'open' then
    v_available := now();
  else
    -- Not started yet: the day's first window plus any announced delay.
    v_first := private.first_window_start(v_session.doctor_id, v_session.service_date);
    v_available := greatest(now(),
      coalesce((v_session.service_date + v_first) at time zone v_tz, now()) + make_interval(mins => v_session.announced_delay_minutes));
  end if;

  for v_entry in
    select q.id, private.expected_minutes(q.clinic_id, q.doctor_id, a.service_id, a.starts_at, a.ends_at) as minutes
    from public.queue_entries q
    join public.appointments a on a.clinic_id = q.clinic_id and a.id = q.appointment_id
    where q.session_id = p_session_id and q.state in ('waiting', 'called')
    order by q.priority_level desc, q.sort_key, q.ticket_number
  loop
    update public.queue_entries set estimated_start_at = v_available, estimate_computed_at = now() where id = v_entry.id;
    v_available := v_available + v_entry.minutes * interval '1 minute';
  end loop;
end;
$$;

-- Every queue change bumps doctor_sessions.queue_version (BR-Q-08); estimates follow at commit.
create function private.on_queue_version_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.recompute_session_estimates(new.id);
  return null;
end;
$$;
create constraint trigger doctor_sessions_recompute_estimates
  after update on public.doctor_sessions
  deferrable initially deferred
  for each row
  when (new.queue_version is distinct from old.queue_version or new.status is distinct from old.status)
  execute function private.on_queue_version_change();

-- For a scheduler (every minute): sessions whose current consultation has run past its expected end.
create function private.refresh_overdue_estimates()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session uuid;
  v_count   integer := 0;
begin
  for v_session in
    select q.session_id from public.queue_entries q
    join public.appointments a on a.clinic_id = q.clinic_id and a.id = q.appointment_id
    where q.state = 'in_consultation'
      and q.consultation_started_at + private.expected_minutes(q.clinic_id, q.doctor_id, a.service_id, a.starts_at, a.ends_at) * interval '1 minute' < now()
  loop
    perform private.recompute_session_estimates(v_session);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Authorization helpers (authorize on an unlocked read, then lock — like SC-AUD-18)
-- ---------------------------------------------------------------------------
create function private.lock_session_for_command(p_session_id uuid, p_permission text)
returns public.doctor_sessions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid;
  v_doctor_id uuid;
  v_session   public.doctor_sessions;
begin
  select s.clinic_id, s.doctor_id into v_clinic_id, v_doctor_id from public.doctor_sessions s where s.id = p_session_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.require_clinic_access(v_clinic_id);
  perform private.require_permission(v_clinic_id, p_permission);
  perform private.require_doctor_scope(v_clinic_id, v_doctor_id);
  select * into v_session from public.doctor_sessions s where s.id = p_session_id for update;
  return v_session;
end;
$$;

-- The session of an entry, authorized and locked (for commands that do not change the appointment).
create function private.lock_entry_session(p_entry_id uuid, p_permission text)
returns public.doctor_sessions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session_id uuid;
begin
  select q.session_id into v_session_id from public.queue_entries q where q.id = p_entry_id;
  if v_session_id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  return private.lock_session_for_command(v_session_id, p_permission);
end;
$$;

create function private.queue_session_usable(p_session public.doctor_sessions)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_session.status = 'closed' then
    raise exception using errcode = 'P0001', message = 'SESSION_CLOSED';
  elsif p_session.status = 'paused' then
    raise exception using errcode = 'P0001', message = 'SESSION_PAUSED';
  end if;
end;
$$;

revoke all on function private.rebuild_consultation_duration_stats(uuid) from public, anon, authenticated;
revoke all on function private.expected_minutes(uuid, uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function private.first_window_start(uuid, date) from public, anon, authenticated;
revoke all on function private.recompute_session_estimates(uuid) from public, anon, authenticated;
revoke all on function private.refresh_overdue_estimates() from public, anon, authenticated;
revoke all on function private.lock_session_for_command(uuid, text) from public, anon, authenticated;
revoke all on function private.lock_entry_session(uuid, text) from public, anon, authenticated;
revoke all on function private.queue_session_usable(public.doctor_sessions) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Doctor's day (§3.3) — queue.manage_session (doctors: their own day)
-- ---------------------------------------------------------------------------
create function public.open_doctor_day(p_doctor_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid;
  v_tz        text;
  v_session   public.doctor_sessions;
begin
  select d.clinic_id, c.timezone into v_clinic_id, v_tz
  from public.doctors d join public.clinics c on c.id = d.clinic_id where d.id = p_doctor_id;
  if v_clinic_id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.require_clinic_access(v_clinic_id);
  perform private.require_permission(v_clinic_id, 'queue.manage_session');
  perform private.require_doctor_scope(v_clinic_id, p_doctor_id);
  v_session := private.lock_doctor_session(v_clinic_id, p_doctor_id, (now() at time zone v_tz)::date);
  if v_session.status = 'open' then
    return v_session.id;
  end if;
  update public.doctor_sessions
     set status = 'open', opened_at = coalesce(opened_at, now()), queue_version = queue_version + 1
   where id = v_session.id;
  insert into public.queue_events (clinic_id, session_id, event_type, actor_user_id)
  values (v_clinic_id, v_session.id, case when v_session.status = 'paused' then 'session_resumed' else 'session_opened' end::public.queue_event_type, auth.uid());
  return v_session.id;
end;
$$;

create function public.pause_doctor_session(p_session_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session public.doctor_sessions := private.lock_session_for_command(p_session_id, 'queue.manage_session');
begin
  if v_session.status <> 'open' then
    raise exception using errcode = 'P0001', message = 'SESSION_INVALID_TRANSITION';
  end if;
  update public.doctor_sessions set status = 'paused', queue_version = queue_version + 1 where id = v_session.id;
  insert into public.queue_events (clinic_id, session_id, event_type, actor_user_id)
  values (v_session.clinic_id, v_session.id, 'session_paused', auth.uid());
end;
$$;

create function public.resume_doctor_session(p_session_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session public.doctor_sessions := private.lock_session_for_command(p_session_id, 'queue.manage_session');
begin
  if v_session.status <> 'paused' then
    raise exception using errcode = 'P0001', message = 'SESSION_INVALID_TRANSITION';
  end if;
  update public.doctor_sessions set status = 'open', queue_version = queue_version + 1 where id = v_session.id;
  insert into public.queue_events (clinic_id, session_id, event_type, actor_user_id)
  values (v_session.clinic_id, v_session.id, 'session_resumed', auth.uid());
end;
$$;

-- Closes the day. Refused while a consultation is in progress. Returns how many patients are still
-- waiting: staff resolve them (left, or cancelled and rebooked with another doctor).
create function public.close_doctor_session(p_session_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session public.doctor_sessions := private.lock_session_for_command(p_session_id, 'queue.manage_session');
  v_open    integer;
begin
  if v_session.status = 'closed' then
    raise exception using errcode = 'P0001', message = 'SESSION_INVALID_TRANSITION';
  end if;
  if exists (select 1 from public.queue_entries q where q.session_id = v_session.id and q.state = 'in_consultation') then
    raise exception using errcode = 'P0001', message = 'DOCTOR_BUSY';
  end if;
  select count(*) into v_open from public.queue_entries q where q.session_id = v_session.id and q.state in ('waiting', 'called');
  update public.doctor_sessions set status = 'closed', closed_at = now(), queue_version = queue_version + 1 where id = v_session.id;
  insert into public.queue_events (clinic_id, session_id, event_type, actor_user_id, details)
  values (v_session.clinic_id, v_session.id, 'session_closed', auth.uid(), jsonb_build_object('open_entries', v_open));
  return v_open;
end;
$$;

-- BR-Q-11: a reported delay shifts estimates. Patient messages come with notifications (module 9).
create function public.report_doctor_delay(p_doctor_id uuid, p_minutes integer)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid;
  v_tz        text;
  v_session   public.doctor_sessions;
begin
  select d.clinic_id, c.timezone into v_clinic_id, v_tz
  from public.doctors d join public.clinics c on c.id = d.clinic_id where d.id = p_doctor_id;
  if v_clinic_id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.require_clinic_access(v_clinic_id);
  perform private.require_permission(v_clinic_id, 'queue.manage_session');
  perform private.require_doctor_scope(v_clinic_id, p_doctor_id);
  if p_minutes is null or p_minutes not between 0 and 600 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'delay must be 0 to 600 minutes';
  end if;
  v_session := private.lock_doctor_session(v_clinic_id, p_doctor_id, (now() at time zone v_tz)::date);
  update public.doctor_sessions
     set announced_delay_minutes = p_minutes, delay_reported_at = now(), delay_reported_by = auth.uid(),
         queue_version = queue_version + 1
   where id = v_session.id;
  insert into public.queue_events (clinic_id, session_id, event_type, actor_user_id, details)
  values (v_clinic_id, v_session.id, 'delay_reported', auth.uid(), jsonb_build_object('minutes', p_minutes));
  perform private.emit_event(v_clinic_id, 'doctor_session', v_session.id, 'session.delay_reported');
  return v_session.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Calling (BR-Q-07) — queue.call (doctors: their own queue)
-- ---------------------------------------------------------------------------
create function public.call_next(p_session_id uuid)
returns table (queue_entry_id uuid, ticket_number integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_session public.doctor_sessions := private.lock_session_for_command(p_session_id, 'queue.call');
  v_entry   public.queue_entries;
begin
  perform private.queue_session_usable(v_session);
  select * into v_entry from public.queue_entries q
  where q.session_id = v_session.id and q.state = 'waiting'
  order by q.priority_level desc, q.sort_key, q.ticket_number
  limit 1
  for update;
  if not found then
    return;
  end if;
  update public.queue_entries set state = 'called', called_at = now(), call_count = call_count + 1 where id = v_entry.id;
  update public.doctor_sessions set queue_version = queue_version + 1 where id = v_session.id;
  insert into public.queue_events (clinic_id, session_id, queue_entry_id, event_type, actor_user_id, details)
  values (v_session.clinic_id, v_session.id, v_entry.id, 'called', auth.uid(),
          jsonb_build_object('ticket_number', v_entry.ticket_number, 'call_count', v_entry.call_count + 1));
  return query select v_entry.id, v_entry.ticket_number;
end;
$$;

-- A called patient who is not there goes back to waiting and keeps their place (BR-Q-07).
create function public.recall_entry(p_queue_entry_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session public.doctor_sessions := private.lock_entry_session(p_queue_entry_id, 'queue.call');
  v_entry   public.queue_entries;
begin
  select * into v_entry from public.queue_entries q where q.id = p_queue_entry_id for update;
  if v_entry.state <> 'called' then
    raise exception using errcode = 'P0001', message = 'APPT_INVALID_TRANSITION';
  end if;
  update public.queue_entries set state = 'waiting' where id = v_entry.id;
  update public.doctor_sessions set queue_version = queue_version + 1 where id = v_session.id;
  insert into public.queue_events (clinic_id, session_id, queue_entry_id, event_type, actor_user_id, details)
  values (v_session.clinic_id, v_session.id, v_entry.id, 'recalled', auth.uid(), jsonb_build_object('ticket_number', v_entry.ticket_number));
end;
$$;

-- ---------------------------------------------------------------------------
-- Consultation (A10, A12) — appointment and queue entry change in one transaction
-- ---------------------------------------------------------------------------
create function public.start_consultation(p_queue_entry_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_appointment uuid;
  v_appt        public.appointments;
  v_session     public.doctor_sessions;
  v_entry       public.queue_entries;
begin
  select q.appointment_id into v_appointment from public.queue_entries q where q.id = p_queue_entry_id;
  if v_appointment is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_appt := private.lock_appointment_for_command(v_appointment, 'queue.start', null);
  select s.* into v_session from public.doctor_sessions s
  join public.queue_entries q on q.session_id = s.id where q.id = p_queue_entry_id
  for update of s;
  perform private.queue_session_usable(v_session);
  select * into v_entry from public.queue_entries q where q.id = p_queue_entry_id for update;
  if v_entry.state not in ('waiting', 'called') or v_appt.status <> 'checked_in' then
    raise exception using errcode = 'P0001', message = 'APPT_INVALID_TRANSITION';
  end if;
  -- BR-Q-03: one patient at a time per doctor (also a partial unique index).
  if exists (select 1 from public.queue_entries q where q.session_id = v_session.id and q.state = 'in_consultation') then
    raise exception using errcode = 'P0001', message = 'DOCTOR_BUSY';
  end if;

  update public.doctor_sessions
     set status = 'open', opened_at = coalesce(opened_at, now()), queue_version = queue_version + 1
   where id = v_session.id;
  if v_session.status = 'planned' then
    insert into public.queue_events (clinic_id, session_id, event_type, actor_user_id)
    values (v_session.clinic_id, v_session.id, 'session_opened', auth.uid());
  end if;
  perform set_config('smartcabin.change_reason', '', true);
  update public.appointments set status = 'in_progress', started_at = now() where id = v_appt.id;
  update public.queue_entries set state = 'in_consultation', consultation_started_at = now() where id = v_entry.id;
  insert into public.queue_events (clinic_id, session_id, queue_entry_id, event_type, actor_user_id, details)
  values (v_session.clinic_id, v_session.id, v_entry.id, 'consultation_started', auth.uid(), jsonb_build_object('ticket_number', v_entry.ticket_number));
end;
$$;

create function public.complete_consultation(p_queue_entry_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_appointment uuid;
  v_appt        public.appointments;
  v_session     public.doctor_sessions;
  v_entry       public.queue_entries;
begin
  select q.appointment_id into v_appointment from public.queue_entries q where q.id = p_queue_entry_id;
  if v_appointment is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_appt := private.lock_appointment_for_command(v_appointment, 'queue.complete', null);
  select s.* into v_session from public.doctor_sessions s
  join public.queue_entries q on q.session_id = s.id where q.id = p_queue_entry_id
  for update of s;
  select * into v_entry from public.queue_entries q where q.id = p_queue_entry_id for update;
  if v_entry.state <> 'in_consultation' or v_appt.status <> 'in_progress' then
    raise exception using errcode = 'P0001', message = 'APPT_INVALID_TRANSITION';
  end if;

  update public.doctor_sessions set queue_version = queue_version + 1 where id = v_session.id;
  perform set_config('smartcabin.change_reason', '', true);
  update public.appointments set status = 'completed', completed_at = now() where id = v_appt.id;
  update public.queue_entries set state = 'closed', outcome = 'completed', closed_at = now() where id = v_entry.id;
  insert into public.queue_events (clinic_id, session_id, queue_entry_id, event_type, actor_user_id, details)
  values (v_session.clinic_id, v_session.id, v_entry.id, 'consultation_completed', auth.uid(),
          jsonb_build_object('ticket_number', v_entry.ticket_number,
                             'minutes', round(extract(epoch from (now() - v_entry.consultation_started_at)) / 60)));
  perform private.emit_event(v_appt.clinic_id, 'appointment', v_appt.id, 'consultation.completed');
end;
$$;

-- ---------------------------------------------------------------------------
-- Priority (BR-Q-05) and manual reorder (BR-Q-06): a person decides, with a reason
-- ---------------------------------------------------------------------------
create function public.set_queue_priority(p_queue_entry_id uuid, p_level smallint, p_reason public.priority_reason default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session public.doctor_sessions := private.lock_entry_session(p_queue_entry_id, 'queue.prioritize');
  v_entry   public.queue_entries;
begin
  if v_session.status = 'closed' then
    raise exception using errcode = 'P0001', message = 'SESSION_CLOSED';
  end if;
  if p_level is null or p_level not in (0, 1) or (p_level = 1 and p_reason is null) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'priority 1 requires a reason';
  end if;
  select * into v_entry from public.queue_entries q where q.id = p_queue_entry_id for update;
  if v_entry.state not in ('waiting', 'called') then
    raise exception using errcode = 'P0001', message = 'APPT_INVALID_TRANSITION';
  end if;
  update public.queue_entries
     set priority_level = p_level,
         priority_reason = case when p_level = 1 then p_reason end,
         priority_set_by = case when p_level = 1 then auth.uid() end
   where id = v_entry.id;
  update public.doctor_sessions set queue_version = queue_version + 1 where id = v_session.id;
  insert into public.queue_events (clinic_id, session_id, queue_entry_id, event_type, actor_user_id, reason, details)
  values (v_session.clinic_id, v_session.id, v_entry.id, 'priority_changed', auth.uid(), p_reason::text,
          jsonb_build_object('ticket_number', v_entry.ticket_number, 'level', p_level));
end;
$$;

-- Places an entry just before another one of the same priority level. When the two neighbours
-- share the same sort key (identical appointment times), the entry also passes the earlier one.
create function public.move_queue_entry_before(p_queue_entry_id uuid, p_before_entry_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session public.doctor_sessions := private.lock_entry_session(p_queue_entry_id, 'queue.reorder');
  v_entry   public.queue_entries;
  v_before  public.queue_entries;
  v_prev    numeric;
  v_key     numeric;
begin
  if v_session.status = 'closed' then
    raise exception using errcode = 'P0001', message = 'SESSION_CLOSED';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 300 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'a reason is required';
  end if;
  perform 1 from public.queue_entries q where q.id in (p_queue_entry_id, p_before_entry_id) order by q.id for update;
  select * into v_entry from public.queue_entries q where q.id = p_queue_entry_id;
  select * into v_before from public.queue_entries q where q.id = p_before_entry_id;
  if v_before.id is null or v_before.session_id <> v_entry.session_id or v_before.id = v_entry.id
     or v_entry.state not in ('waiting', 'called') or v_before.state not in ('waiting', 'called')
     or v_entry.priority_level <> v_before.priority_level then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'same queue, same priority, both waiting';
  end if;
  select q.sort_key into v_prev from public.queue_entries q
  where q.session_id = v_entry.session_id and q.state in ('waiting', 'called') and q.id <> v_entry.id
    and q.priority_level = v_before.priority_level
    and (q.sort_key, q.ticket_number) < (v_before.sort_key, v_before.ticket_number)
  order by q.sort_key desc, q.ticket_number desc
  limit 1;
  v_key := case
    when v_prev is null or v_prev >= v_before.sort_key then v_before.sort_key - 1
    else (v_prev + v_before.sort_key) / 2 end;
  update public.queue_entries set sort_key = v_key where id = v_entry.id;
  update public.doctor_sessions set queue_version = queue_version + 1 where id = v_session.id;
  insert into public.queue_events (clinic_id, session_id, queue_entry_id, event_type, actor_user_id, reason, details)
  values (v_session.clinic_id, v_session.id, v_entry.id, 'reordered', auth.uid(), btrim(p_reason),
          jsonb_build_object('ticket_number', v_entry.ticket_number, 'before_ticket', v_before.ticket_number));
end;
$$;

-- ---------------------------------------------------------------------------
-- Audited corrections (A13, A14) — appointments.correct_status, with a reason
-- ---------------------------------------------------------------------------
create function public.correct_appointment_status(p_appointment_id uuid, p_target public.appointment_status, p_reason text)
returns table (queue_entry_id uuid, ticket_number integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_appt    public.appointments;
  v_tz      text;
  v_today   date;
  v_session public.doctor_sessions;
  v_entry   public.queue_entries;
  v_ticket  integer;
  v_new     uuid;
begin
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 300 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'a reason is required';
  end if;
  v_appt := private.lock_appointment_for_command(p_appointment_id, 'appointments.correct_status', null);
  perform set_config('smartcabin.change_reason', btrim(p_reason), true);

  if v_appt.status = 'in_progress' and p_target = 'checked_in' then
    -- A13: consultation started by mistake, back to waiting with the same place.
    if now() > v_appt.started_at + interval '15 minutes' then
      raise exception using errcode = 'P0001', message = 'CORRECTION_WINDOW_PASSED';
    end if;
    select s.* into v_session from public.doctor_sessions s
    join public.queue_entries q on q.session_id = s.id
    where q.appointment_id = v_appt.id and q.state = 'in_consultation'
    for update of s;
    update public.appointments set status = 'checked_in', started_at = null where id = v_appt.id;
    if v_session.id is not null then
      select * into v_entry from public.queue_entries q where q.session_id = v_session.id and q.appointment_id = v_appt.id
        and q.state = 'in_consultation' for update;
      update public.queue_entries set state = 'waiting', consultation_started_at = null where id = v_entry.id;
      update public.doctor_sessions set queue_version = queue_version + 1 where id = v_session.id;
      insert into public.queue_events (clinic_id, session_id, queue_entry_id, event_type, actor_user_id, reason, details)
      values (v_session.clinic_id, v_session.id, v_entry.id, 'correction', auth.uid(), btrim(p_reason),
              jsonb_build_object('from', 'in_progress', 'to', 'checked_in'));
      return query select v_entry.id, v_entry.ticket_number;
    end if;
    return;
  elsif v_appt.status = 'no_show' and p_target = 'checked_in' then
    -- A14: late arrival after a no-show, same local day: a new ticket, queued at arrival time.
    select c.timezone into v_tz from public.clinics c where c.id = v_appt.clinic_id;
    v_today := (now() at time zone v_tz)::date;
    if (v_appt.starts_at at time zone v_tz)::date <> v_today then
      raise exception using errcode = 'P0001', message = 'CHECK_IN_NOT_TODAY';
    end if;
    perform private.lock_doctor_bookings(v_appt.doctor_id);
    v_session := private.lock_doctor_session(v_appt.clinic_id, v_appt.doctor_id, v_today);
    v_ticket := private.take_ticket(v_session.id);
    begin
      update public.appointments set status = 'checked_in', checked_in_at = now(), no_show_at = null where id = v_appt.id;
    exception when exclusion_violation then
      raise exception using errcode = 'P0001', message = 'SLOT_UNAVAILABLE', detail = 'the time was booked again';
    end;
    insert into public.queue_entries (clinic_id, session_id, appointment_id, doctor_id, ticket_number, sort_key, checked_in_at)
    values (v_appt.clinic_id, v_session.id, v_appt.id, v_appt.doctor_id, v_ticket, extract(epoch from now()), now())
    returning id into v_new;
    insert into public.queue_events (clinic_id, session_id, queue_entry_id, event_type, actor_user_id, reason, details)
    values (v_appt.clinic_id, v_session.id, v_new, 'correction', auth.uid(), btrim(p_reason),
            jsonb_build_object('from', 'no_show', 'to', 'checked_in', 'ticket_number', v_ticket));
    return query select v_new, v_ticket;
  else
    raise exception using errcode = 'P0001', message = 'APPT_INVALID_TRANSITION';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- mark_left — as in 0023, with the global lock order (session before entry)
-- ---------------------------------------------------------------------------
create or replace function public.mark_left(p_queue_entry_id uuid, p_note text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_appointment uuid;
  v_appt        public.appointments;
  v_session     public.doctor_sessions;
  v_entry       public.queue_entries;
begin
  select q.appointment_id into v_appointment from public.queue_entries q where q.id = p_queue_entry_id;
  if v_appointment is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_appt := private.lock_appointment_for_command(v_appointment, 'queue.mark_left', null);
  select s.* into v_session from public.doctor_sessions s
  join public.queue_entries q on q.session_id = s.id where q.id = p_queue_entry_id
  for update of s;
  select * into v_entry from public.queue_entries q where q.id = p_queue_entry_id for update;
  if v_entry.state not in ('waiting', 'called') or v_appt.status <> 'checked_in' then
    raise exception using errcode = 'P0001', message = 'APPT_INVALID_TRANSITION';
  end if;

  update public.doctor_sessions set queue_version = queue_version + 1 where id = v_session.id;
  perform set_config('smartcabin.change_reason', coalesce(left(btrim(p_note), 300), ''), true);
  update public.appointments
     set status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = auth.uid(),
         cancellation_actor = 'clinic', cancellation_reason = 'left_before_consultation'
   where id = v_appt.id;
  update public.queue_entries set state = 'closed', outcome = 'left', closed_at = now() where id = v_entry.id;
  insert into public.queue_events (clinic_id, session_id, queue_entry_id, event_type, actor_user_id, reason)
  values (v_entry.clinic_id, v_entry.session_id, v_entry.id, 'left', auth.uid(), nullif(left(btrim(p_note), 300), ''));
  perform private.emit_event(v_appt.clinic_id, 'appointment', v_appt.id, 'appointment.cancelled');
  return v_appt.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.open_doctor_day(uuid) from public, anon;
revoke all on function public.pause_doctor_session(uuid) from public, anon;
revoke all on function public.resume_doctor_session(uuid) from public, anon;
revoke all on function public.close_doctor_session(uuid) from public, anon;
revoke all on function public.report_doctor_delay(uuid, integer) from public, anon;
revoke all on function public.call_next(uuid) from public, anon;
revoke all on function public.recall_entry(uuid) from public, anon;
revoke all on function public.start_consultation(uuid) from public, anon;
revoke all on function public.complete_consultation(uuid) from public, anon;
revoke all on function public.set_queue_priority(uuid, smallint, public.priority_reason) from public, anon;
revoke all on function public.move_queue_entry_before(uuid, uuid, text) from public, anon;
revoke all on function public.correct_appointment_status(uuid, public.appointment_status, text) from public, anon;
grant execute on function public.open_doctor_day(uuid) to authenticated;
grant execute on function public.pause_doctor_session(uuid) to authenticated;
grant execute on function public.resume_doctor_session(uuid) to authenticated;
grant execute on function public.close_doctor_session(uuid) to authenticated;
grant execute on function public.report_doctor_delay(uuid, integer) to authenticated;
grant execute on function public.call_next(uuid) to authenticated;
grant execute on function public.recall_entry(uuid) to authenticated;
grant execute on function public.start_consultation(uuid) to authenticated;
grant execute on function public.complete_consultation(uuid) to authenticated;
grant execute on function public.set_queue_priority(uuid, smallint, public.priority_reason) to authenticated;
grant execute on function public.move_queue_entry_before(uuid, uuid, text) to authenticated;
grant execute on function public.correct_appointment_status(uuid, public.appointment_status, text) to authenticated;
