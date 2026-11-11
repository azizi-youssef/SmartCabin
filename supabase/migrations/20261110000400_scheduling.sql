-- SmartCabin 0004 — Scheduling (BC4): schedule periods, weekly windows, time off.
-- Schedules hold local wall-clock times; conversion to instants happens per date (BR-TZ-01/02).

-- ---------------------------------------------------------------------------
-- doctor_schedules — validity periods; an 'override' (e.g. Ramadan hours) beats 'regular' (MD-06)
-- ---------------------------------------------------------------------------
create table public.doctor_schedules (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null,
  doctor_id   uuid not null,
  name        text not null,
  kind        text not null default 'regular',
  valid_from  date not null,
  valid_until date,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint doctor_schedules_clinic_id_id_key unique (clinic_id, id),
  -- Target of the availability FK, guaranteeing a window's doctor_id matches its schedule.
  constraint doctor_schedules_clinic_id_id_doctor_key unique (clinic_id, id, doctor_id),
  constraint doctor_schedules_doctor_fkey foreign key (clinic_id, doctor_id) references public.doctors (clinic_id, id),
  constraint doctor_schedules_kind check (kind in ('regular', 'override')),
  constraint doctor_schedules_name_length check (char_length(btrim(name)) between 2 and 80),
  constraint doctor_schedules_validity check (valid_until is null or valid_until >= valid_from),
  -- Two schedules of the same kind for the same doctor never cover the same date.
  constraint doctor_schedules_no_overlap exclude using gist (
    doctor_id with =, kind with =, daterange(valid_from, valid_until, '[]') with &&)
);

create trigger doctor_schedules_set_updated_at
  before update on public.doctor_schedules
  for each row execute function private.set_updated_at();
create trigger doctor_schedules_tenant_immutable
  before update on public.doctor_schedules
  for each row execute function private.forbid_clinic_id_change();

-- ---------------------------------------------------------------------------
-- doctor_availability — weekly windows inside a schedule
-- ---------------------------------------------------------------------------
create table public.doctor_availability (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null,
  schedule_id uuid not null,
  doctor_id   uuid not null,
  weekday     smallint not null,
  start_time  time not null,
  end_time    time not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint doctor_availability_clinic_id_id_key unique (clinic_id, id),
  -- Windows belong to their schedule (part of the schedule aggregate): deleting a schedule deletes them.
  constraint doctor_availability_schedule_fkey foreign key (clinic_id, schedule_id, doctor_id)
    references public.doctor_schedules (clinic_id, id, doctor_id) on delete cascade,
  constraint doctor_availability_weekday check (weekday between 1 and 7),
  constraint doctor_availability_order check (end_time > start_time),
  constraint doctor_availability_grid check (
    extract(second from start_time) = 0 and extract(second from end_time) = 0
    and extract(minute from start_time)::integer % 5 = 0 and extract(minute from end_time)::integer % 5 = 0),
  -- No overlapping windows on the same weekday of the same schedule (minutes since midnight).
  constraint doctor_availability_no_overlap exclude using gist (
    schedule_id with =, weekday with =,
    int4range((extract(epoch from start_time) / 60)::integer, (extract(epoch from end_time) / 60)::integer) with &&)
);

create index doctor_availability_doctor_idx on public.doctor_availability (doctor_id, weekday);

create trigger doctor_availability_set_updated_at
  before update on public.doctor_availability
  for each row execute function private.set_updated_at();
create trigger doctor_availability_tenant_immutable
  before update on public.doctor_availability
  for each row execute function private.forbid_clinic_id_change();

-- ---------------------------------------------------------------------------
-- doctor_time_off — instants when a doctor cannot be booked
-- ---------------------------------------------------------------------------
create table public.doctor_time_off (
  id              uuid primary key default gen_random_uuid(),
  clinic_id       uuid not null,
  doctor_id       uuid not null,
  period          tstzrange not null,
  reason_category public.time_off_reason not null default 'leave',
  note            text,
  created_by      uuid references auth.users (id) default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint doctor_time_off_clinic_id_id_key unique (clinic_id, id),
  constraint doctor_time_off_doctor_fkey foreign key (clinic_id, doctor_id) references public.doctors (clinic_id, id),
  constraint doctor_time_off_bounded check (not isempty(period) and not lower_inf(period) and not upper_inf(period)),
  -- Staff-only note; no medical detail (BR-D-01).
  constraint doctor_time_off_note_length check (note is null or char_length(note) <= 200)
);

create index doctor_time_off_period_idx on public.doctor_time_off using gist (doctor_id, period);

create trigger doctor_time_off_set_updated_at
  before update on public.doctor_time_off
  for each row execute function private.set_updated_at();
create trigger doctor_time_off_tenant_immutable
  before update on public.doctor_time_off
  for each row execute function private.forbid_clinic_id_change();
