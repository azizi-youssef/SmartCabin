-- SmartCabin 0023 — Module 7: reception (check-in, walk-ins, left before consultation).
--
-- Queue foundation of the Patient Flow context (DOMAIN_MODEL BC7, BUSINESS_RULES §3):
--   doctor_sessions  one doctor's day: gapless ticket counter, queue version (created lazily);
--   queue_entries    a checked-in appointment's place in that doctor's queue;
--   queue_events     append-only operational trail.
-- Commands: check_in_appointment (A8), register_walk_in (A3), mark_left (A11).
-- The appointment status stays authoritative: a deferred constraint trigger rejects any queue
-- state that does not match it (BUSINESS_RULES §3 mapping).
--
-- Walk-ins (MD-10) queue behind the agenda: they no longer count in the overlap constraint nor in
-- the free-slot computation, otherwise a walk-in during a booked time would be refused.
-- Calling, consultations, priorities, estimates and broadcasts come with module 8 (SmartFlow).
--
-- Lock order (acyclic): appointment row → doctor bookings (0020) → doctor session row.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.session_status as enum ('planned', 'open', 'paused', 'closed');
create type public.queue_state as enum ('waiting', 'called', 'in_consultation', 'closed');
create type public.queue_outcome as enum ('completed', 'left', 'cancelled');
create type public.priority_reason as enum ('elderly', 'pregnancy', 'disability', 'young_child', 'staff_judgement', 'other');
create type public.queue_event_type as enum (
  'checked_in', 'walk_in_registered', 'called', 'recalled', 'priority_changed', 'reordered',
  'consultation_started', 'consultation_completed', 'left', 'correction',
  'session_opened', 'session_paused', 'session_resumed', 'session_closed', 'delay_reported');

-- ---------------------------------------------------------------------------
-- doctor_sessions — one doctor's day (command table)
-- ---------------------------------------------------------------------------
create table public.doctor_sessions (
  id                      uuid primary key default gen_random_uuid(),
  clinic_id               uuid not null references public.clinics (id),
  doctor_id               uuid not null,
  service_date            date not null,
  status                  public.session_status not null default 'planned',
  opened_at               timestamptz,
  closed_at               timestamptz,
  announced_delay_minutes integer not null default 0,
  delay_reported_at       timestamptz,
  delay_reported_by       uuid references auth.users (id),
  next_ticket_number      integer not null default 1,
  queue_version           bigint not null default 0,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint doctor_sessions_clinic_id_id_key unique (clinic_id, id),
  constraint doctor_sessions_clinic_id_id_doctor_key unique (clinic_id, id, doctor_id),
  constraint doctor_sessions_one_per_day unique (clinic_id, doctor_id, service_date),
  constraint doctor_sessions_doctor_fkey foreign key (clinic_id, doctor_id) references public.doctors (clinic_id, id),
  constraint doctor_sessions_delay check (announced_delay_minutes between 0 and 600),
  constraint doctor_sessions_ticket check (next_ticket_number >= 1),
  constraint doctor_sessions_queue_version check (queue_version >= 0),
  constraint doctor_sessions_closed_coherent check ((status = 'closed') = (closed_at is not null))
);
create trigger doctor_sessions_set_updated_at
  before update on public.doctor_sessions
  for each row execute function private.set_updated_at();
create trigger doctor_sessions_tenant_immutable
  before update on public.doctor_sessions
  for each row execute function private.forbid_clinic_id_change();

-- ---------------------------------------------------------------------------
-- queue_entries — a checked-in appointment's place in the queue (command table)
-- ---------------------------------------------------------------------------
-- A queue entry, its session and its appointment always share clinic and doctor (composite FKs).
alter table public.appointments add constraint appointments_clinic_id_id_doctor_key unique (clinic_id, id, doctor_id);

create table public.queue_entries (
  id                      uuid primary key default gen_random_uuid(),
  clinic_id               uuid not null references public.clinics (id),
  session_id              uuid not null,
  appointment_id          uuid not null,
  doctor_id               uuid not null,
  ticket_number           integer not null,
  state                   public.queue_state not null default 'waiting',
  outcome                 public.queue_outcome,
  priority_level          smallint not null default 0,
  priority_reason         public.priority_reason,
  priority_set_by         uuid references auth.users (id),
  sort_key                numeric not null,
  checked_in_at           timestamptz not null default now(),
  called_at               timestamptz,
  call_count              integer not null default 0,
  consultation_started_at timestamptz,
  closed_at               timestamptz,
  estimated_start_at      timestamptz,
  estimate_computed_at    timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint queue_entries_clinic_id_id_key unique (clinic_id, id),
  constraint queue_entries_session_fkey foreign key (clinic_id, session_id, doctor_id)
    references public.doctor_sessions (clinic_id, id, doctor_id),
  constraint queue_entries_appointment_fkey foreign key (clinic_id, appointment_id, doctor_id)
    references public.appointments (clinic_id, id, doctor_id),
  constraint queue_entries_ticket_key unique (session_id, ticket_number),
  constraint queue_entries_ticket_positive check (ticket_number >= 1),
  constraint queue_entries_outcome_coherent check (
    (state = 'closed') = (outcome is not null) and (state = 'closed') = (closed_at is not null)),
  constraint queue_entries_priority check (priority_level in (0, 1)),
  constraint queue_entries_priority_coherent check (
    (priority_level = 1) = (priority_reason is not null and priority_set_by is not null)),
  constraint queue_entries_call_count check (call_count >= 0)
);
-- At most one open entry per appointment, and one patient at a time per doctor (BR-Q-03).
create unique index queue_entries_one_open_per_appointment on public.queue_entries (appointment_id) where state <> 'closed';
create unique index queue_entries_one_in_consultation on public.queue_entries (session_id) where state = 'in_consultation';
create index queue_entries_queue_order_idx on public.queue_entries (session_id, priority_level desc, sort_key, ticket_number)
  where state in ('waiting', 'called');

create function private.queue_entries_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.session_id is distinct from old.session_id
     or new.appointment_id is distinct from old.appointment_id
     or new.doctor_id is distinct from old.doctor_id
     or new.ticket_number is distinct from old.ticket_number
     or new.checked_in_at is distinct from old.checked_in_at
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = 'P0001', message = 'QUEUE_FIELD_IMMUTABLE';
  end if;
  if old.state = 'closed' then
    raise exception using errcode = 'P0001', message = 'APPT_INVALID_TRANSITION', detail = 'a closed queue entry is final';
  end if;
  return new;
end;
$$;
create trigger queue_entries_guard
  before update on public.queue_entries
  for each row execute function private.queue_entries_guard();
create trigger queue_entries_set_updated_at
  before update on public.queue_entries
  for each row execute function private.set_updated_at();
create trigger queue_entries_tenant_immutable
  before update on public.queue_entries
  for each row execute function private.forbid_clinic_id_change();

-- ---------------------------------------------------------------------------
-- queue_events — append-only operational trail (ids and numbers only in details)
-- ---------------------------------------------------------------------------
create table public.queue_events (
  id             bigint generated always as identity primary key,
  clinic_id      uuid not null,
  session_id     uuid not null,
  queue_entry_id uuid,
  event_type     public.queue_event_type not null,
  actor_user_id  uuid,
  reason         text,
  details        jsonb not null default '{}',
  occurred_at    timestamptz not null default now(),
  constraint queue_events_session_fkey foreign key (clinic_id, session_id) references public.doctor_sessions (clinic_id, id),
  constraint queue_events_entry_fkey foreign key (clinic_id, queue_entry_id) references public.queue_entries (clinic_id, id),
  constraint queue_events_reason_length check (reason is null or char_length(reason) <= 300),
  constraint queue_events_details_object check (jsonb_typeof(details) = 'object')
);
create index queue_events_session_idx on public.queue_events (session_id, occurred_at);
create trigger queue_events_append_only
  before update or delete on public.queue_events
  for each row execute function private.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Queue state ↔ appointment status (BUSINESS_RULES §3), checked at commit
-- ---------------------------------------------------------------------------
create function private.check_queue_matches_appointment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment uuid;
  v_state       public.queue_state;
  v_outcome     public.queue_outcome;
  v_status      public.appointment_status;
  v_reason      public.cancellation_reason;
begin
  if tg_table_name = 'queue_entries' then
    v_appointment := new.appointment_id;
  else
    v_appointment := new.id;
  end if;
  -- The latest entry describes the appointment (a corrected no-show gets a new entry later).
  select q.state, q.outcome into v_state, v_outcome
  from public.queue_entries q
  where q.appointment_id = v_appointment
  order by q.created_at desc, q.ticket_number desc
  limit 1;
  if not found then
    return null;
  end if;
  select a.status, a.cancellation_reason into v_status, v_reason from public.appointments a where a.id = v_appointment;
  if not (
       (v_state in ('waiting', 'called') and v_status = 'checked_in')
    or (v_state = 'in_consultation' and v_status = 'in_progress')
    or (v_state = 'closed' and v_outcome = 'completed' and v_status = 'completed')
    or (v_state = 'closed' and v_outcome = 'left' and v_status = 'cancelled' and v_reason = 'left_before_consultation')
    or (v_state = 'closed' and v_outcome = 'cancelled' and v_status = 'cancelled')) then
    raise exception using errcode = 'P0001', message = 'QUEUE_STATUS_MISMATCH',
      detail = format('queue %s/%s does not match appointment %s', v_state, coalesce(v_outcome::text, '-'), v_status);
  end if;
  return null;
end;
$$;
create constraint trigger queue_entries_match_appointment
  after insert or update on public.queue_entries
  deferrable initially deferred
  for each row execute function private.check_queue_matches_appointment();
create constraint trigger appointments_match_queue
  after update of status on public.appointments
  deferrable initially deferred
  for each row execute function private.check_queue_matches_appointment();

-- ---------------------------------------------------------------------------
-- RLS (queue.view; a practitioner-only doctor sees their own queue only)
-- ---------------------------------------------------------------------------
alter table public.doctor_sessions enable row level security;
alter table public.queue_entries enable row level security;
alter table public.queue_events enable row level security;

grant select on public.doctor_sessions to authenticated;
grant select on public.queue_entries to authenticated;
grant select on public.queue_events to authenticated;

create policy doctor_sessions_select on public.doctor_sessions for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('queue.view'))
         and (clinic_id not in (select private.practitioner_only_clinics())
              or doctor_id in (select private.my_doctor_ids())));
create policy queue_entries_select on public.queue_entries for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('queue.view'))
         and (clinic_id not in (select private.practitioner_only_clinics())
              or doctor_id in (select private.my_doctor_ids())));
-- Visibility follows the session (the sub-select is itself filtered by doctor_sessions_select).
create policy queue_events_select on public.queue_events for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('queue.view'))
         and exists (select 1 from public.doctor_sessions s where s.id = session_id));

-- ---------------------------------------------------------------------------
-- Walk-ins do not reserve agenda time (MD-10)
-- ---------------------------------------------------------------------------
alter table public.appointments drop constraint appointments_no_overlap;
alter table public.appointments add constraint appointments_no_overlap exclude using gist (
  doctor_id with =, tstzrange(starts_at, ends_at, '[)') with &&)
  where (status in ('pending', 'confirmed', 'checked_in', 'in_progress') and not is_overbooked and source <> 'walk_in');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- The doctor's session for a local day, created if needed, locked until commit.
create function private.lock_doctor_session(p_clinic_id uuid, p_doctor_id uuid, p_day date)
returns public.doctor_sessions
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session public.doctor_sessions;
begin
  insert into public.doctor_sessions (clinic_id, doctor_id, service_date)
  values (p_clinic_id, p_doctor_id, p_day)
  on conflict (clinic_id, doctor_id, service_date) do nothing;
  select * into v_session from public.doctor_sessions s
  where s.clinic_id = p_clinic_id and s.doctor_id = p_doctor_id and s.service_date = p_day
  for update;
  if v_session.status = 'closed' then
    raise exception using errcode = 'P0001', message = 'SESSION_CLOSED';
  end if;
  return v_session;
end;
$$;

-- Next gapless ticket of a locked session; also bumps the queue version (BR-Q-02, BR-Q-08).
create function private.take_ticket(p_session_id uuid)
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  update public.doctor_sessions
     set next_ticket_number = next_ticket_number + 1, queue_version = queue_version + 1
   where id = p_session_id
  returning next_ticket_number - 1;
$$;

revoke all on function private.lock_doctor_session(uuid, uuid, date) from public, anon, authenticated;
revoke all on function private.take_ticket(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- check_in_appointment (A8)
-- ---------------------------------------------------------------------------
create function public.check_in_appointment(p_appointment_id uuid, p_expected_version integer default null)
returns table (queue_entry_id uuid, ticket_number integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_appt    public.appointments := private.lock_appointment_for_command(p_appointment_id, 'queue.check_in', p_expected_version);
  v_tz      text;
  v_grace   integer;
  v_today   date;
  v_session public.doctor_sessions;
  v_ticket  integer;
  v_anchor  timestamptz;
  v_entry   uuid;
begin
  if v_appt.status <> 'confirmed' then
    raise exception using errcode = 'P0001', message = 'APPT_INVALID_TRANSITION';
  end if;
  select c.timezone, coalesce(s.checkin_grace_minutes, 15) into v_tz, v_grace
  from public.clinics c left join public.clinic_settings s on s.clinic_id = c.id
  where c.id = v_appt.clinic_id;
  v_today := (now() at time zone v_tz)::date;
  if (v_appt.starts_at at time zone v_tz)::date <> v_today then
    raise exception using errcode = 'P0001', message = 'CHECK_IN_NOT_TODAY';
  end if;

  perform private.lock_doctor_bookings(v_appt.doctor_id);
  v_session := private.lock_doctor_session(v_appt.clinic_id, v_appt.doctor_id, v_today);
  v_ticket := private.take_ticket(v_session.id);
  -- BR-Q-04: on time (within the grace period) → queued by appointment time; late → by arrival.
  v_anchor := case when now() <= v_appt.starts_at + make_interval(mins => v_grace) then v_appt.starts_at else now() end;

  perform set_config('smartcabin.change_reason', '', true);
  update public.appointments set status = 'checked_in', checked_in_at = now() where id = v_appt.id;
  insert into public.queue_entries (clinic_id, session_id, appointment_id, doctor_id, ticket_number, sort_key, checked_in_at)
  values (v_appt.clinic_id, v_session.id, v_appt.id, v_appt.doctor_id, v_ticket, extract(epoch from v_anchor), now())
  returning id into v_entry;
  insert into public.queue_events (clinic_id, session_id, queue_entry_id, event_type, actor_user_id, details)
  values (v_appt.clinic_id, v_session.id, v_entry, 'checked_in', auth.uid(),
          jsonb_build_object('ticket_number', v_ticket, 'late', v_anchor <> v_appt.starts_at));

  return query select v_entry, v_ticket;
end;
$$;

-- ---------------------------------------------------------------------------
-- register_walk_in (A3) — appointment created checked in, then its ticket
-- ---------------------------------------------------------------------------
create function public.register_walk_in(
  p_patient_id      uuid,
  p_doctor_id       uuid,
  p_service_id      uuid,
  p_idempotency_key text default null,
  p_patient_reason  text default null)
returns table (appointment_id uuid, queue_entry_id uuid, ticket_number integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_clinic_id uuid;
  v_status    public.clinic_status;
  v_tz        text;
  v_today     date;
  v_duration  integer;
  v_price     numeric;
  v_session   public.doctor_sessions;
  v_ticket    integer;
  v_start     timestamptz;
  v_appt      uuid;
  v_entry     uuid;
  v_existing  record;
begin
  select d.clinic_id into v_clinic_id from public.doctors d where d.id = p_doctor_id;
  if v_clinic_id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.require_clinic_access(v_clinic_id);
  perform private.require_permission(v_clinic_id, 'queue.check_in');
  perform private.require_doctor_scope(v_clinic_id, p_doctor_id);

  -- BR-B-10: a retried request with the same key returns the first registration.
  if p_idempotency_key is not null then
    if char_length(p_idempotency_key) not between 8 and 100 then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'idempotency key length';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(v_clinic_id::text || ':' || p_idempotency_key, 0));
    select a.id, a.patient_id, a.doctor_id, a.service_id, a.source, q.id as entry_id, q.ticket_number as ticket
      into v_existing
    from public.appointments a
    left join public.queue_entries q on q.appointment_id = a.id
    where a.clinic_id = v_clinic_id and a.idempotency_key = p_idempotency_key
    order by q.created_at desc nulls last
    limit 1;
    if found then
      if v_existing.source <> 'walk_in' or v_existing.patient_id <> p_patient_id
         or v_existing.doctor_id <> p_doctor_id or v_existing.service_id <> p_service_id then
        raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
      end if;
      return query select v_existing.id, v_existing.entry_id, v_existing.ticket;
      return;
    end if;
  end if;

  select c.status, c.timezone into v_status, v_tz from public.clinics c where c.id = v_clinic_id;
  if v_status not in ('active', 'pending_approval') then
    raise exception using errcode = 'P0001', message = 'CLINIC_NOT_ACTIVE';
  end if;
  if not exists (select 1 from public.patients p
                 where p.clinic_id = v_clinic_id and p.id = p_patient_id and p.status = 'active') then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND', detail = 'patient';
  end if;
  select e.duration_minutes, e.price_mad into v_duration, v_price
  from private.effective_service(v_clinic_id, p_doctor_id, p_service_id, false) e;

  v_today := (now() at time zone v_tz)::date;
  v_session := private.lock_doctor_session(v_clinic_id, p_doctor_id, v_today);
  v_ticket := private.take_ticket(v_session.id);
  -- A walk-in is recorded at arrival time, on the 5-minute grid of appointments.
  v_start := to_timestamp(floor(extract(epoch from now()) / 300) * 300);

  perform set_config('smartcabin.change_reason', '', true);
  insert into public.appointments (
    clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, source,
    patient_reason, price_mad, idempotency_key, booked_by_user_id, checked_in_at)
  values (
    v_clinic_id, p_patient_id, p_doctor_id, p_service_id, v_start, v_start + make_interval(mins => v_duration),
    'checked_in', 'walk_in', nullif(btrim(p_patient_reason), ''), v_price, p_idempotency_key, auth.uid(), now())
  returning id into v_appt;
  insert into public.queue_entries (clinic_id, session_id, appointment_id, doctor_id, ticket_number, sort_key, checked_in_at)
  values (v_clinic_id, v_session.id, v_appt, p_doctor_id, v_ticket, extract(epoch from now()), now())
  returning id into v_entry;
  insert into public.queue_events (clinic_id, session_id, queue_entry_id, event_type, actor_user_id, details)
  values (v_clinic_id, v_session.id, v_entry, 'walk_in_registered', auth.uid(), jsonb_build_object('ticket_number', v_ticket));
  perform private.emit_event(v_clinic_id, 'appointment', v_appt, 'appointment.booked');

  return query select v_appt, v_entry, v_ticket;
end;
$$;

-- ---------------------------------------------------------------------------
-- mark_left (A11) — the patient left before the consultation
-- ---------------------------------------------------------------------------
create function public.mark_left(p_queue_entry_id uuid, p_note text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_appointment uuid;
  v_appt        public.appointments;
  v_entry       public.queue_entries;
begin
  select q.appointment_id into v_appointment from public.queue_entries q where q.id = p_queue_entry_id;
  if v_appointment is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_appt := private.lock_appointment_for_command(v_appointment, 'queue.mark_left', null);
  select * into v_entry from public.queue_entries q where q.id = p_queue_entry_id for update;
  if v_entry.state not in ('waiting', 'called') or v_appt.status <> 'checked_in' then
    raise exception using errcode = 'P0001', message = 'APPT_INVALID_TRANSITION';
  end if;

  update public.doctor_sessions set queue_version = queue_version + 1 where id = v_entry.session_id;
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
-- get_available_slots — as in 0021, walk-ins do not block agenda slots (MD-10)
-- ---------------------------------------------------------------------------
create or replace function public.get_available_slots(p_doctor_id uuid, p_service_id uuid, p_from date, p_to date)
returns table (slot_starts_at timestamptz, slot_ends_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid;
  v_tz        text;
  v_duration  integer;
begin
  select d.clinic_id, c.timezone into v_clinic_id, v_tz
  from public.doctors d join public.clinics c on c.id = d.clinic_id
  where d.id = p_doctor_id;
  if v_clinic_id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.require_clinic_access(v_clinic_id);
  perform private.require_permission(v_clinic_id, 'slots.view');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'date range must cover 1 to 63 days';
  end if;
  select e.duration_minutes into v_duration from private.effective_service(v_clinic_id, p_doctor_id, p_service_id, false) e;

  return query
  with days as (
    select (p_from + i) as day from generate_series(0, p_to - p_from) as i
  ),
  applicable as (
    select dd.day, sch.id as schedule_id
    from days dd
    cross join lateral (
      select s.id from public.doctor_schedules s
      where s.doctor_id = p_doctor_id and s.valid_from <= dd.day and (s.valid_until is null or s.valid_until >= dd.day)
      order by (s.kind = 'override') desc
      limit 1) as sch
  ),
  windows as (
    select ap.day, a.start_time, a.end_time
    from applicable ap
    join public.doctor_availability a on a.schedule_id = ap.schedule_id and a.weekday = extract(isodow from ap.day)::smallint
  ),
  candidates as (
    select w.day, w.end_time, (w.day + w.start_time) + make_interval(mins => g * v_duration) as local_start
    from windows w
    cross join lateral generate_series(
      0, (floor(extract(epoch from (w.end_time - w.start_time)) / 60 / v_duration))::integer - 1) as g
  ),
  slots as (
    select c.day, c.end_time, c.local_start, i.s, i.s + make_interval(mins => v_duration) as e
    from candidates c
    cross join lateral (select c.local_start at time zone v_tz as s) as i
    where (i.s at time zone v_tz) = c.local_start
  )
  select sl.s, sl.e
  from slots sl
  where sl.s > now()
    and (sl.e at time zone v_tz) <= sl.day + sl.end_time
    and not exists (select 1 from public.doctor_time_off t
                    where t.doctor_id = p_doctor_id and t.period && tstzrange(sl.s, sl.e, '[)'))
    and not exists (select 1 from public.clinic_closures cc
                    where cc.clinic_id = v_clinic_id and cc.dates @> (sl.s at time zone v_tz)::date)
    and not exists (select 1 from public.appointments x
                    where x.doctor_id = p_doctor_id
                      and x.starts_at < sl.e
                      and x.starts_at > sl.s - interval '480 minutes'
                      and x.ends_at > sl.s
                      and x.status in ('pending', 'confirmed', 'checked_in', 'in_progress')
                      and x.source <> 'walk_in')
  order by sl.s;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.check_in_appointment(uuid, integer) from public, anon;
revoke all on function public.register_walk_in(uuid, uuid, uuid, text, text) from public, anon;
revoke all on function public.mark_left(uuid, text) from public, anon;
grant execute on function public.check_in_appointment(uuid, integer) to authenticated;
grant execute on function public.register_walk_in(uuid, uuid, uuid, text, text) to authenticated;
grant execute on function public.mark_left(uuid, text) to authenticated;
