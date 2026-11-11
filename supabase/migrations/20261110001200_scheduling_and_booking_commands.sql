-- SmartClinic 0012 — Slot computation and staff appointment commands (BC4, BC6).
-- Concurrency: the exclusion constraint appointments_no_overlap is the final arbiter;
-- idempotency keys are unique per clinic. Both hold across concurrent transactions.

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

-- Effective duration and price of a service for a doctor; raises if not bookable (BR-B-02/03/04).
create function private.effective_service(
  p_clinic_id uuid, p_doctor_id uuid, p_service_id uuid, p_online boolean,
  out duration_minutes integer, out price_mad numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  select coalesce(ds.duration_minutes, s.default_duration_minutes), coalesce(ds.price_mad, s.price_mad)
    into duration_minutes, price_mad
  from public.doctor_services ds
  join public.doctors d  on d.clinic_id = ds.clinic_id and d.id = ds.doctor_id
  join public.services s on s.clinic_id = ds.clinic_id and s.id = ds.service_id
  where ds.clinic_id = p_clinic_id and ds.doctor_id = p_doctor_id and ds.service_id = p_service_id
    and ds.is_active and d.status = 'active' and s.status = 'active'
    and (not p_online or (ds.online_bookable and d.online_bookable and s.online_bookable));
  if not found then
    raise exception using errcode = 'P0001', message = 'SERVICE_NOT_OFFERED';
  end if;
end;
$$;

-- BR-B-05/06: inside an availability window of the applicable schedule (override beats regular),
-- outside time off and clinic closures. Overlap with other appointments is left to the constraint.
create function private.assert_slot_bookable(p_clinic_id uuid, p_doctor_id uuid, p_starts timestamptz, p_ends timestamptz)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz          text;
  v_local_start timestamp;
  v_local_end   timestamp;
  v_day         date;
  v_schedule_id uuid;
begin
  select c.timezone into v_tz from public.clinics c where c.id = p_clinic_id;
  v_local_start := p_starts at time zone v_tz;
  v_local_end   := p_ends at time zone v_tz;
  v_day         := v_local_start::date;

  if v_local_end::date <> v_day then
    raise exception using errcode = 'P0001', message = 'SLOT_UNAVAILABLE', detail = 'outside_availability';
  end if;

  select s.id into v_schedule_id
  from public.doctor_schedules s
  where s.clinic_id = p_clinic_id and s.doctor_id = p_doctor_id
    and s.valid_from <= v_day and (s.valid_until is null or s.valid_until >= v_day)
  order by (s.kind = 'override') desc
  limit 1;

  if v_schedule_id is null or not exists (
      select 1 from public.doctor_availability a
      where a.schedule_id = v_schedule_id
        and a.weekday = extract(isodow from v_day)::smallint
        and a.start_time <= v_local_start::time
        and v_local_end::time <= a.end_time) then
    raise exception using errcode = 'P0001', message = 'SLOT_UNAVAILABLE', detail = 'outside_availability';
  end if;

  if exists (select 1 from public.doctor_time_off t
             where t.doctor_id = p_doctor_id and t.period && tstzrange(p_starts, p_ends, '[)')) then
    raise exception using errcode = 'P0001', message = 'SLOT_UNAVAILABLE', detail = 'doctor_time_off';
  end if;

  if exists (select 1 from public.clinic_closures cc where cc.clinic_id = p_clinic_id and cc.dates @> v_day) then
    raise exception using errcode = 'P0001', message = 'SLOT_UNAVAILABLE', detail = 'clinic_closed';
  end if;
end;
$$;

-- Loads an appointment for a row-targeted command: lock, tenant access, permission, doctor scope, version.
create function private.lock_appointment_for_command(p_appointment_id uuid, p_permission text, p_expected_version integer)
returns public.appointments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_appt public.appointments;
begin
  select * into v_appt from public.appointments a where a.id = p_appointment_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.require_clinic_access(v_appt.clinic_id);
  perform private.require_permission(v_appt.clinic_id, p_permission);
  perform private.require_doctor_scope(v_appt.clinic_id, v_appt.doctor_id);
  if p_expected_version is not null and p_expected_version <> v_appt.version then
    raise exception using errcode = 'P0001', message = 'STALE_STATE',
      detail = format('expected version %s, current %s', p_expected_version, v_appt.version);
  end if;
  return v_appt;
end;
$$;

-- ---------------------------------------------------------------------------
-- get_available_slots — staff query (patients get a public variant with slice S7)
-- Returns intervals only, no appointment or patient data.
-- ---------------------------------------------------------------------------
create function public.get_available_slots(p_doctor_id uuid, p_service_id uuid, p_from date, p_to date)
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
    select ((w.day + w.start_time) + make_interval(mins => g * v_duration)) at time zone v_tz as s,
           ((w.day + w.start_time) + make_interval(mins => (g + 1) * v_duration)) at time zone v_tz as e
    from windows w
    cross join lateral generate_series(
      0, (floor(extract(epoch from (w.end_time - w.start_time)) / 60 / v_duration))::integer - 1) as g
  )
  select c.s, c.e
  from candidates c
  where c.s > now()
    and not exists (select 1 from public.doctor_time_off t
                    where t.doctor_id = p_doctor_id and t.period && tstzrange(c.s, c.e, '[)'))
    and not exists (select 1 from public.clinic_closures cc
                    where cc.clinic_id = v_clinic_id and cc.dates @> (c.s at time zone v_tz)::date)
    and not exists (select 1 from public.appointments x
                    where x.doctor_id = p_doctor_id
                      and x.status in ('pending', 'confirmed', 'checked_in', 'in_progress')
                      and tstzrange(x.starts_at, x.ends_at, '[)') && tstzrange(c.s, c.e, '[)'))
  order by c.s;
end;
$$;

-- ---------------------------------------------------------------------------
-- book_appointment — staff booking (A2). Clinic derived from the doctor, never from the client.
-- ---------------------------------------------------------------------------
create function public.book_appointment(
  p_patient_id      uuid,
  p_doctor_id       uuid,
  p_service_id      uuid,
  p_starts_at       timestamptz,
  p_idempotency_key text default null,
  p_is_overbooked   boolean default false,
  p_overbook_reason text default null,
  p_patient_reason  text default null)
returns public.appointments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid;
  v_status    public.clinic_status;
  v_duration  integer;
  v_price     numeric;
  v_existing  public.appointments;
  v_row       public.appointments;
begin
  select d.clinic_id into v_clinic_id from public.doctors d where d.id = p_doctor_id;
  if v_clinic_id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.require_clinic_access(v_clinic_id);
  perform private.require_permission(v_clinic_id, 'appointments.book');
  perform private.require_doctor_scope(v_clinic_id, p_doctor_id);
  if coalesce(p_is_overbooked, false) then
    perform private.require_permission(v_clinic_id, 'appointments.overbook');
  end if;

  -- BR-B-10: replaying a key returns the original appointment.
  if p_idempotency_key is not null then
    select * into v_existing from public.appointments a
    where a.clinic_id = v_clinic_id and a.idempotency_key = p_idempotency_key;
    if found then
      if v_existing.patient_id <> p_patient_id or v_existing.doctor_id <> p_doctor_id
         or v_existing.service_id <> p_service_id or v_existing.starts_at <> p_starts_at then
        raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
      end if;
      return v_existing;
    end if;
  end if;

  select c.status into v_status from public.clinics c where c.id = v_clinic_id;
  if v_status not in ('active', 'pending_approval') then
    raise exception using errcode = 'P0001', message = 'CLINIC_NOT_ACTIVE';
  end if;
  if not exists (select 1 from public.patients p
                 where p.clinic_id = v_clinic_id and p.id = p_patient_id and p.status = 'active') then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND', detail = 'patient';
  end if;
  if p_starts_at is null or p_starts_at < now() then
    raise exception using errcode = 'P0001', message = 'BOOKING_IN_PAST';
  end if;

  select e.duration_minutes, e.price_mad into v_duration, v_price
  from private.effective_service(v_clinic_id, p_doctor_id, p_service_id, false) e;
  perform private.assert_slot_bookable(v_clinic_id, p_doctor_id, p_starts_at, p_starts_at + make_interval(mins => v_duration));

  perform set_config('smartclinic.change_reason', coalesce(nullif(btrim(p_overbook_reason), ''), ''), true);
  begin
    insert into public.appointments (
      clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, source,
      is_overbooked, overbook_reason, patient_reason, price_mad, idempotency_key, booked_by_user_id, confirmed_at)
    values (
      v_clinic_id, p_patient_id, p_doctor_id, p_service_id, p_starts_at, p_starts_at + make_interval(mins => v_duration),
      'confirmed', 'staff', coalesce(p_is_overbooked, false),
      case when coalesce(p_is_overbooked, false) then nullif(btrim(p_overbook_reason), '') end,
      nullif(btrim(p_patient_reason), ''), v_price, p_idempotency_key, auth.uid(), now())
    returning * into v_row;
  exception
    when exclusion_violation then
      raise exception using errcode = 'P0001', message = 'SLOT_UNAVAILABLE', detail = 'overlaps another appointment';
    when unique_violation then
      -- A concurrent request with the same key committed first: return its result.
      select * into v_existing from public.appointments a
      where a.clinic_id = v_clinic_id and a.idempotency_key = p_idempotency_key;
      if found then
        return v_existing;
      end if;
      raise;
  end;

  perform private.emit_event(v_clinic_id, 'appointment', v_row.id, 'appointment.confirmed');
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- confirm_appointment (A4)
-- ---------------------------------------------------------------------------
create function public.confirm_appointment(p_appointment_id uuid, p_expected_version integer default null)
returns public.appointments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_appt public.appointments := private.lock_appointment_for_command(p_appointment_id, 'appointments.confirm', p_expected_version);
begin
  if v_appt.status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'APPT_INVALID_TRANSITION';
  end if;
  perform set_config('smartclinic.change_reason', '', true);
  update public.appointments set status = 'confirmed', confirmed_at = now()
  where id = p_appointment_id returning * into v_appt;
  perform private.emit_event(v_appt.clinic_id, 'appointment', v_appt.id, 'appointment.confirmed');
  return v_appt;
end;
$$;

-- ---------------------------------------------------------------------------
-- cancel_appointment (A6) — clinic-side cancellation with a reason
-- ---------------------------------------------------------------------------
create function public.cancel_appointment(
  p_appointment_id   uuid,
  p_reason           public.cancellation_reason,
  p_note             text default null,
  p_expected_version integer default null)
returns public.appointments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_appt public.appointments := private.lock_appointment_for_command(p_appointment_id, 'appointments.cancel', p_expected_version);
begin
  if v_appt.status not in ('pending', 'confirmed') then
    raise exception using errcode = 'P0001', message = 'APPT_INVALID_TRANSITION';
  end if;
  -- These reasons belong to the queue (left) and to the system (expiry), not to this command.
  if p_reason is null or p_reason in ('left_before_consultation', 'not_confirmed_in_time') then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'invalid cancellation reason';
  end if;
  perform set_config('smartclinic.change_reason', coalesce(left(btrim(p_note), 300), ''), true);
  update public.appointments
     set status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = auth.uid(),
         cancellation_actor = 'clinic', cancellation_reason = p_reason
   where id = p_appointment_id
  returning * into v_appt;
  perform private.emit_event(v_appt.clinic_id, 'appointment', v_appt.id, 'appointment.cancelled');
  return v_appt;
end;
$$;

-- ---------------------------------------------------------------------------
-- reschedule_appointment (A5, staff) — same appointment, new time; status unchanged
-- ---------------------------------------------------------------------------
create function public.reschedule_appointment(
  p_appointment_id   uuid,
  p_new_starts_at    timestamptz,
  p_expected_version integer default null)
returns public.appointments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_appt     public.appointments := private.lock_appointment_for_command(p_appointment_id, 'appointments.reschedule', p_expected_version);
  v_duration integer;
begin
  if v_appt.status not in ('pending', 'confirmed') then
    raise exception using errcode = 'P0001', message = 'APPT_INVALID_TRANSITION';
  end if;
  if p_new_starts_at is null or p_new_starts_at < now() then
    raise exception using errcode = 'P0001', message = 'BOOKING_IN_PAST';
  end if;
  select e.duration_minutes into v_duration
  from private.effective_service(v_appt.clinic_id, v_appt.doctor_id, v_appt.service_id, false) e;
  perform private.assert_slot_bookable(v_appt.clinic_id, v_appt.doctor_id, p_new_starts_at,
                                       p_new_starts_at + make_interval(mins => v_duration));
  perform set_config('smartclinic.change_reason', '', true);
  begin
    -- A rescheduled appointment takes a normal slot: the overbooking flag does not carry over.
    update public.appointments
       set starts_at = p_new_starts_at, ends_at = p_new_starts_at + make_interval(mins => v_duration),
           is_overbooked = false, overbook_reason = null
     where id = p_appointment_id
    returning * into v_appt;
  exception when exclusion_violation then
    raise exception using errcode = 'P0001', message = 'SLOT_UNAVAILABLE', detail = 'overlaps another appointment';
  end;
  perform private.emit_event(v_appt.clinic_id, 'appointment', v_appt.id, 'appointment.rescheduled');
  return v_appt;
end;
$$;

-- ---------------------------------------------------------------------------
-- mark_no_show (A9) — only after the grace period
-- ---------------------------------------------------------------------------
create function public.mark_no_show(p_appointment_id uuid, p_expected_version integer default null)
returns public.appointments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_appt  public.appointments := private.lock_appointment_for_command(p_appointment_id, 'appointments.mark_no_show', p_expected_version);
  v_grace integer;
begin
  if v_appt.status <> 'confirmed' then
    raise exception using errcode = 'P0001', message = 'APPT_INVALID_TRANSITION';
  end if;
  select s.checkin_grace_minutes into v_grace from public.clinic_settings s where s.clinic_id = v_appt.clinic_id;
  if now() < v_appt.starts_at + make_interval(mins => coalesce(v_grace, 15)) then
    raise exception using errcode = 'P0001', message = 'NO_SHOW_TOO_EARLY';
  end if;
  perform set_config('smartclinic.change_reason', '', true);
  update public.appointments set status = 'no_show', no_show_at = now()
  where id = p_appointment_id returning * into v_appt;
  perform private.emit_event(v_appt.clinic_id, 'appointment', v_appt.id, 'appointment.no_show');
  return v_appt;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function public.get_available_slots(uuid, uuid, date, date) from public, anon;
revoke all on function public.book_appointment(uuid, uuid, uuid, timestamptz, text, boolean, text, text) from public, anon;
revoke all on function public.confirm_appointment(uuid, integer) from public, anon;
revoke all on function public.cancel_appointment(uuid, public.cancellation_reason, text, integer) from public, anon;
revoke all on function public.reschedule_appointment(uuid, timestamptz, integer) from public, anon;
revoke all on function public.mark_no_show(uuid, integer) from public, anon;

grant execute on function public.get_available_slots(uuid, uuid, date, date) to authenticated;
grant execute on function public.book_appointment(uuid, uuid, uuid, timestamptz, text, boolean, text, text) to authenticated;
grant execute on function public.confirm_appointment(uuid, integer) to authenticated;
grant execute on function public.cancel_appointment(uuid, public.cancellation_reason, text, integer) to authenticated;
grant execute on function public.reschedule_appointment(uuid, timestamptz, integer) to authenticated;
grant execute on function public.mark_no_show(uuid, integer) to authenticated;
