-- SmartCabin 0021 — Module 5: services and availability.
--
-- 1. save_doctor_schedule: a schedule (regular or dated override) and its weekly windows are saved
--    in ONE transaction. Saving them separately could leave an empty override behind, which would
--    silently make the doctor unavailable for its whole period.
-- 2. list_doctor_booking_conflicts (BR-B-12): availability, time-off and closure edits never move
--    or cancel appointments; this lists the future ones that no longer fit, with no patient data.
-- 3. get_available_slots, corrected (forward-only replacement of 0012; signature and grants kept):
--    - SC-AUD-02: the overlap search is bounded by time, so it uses (doctor_id, starts_at) instead
--      of re-reading the doctor's whole history for every candidate slot;
--    - BR-TZ-03: on a time-change date, local times that do not exist are dropped, and a slot ends
--      at start + duration (real minutes) rather than at a separately converted local time, which
--      produced an 80-minute "20-minute" slot in the repeated hour (found by the property test).

-- ---------------------------------------------------------------------------
-- save_doctor_schedule
-- ---------------------------------------------------------------------------
create function public.save_doctor_schedule(
  p_doctor_id   uuid,
  p_schedule_id uuid,
  p_kind        text,
  p_name        text,
  p_valid_from  date,
  p_valid_until date,
  p_windows     jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_clinic_id  uuid;
  v_schedule   public.doctor_schedules;
  v_id         uuid;
  v_item       jsonb;
  v_constraint text;
begin
  select d.clinic_id into v_clinic_id from public.doctors d where d.id = p_doctor_id;
  if v_clinic_id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.require_clinic_access(v_clinic_id);
  perform private.require_permission(v_clinic_id, 'schedules.manage');
  perform private.require_doctor_scope(v_clinic_id, p_doctor_id);

  -- Shape of the request. Overrides are always dated (an open-ended override would replace the
  -- regular hours forever); regular schedules may be open-ended.
  if p_kind is null or p_kind not in ('regular', 'override')
     or p_valid_from is null
     or (p_kind = 'override' and p_valid_until is null)
     or (p_valid_until is not null and p_valid_until < p_valid_from)
     or p_name is null or char_length(btrim(p_name)) not between 2 and 80
     or p_windows is null or jsonb_typeof(p_windows) <> 'array' or jsonb_array_length(p_windows) > 100 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'schedule';
  end if;
  for v_item in select value from jsonb_array_elements(p_windows) loop
    if jsonb_typeof(v_item) <> 'object'
       or coalesce(v_item ->> 'weekday', '') !~ '^[1-7]$'
       or coalesce(v_item ->> 'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or coalesce(v_item ->> 'end', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'window';
    end if;
  end loop;

  begin
    if p_schedule_id is null then
      insert into public.doctor_schedules (clinic_id, doctor_id, name, kind, valid_from, valid_until)
      values (v_clinic_id, p_doctor_id, btrim(p_name), p_kind, p_valid_from, p_valid_until)
      returning id into v_id;
    else
      select * into v_schedule from public.doctor_schedules s
      where s.id = p_schedule_id and s.doctor_id = p_doctor_id and s.clinic_id = v_clinic_id
      for update;
      if not found then
        raise exception using errcode = 'P0002', message = 'NOT_FOUND', detail = 'schedule';
      end if;
      if v_schedule.kind <> p_kind then
        raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'kind is immutable';
      end if;
      update public.doctor_schedules
         set name = btrim(p_name), valid_from = p_valid_from, valid_until = p_valid_until
       where id = p_schedule_id;
      v_id := p_schedule_id;
    end if;

    delete from public.doctor_availability where schedule_id = v_id;
    insert into public.doctor_availability (clinic_id, schedule_id, doctor_id, weekday, start_time, end_time)
    select v_clinic_id, v_id, p_doctor_id, (e ->> 'weekday')::smallint, (e ->> 'start')::time, (e ->> 'end')::time
    from jsonb_array_elements(p_windows) as e;
  exception
    when exclusion_violation or check_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'doctor_schedules_no_overlap' then
        raise exception using errcode = 'P0001', message = 'SCHEDULE_OVERLAP';
      end if;
      -- Overlapping windows, off-grid times, end before start, name length…
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = v_constraint;
  end;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- list_doctor_booking_conflicts — future appointments that no longer fit (BR-B-12)
-- Same rules as booking (private.assert_slot_bookable), so the two can never disagree.
-- Returns no patient data: staff open the agenda, where RLS applies, to contact patients.
-- ---------------------------------------------------------------------------
create function public.list_doctor_booking_conflicts(p_doctor_id uuid)
returns table (appointment_id uuid, starts_at timestamptz, ends_at timestamptz, reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid;
  v_appt      record;
  v_detail    text;
begin
  select d.clinic_id into v_clinic_id from public.doctors d where d.id = p_doctor_id;
  if v_clinic_id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.require_clinic_access(v_clinic_id);
  perform private.require_permission(v_clinic_id, 'schedules.view');
  perform private.require_doctor_scope(v_clinic_id, p_doctor_id);

  for v_appt in
    select a.id, a.starts_at as s, a.ends_at as e
    from public.appointments a
    where a.clinic_id = v_clinic_id and a.doctor_id = p_doctor_id
      and a.status in ('pending', 'confirmed') and a.starts_at > now()
    order by a.starts_at
    limit 500
  loop
    begin
      perform private.assert_slot_bookable(v_clinic_id, p_doctor_id, v_appt.s, v_appt.e);
    exception when sqlstate 'P0001' then
      get stacked diagnostics v_detail = pg_exception_detail;
      appointment_id := v_appt.id;
      starts_at := v_appt.s;
      ends_at := v_appt.e;
      reason := coalesce(nullif(v_detail, ''), 'outside_availability');
      return next;
    end;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- get_available_slots — corrected (see header)
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
    -- BR-TZ-03: a local time skipped by a time change does not round-trip; it is not offered.
    where (i.s at time zone v_tz) = c.local_start
  )
  select sl.s, sl.e
  from slots sl
  where sl.s > now()
    -- BR-TZ-03: the real end (start + duration) stays inside the window, on the same local day.
    and (sl.e at time zone v_tz) <= sl.day + sl.end_time
    and not exists (select 1 from public.doctor_time_off t
                    where t.doctor_id = p_doctor_id and t.period && tstzrange(sl.s, sl.e, '[)'))
    and not exists (select 1 from public.clinic_closures cc
                    where cc.clinic_id = v_clinic_id and cc.dates @> (sl.s at time zone v_tz)::date)
    -- SC-AUD-02: an overlapping appointment starts before the slot ends and, since a duration is
    -- at most 480 minutes (appointments_duration), less than 480 minutes before the slot starts.
    and not exists (select 1 from public.appointments x
                    where x.doctor_id = p_doctor_id
                      and x.starts_at < sl.e
                      and x.starts_at > sl.s - interval '480 minutes'
                      and x.ends_at > sl.s
                      and x.status in ('pending', 'confirmed', 'checked_in', 'in_progress'))
  order by sl.s;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants (secure by default: explicit EXECUTE for authenticated only)
-- ---------------------------------------------------------------------------
revoke all on function public.save_doctor_schedule(uuid, uuid, text, text, date, date, jsonb) from public, anon;
revoke all on function public.list_doctor_booking_conflicts(uuid) from public, anon;
grant execute on function public.save_doctor_schedule(uuid, uuid, text, text, date, date, jsonb) to authenticated;
grant execute on function public.list_doctor_booking_conflicts(uuid) to authenticated;
