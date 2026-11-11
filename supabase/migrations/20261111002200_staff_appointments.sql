-- SmartCabin 0022 — Module 6: staff appointments.
--
-- 1. The visit reason (appointments.patient_reason) may contain health information. Until now the
--    table grant let anyone with appointments.view read it, so appointments.view_reason was not
--    enforced. The column is no longer granted; get_appointment returns it only with view_reason.
--    Commands still return the full row to their caller: every role that may write appointments
--    also holds view_reason (checked by tests/db/appointments.test.ts).
-- 2. get_appointment and list_appointment_history: the appointment file and its timeline, with the
--    names of the clinic's staff (user_profiles is readable by its owner only).
-- 3. Audit SC-AUD-18: commands used to lock the appointment row BEFORE checking that the caller
--    may act on it, so a user of another clinic could wait on, and briefly hold, that lock. The
--    access checks now run on an unlocked read; clinic_id and doctor_id are immutable
--    (forbid_clinic_id_change, appointments_guard), so they still hold once the row is locked.

-- ---------------------------------------------------------------------------
-- 1. Column grant: every column except patient_reason
-- ---------------------------------------------------------------------------
revoke select on public.appointments from authenticated;
grant select (
  id, clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, source,
  is_overbooked, overbook_reason, price_mad, idempotency_key, booked_by_user_id,
  confirmed_at, checked_in_at, started_at, completed_at, cancelled_at, no_show_at,
  cancelled_by_user_id, cancellation_actor, cancellation_reason, version, created_at, updated_at)
  on public.appointments to authenticated;

-- ---------------------------------------------------------------------------
-- 3. private.lock_appointment_for_command — authorize first, then lock (SC-AUD-18)
-- Same signature and result; used by confirm, cancel, reschedule and mark_no_show.
-- ---------------------------------------------------------------------------
create or replace function private.lock_appointment_for_command(p_appointment_id uuid, p_permission text, p_expected_version integer)
returns public.appointments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid;
  v_doctor_id uuid;
  v_appt      public.appointments;
begin
  select a.clinic_id, a.doctor_id into v_clinic_id, v_doctor_id from public.appointments a where a.id = p_appointment_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.require_clinic_access(v_clinic_id);
  perform private.require_permission(v_clinic_id, p_permission);
  perform private.require_doctor_scope(v_clinic_id, v_doctor_id);

  select * into v_appt from public.appointments a where a.id = p_appointment_id for update;
  if p_expected_version is not null and p_expected_version <> v_appt.version then
    raise exception using errcode = 'P0001', message = 'STALE_STATE',
      detail = format('expected version %s, current %s', p_expected_version, v_appt.version);
  end if;
  return v_appt;
end;
$$;

-- Display name of a member of the clinic (null for anyone else: patients, platform, system).
create function private.member_display_name(p_clinic_id uuid, p_user_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(nullif(p.full_name, ''), split_part(u.email::text, '@', 1))
  from public.clinic_members m
  join auth.users u on u.id = m.user_id
  left join public.user_profiles p on p.id = m.user_id
  where m.clinic_id = p_clinic_id and m.user_id = p_user_id;
$$;
revoke all on function private.member_display_name(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2a. get_appointment — the appointment file
-- ---------------------------------------------------------------------------
create function public.get_appointment(p_appointment_id uuid)
returns table (
  id                  uuid,
  clinic_id           uuid,
  patient_id          uuid,
  doctor_id           uuid,
  service_id          uuid,
  starts_at           timestamptz,
  ends_at             timestamptz,
  status              public.appointment_status,
  source              public.appointment_source,
  is_overbooked       boolean,
  overbook_reason     text,
  patient_reason      text,
  price_mad           numeric,
  version             integer,
  booked_by_name      text,
  confirmed_at        timestamptz,
  cancelled_at        timestamptz,
  cancellation_actor  public.cancellation_actor,
  cancellation_reason public.cancellation_reason,
  no_show_at          timestamptz,
  created_at          timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_clinic_id uuid;
  v_doctor_id uuid;
begin
  select a.clinic_id, a.doctor_id into v_clinic_id, v_doctor_id from public.appointments a where a.id = p_appointment_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.require_clinic_access(v_clinic_id);
  perform private.require_permission(v_clinic_id, 'appointments.view');
  perform private.require_doctor_scope(v_clinic_id, v_doctor_id);

  return query
  select a.id, a.clinic_id, a.patient_id, a.doctor_id, a.service_id, a.starts_at, a.ends_at, a.status, a.source,
         a.is_overbooked, a.overbook_reason,
         case when private.has_permission(v_clinic_id, 'appointments.view_reason') then a.patient_reason end,
         a.price_mad, a.version,
         private.member_display_name(v_clinic_id, a.booked_by_user_id),
         a.confirmed_at, a.cancelled_at, a.cancellation_actor, a.cancellation_reason, a.no_show_at, a.created_at
  from public.appointments a
  where a.id = p_appointment_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2b. list_appointment_history — the appointment timeline (append-only table, oldest first)
-- ---------------------------------------------------------------------------
create function public.list_appointment_history(p_appointment_id uuid)
returns table (
  occurred_at        timestamptz,
  event_type         public.history_event,
  from_status        public.appointment_status,
  to_status          public.appointment_status,
  previous_starts_at timestamptz,
  new_starts_at      timestamptz,
  actor_type         public.actor_type,
  actor_name         text,
  reason             text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_clinic_id uuid;
  v_doctor_id uuid;
begin
  select a.clinic_id, a.doctor_id into v_clinic_id, v_doctor_id from public.appointments a where a.id = p_appointment_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.require_clinic_access(v_clinic_id);
  perform private.require_permission(v_clinic_id, 'appointments.view');
  perform private.require_doctor_scope(v_clinic_id, v_doctor_id);

  return query
  select h.occurred_at, h.event_type, h.from_status, h.to_status, h.previous_starts_at, h.new_starts_at, h.actor_type,
         case when h.actor_type = 'user' then private.member_display_name(v_clinic_id, h.actor_user_id) end,
         h.reason
  from public.appointment_history h
  where h.clinic_id = v_clinic_id and h.appointment_id = p_appointment_id
  order by h.occurred_at, h.id;
end;
$$;

revoke all on function public.get_appointment(uuid) from public, anon;
revoke all on function public.list_appointment_history(uuid) from public, anon;
grant execute on function public.get_appointment(uuid) to authenticated;
grant execute on function public.list_appointment_history(uuid) to authenticated;
