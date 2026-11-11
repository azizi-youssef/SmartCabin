-- SmartClinic 0006 — Appointments (BC6): appointments, history, transition table.
-- Double booking is prevented by an exclusion constraint, which holds under concurrent requests.

-- ---------------------------------------------------------------------------
-- appointment_status_transitions — the single source of allowed transitions (BUSINESS_RULES §2)
-- ---------------------------------------------------------------------------
create table public.appointment_status_transitions (
  from_status public.appointment_status not null,
  to_status   public.appointment_status not null,
  kind        text not null,
  primary key (from_status, to_status),
  constraint appointment_status_transitions_kind check (kind in ('normal', 'correction')),
  constraint appointment_status_transitions_distinct check (from_status <> to_status)
);

insert into public.appointment_status_transitions (from_status, to_status, kind) values
  ('pending',     'confirmed',   'normal'),      -- A4
  ('pending',     'cancelled',   'normal'),      -- A6, A7
  ('confirmed',   'pending',     'normal'),      -- A5 patient reschedule when confirmation is required
  ('confirmed',   'checked_in',  'normal'),      -- A8
  ('confirmed',   'cancelled',   'normal'),      -- A6
  ('confirmed',   'no_show',     'normal'),      -- A9
  ('checked_in',  'in_progress', 'normal'),      -- A10
  ('checked_in',  'cancelled',   'normal'),      -- A11 left before consultation
  ('in_progress', 'completed',   'normal'),      -- A12
  ('in_progress', 'checked_in',  'correction'),  -- A13
  ('no_show',     'checked_in',  'correction');  -- A14

-- ---------------------------------------------------------------------------
-- appointments (command table: no direct DML for API roles)
-- ---------------------------------------------------------------------------
create table public.appointments (
  id                   uuid primary key default gen_random_uuid(),
  clinic_id            uuid not null references public.clinics (id),
  patient_id           uuid not null,
  doctor_id            uuid not null,
  service_id           uuid not null,
  starts_at            timestamptz not null,
  ends_at              timestamptz not null,
  status               public.appointment_status not null,
  source               public.appointment_source not null,
  is_overbooked        boolean not null default false,
  overbook_reason      text,
  patient_reason       text,
  price_mad            numeric(12, 2) not null,
  idempotency_key      text,
  booked_by_user_id    uuid references auth.users (id),
  confirmed_at         timestamptz,
  checked_in_at        timestamptz,
  started_at           timestamptz,
  completed_at         timestamptz,
  cancelled_at         timestamptz,
  no_show_at           timestamptz,
  cancelled_by_user_id uuid references auth.users (id),
  cancellation_actor   public.cancellation_actor,
  cancellation_reason  public.cancellation_reason,
  version              integer not null default 1,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint appointments_clinic_id_id_key unique (clinic_id, id),
  -- Tenant consistency: patient and (doctor, service) must belong to the appointment's clinic.
  constraint appointments_patient_fkey foreign key (clinic_id, patient_id) references public.patients (clinic_id, id),
  -- Also enforces "the doctor provides this service" in the database (MD-05).
  constraint appointments_doctor_service_fkey foreign key (clinic_id, doctor_id, service_id)
    references public.doctor_services (clinic_id, doctor_id, service_id),
  constraint appointments_time_order check (ends_at > starts_at),
  constraint appointments_duration check (
    ends_at - starts_at between interval '5 minutes' and interval '480 minutes'
    and (extract(epoch from (ends_at - starts_at)))::bigint % 300 = 0),
  constraint appointments_start_grid check ((extract(epoch from starts_at))::bigint % 300 = 0),
  constraint appointments_price check (price_mad >= 0),
  constraint appointments_reason_length check (patient_reason is null or char_length(patient_reason) <= 200),
  constraint appointments_idempotency_length check (
    idempotency_key is null or char_length(idempotency_key) between 8 and 100),
  constraint appointments_overbook_reason check (
    not is_overbooked or char_length(btrim(coalesce(overbook_reason, ''))) >= 3),
  constraint appointments_overbook_reason_only_if_overbooked check (is_overbooked or overbook_reason is null),
  -- Status / timestamp coherence (BR-A).
  constraint appointments_cancel_coherent check (
    (status = 'cancelled') = (cancelled_at is not null and cancellation_reason is not null and cancellation_actor is not null)),
  constraint appointments_no_show_coherent check ((status = 'no_show') = (no_show_at is not null)),
  constraint appointments_checkin_coherent check (
    status not in ('checked_in', 'in_progress', 'completed') or checked_in_at is not null),
  constraint appointments_start_coherent check (status not in ('in_progress', 'completed') or started_at is not null),
  constraint appointments_completed_coherent check ((status = 'completed') = (completed_at is not null)),
  -- BR-B-08: no overlap for the same doctor among active, non-overbooked appointments.
  -- The constraint is checked atomically, so two concurrent bookings of one slot cannot both commit.
  constraint appointments_no_overlap exclude using gist (
    doctor_id with =, tstzrange(starts_at, ends_at, '[)') with &&)
    where (status in ('pending', 'confirmed', 'checked_in', 'in_progress') and not is_overbooked)
);

create index appointments_clinic_start_idx on public.appointments (clinic_id, starts_at);
create index appointments_doctor_start_idx on public.appointments (doctor_id, starts_at);
create index appointments_patient_idx on public.appointments (clinic_id, patient_id, starts_at);
create unique index appointments_idempotency_key on public.appointments (clinic_id, idempotency_key)
  where idempotency_key is not null;

-- Lifecycle guard: initial states, legal transitions, immutable fields, version bump.
create function private.appointments_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status not in ('pending', 'confirmed', 'checked_in') then
      raise exception using errcode = 'P0001', message = 'APPT_INVALID_TRANSITION',
        detail = format('appointments cannot start in status %s', new.status);
    end if;
    new.version := 1;
    return new;
  end if;

  if new.clinic_id is distinct from old.clinic_id
     or new.patient_id is distinct from old.patient_id
     or new.doctor_id is distinct from old.doctor_id
     or new.service_id is distinct from old.service_id
     or new.source is distinct from old.source
     or new.idempotency_key is distinct from old.idempotency_key
     or new.booked_by_user_id is distinct from old.booked_by_user_id
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = 'P0001', message = 'APPOINTMENT_FIELD_IMMUTABLE',
      detail = 'clinic, patient, doctor, service, source and booking metadata cannot change';
  end if;

  if new.status is distinct from old.status and not exists (
       select 1 from public.appointment_status_transitions t
       where t.from_status = old.status and t.to_status = new.status) then
    raise exception using errcode = 'P0001', message = 'APPT_INVALID_TRANSITION',
      detail = format('%s -> %s is not allowed', old.status, new.status);
  end if;

  if (new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at)
     and old.status not in ('pending', 'confirmed') then
    raise exception using errcode = 'P0001', message = 'APPT_INVALID_TRANSITION',
      detail = 'only pending or confirmed appointments can be rescheduled';
  end if;

  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;

create trigger appointments_guard
  before insert or update on public.appointments
  for each row execute function private.appointments_guard();

-- ---------------------------------------------------------------------------
-- appointment_history — append-only trail of status changes and reschedules (MD-08)
-- ---------------------------------------------------------------------------
create table public.appointment_history (
  id                 bigint generated always as identity primary key,
  clinic_id          uuid not null,
  appointment_id     uuid not null,
  event_type         public.history_event not null,
  from_status        public.appointment_status,
  to_status          public.appointment_status,
  previous_starts_at timestamptz,
  new_starts_at      timestamptz,
  actor_type         public.actor_type not null,
  actor_user_id      uuid,
  reason             text,
  occurred_at        timestamptz not null default now(),
  constraint appointment_history_appointment_fkey foreign key (clinic_id, appointment_id)
    references public.appointments (clinic_id, id),
  constraint appointment_history_reason_length check (reason is null or char_length(reason) <= 300)
);

create index appointment_history_appointment_idx on public.appointment_history (appointment_id, occurred_at);

create trigger appointment_history_append_only
  before update or delete on public.appointment_history
  for each row execute function private.forbid_mutation();
