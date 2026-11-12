-- =============================================================================
-- 0028 analytics (module 11): operational KPIs K1–K6 and K8 (BUSINESS_RULES §8).
-- K7 (revenue) is billing's revenue_summary() (one definition, MODELING_REVIEW I-14).
--
-- SECURITY INVOKER (API_SPECIFICATION BC10): every row is read under the caller's RLS, so a
-- practitioner-only doctor sees their own agendas only, and nothing is computed from data the
-- caller could not read. The function owns no table and writes nothing.
-- =============================================================================

-- kpi_operational — per period ('total'), local day ('day'), doctor ('doctor') or service ('service').
-- Day D = appointments whose starts_at falls on local date D in the clinic's time zone.
--   K1 appointments (by status, by source)        K2 completed
--   K3 cancelled by actor; "left before consultation" counted apart (not in cancelled)
--   K4 no_show / no_show_denominator, where the denominator is completed + no_show + left,
--      scheduled appointments only (source ≠ walk_in); the UI shows "—" when it is 0
--   K5 wait = consultation start − anchor, anchor = max(check-in, start) for scheduled patients and
--      check-in for walk-ins; completed appointments only; an early start counts as no wait
--   K6 booked = durations of non-cancelled appointments; available = schedule windows minus time
--      off and closures; actual = real consultation minutes (completed). Not computed per service.
--   K8 group 'service': completed per service (share computed by the caller).
create function public.kpi_operational(
  p_clinic_id uuid,
  p_from      date,
  p_to        date,
  p_group     text default 'total',
  p_doctor_id uuid default null)
returns table (
  group_key                text,
  appointments             integer,
  by_status                jsonb,
  by_source                jsonb,
  completed                integer,
  cancelled                integer,
  cancelled_by_patient     integer,
  cancelled_by_clinic      integer,
  cancelled_by_system      integer,
  left_before_consultation integer,
  no_show                  integer,
  no_show_denominator      integer,
  wait_count               integer,
  wait_mean_minutes        numeric,
  wait_median_minutes      numeric,
  booked_minutes           integer,
  available_minutes        integer,
  actual_minutes           integer)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_role     public.clinic_role;
  v_tz       text;
  v_own_only boolean;
  v_doctors  uuid[];
begin
  if p_group is null or p_group not in ('total', 'day', 'doctor', 'service')
     or p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'period or grouping';
  end if;

  -- Membership first (another clinic answers NOT_FOUND), then the permission (with MFA).
  select m.role into v_role from public.clinic_members m
  where m.clinic_id = p_clinic_id and m.user_id = (select auth.uid()) and m.status = 'active';
  if v_role is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if not exists (select 1 from private.clinics_with_permission('analytics.operational') c where c = p_clinic_id) then
    if private.role_requires_mfa(v_role) and private.session_aal() <> 'aal2' then
      raise exception using errcode = '42501', message = 'MFA_REQUIRED';
    end if;
    raise exception using errcode = '42501', message = 'FORBIDDEN', detail = 'analytics.operational';
  end if;

  select c.timezone into v_tz from public.clinics c where c.id = p_clinic_id;
  -- A practitioner-only member (DOCTOR role) sees their own agendas only (RBAC §3.7 "own").
  v_own_only := p_clinic_id in (select private.practitioner_only_clinics());
  select array_agg(d.id) into v_doctors
  from public.doctors d
  where d.clinic_id = p_clinic_id
    and (not v_own_only or d.id in (select private.my_doctor_ids()))
    and (p_doctor_id is null or d.id = p_doctor_id);
  if p_doctor_id is not null and v_doctors is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND', detail = 'doctor';
  end if;
  v_doctors := coalesce(v_doctors, '{}');

  return query
  with appts as (
    select a.doctor_id, a.service_id, a.starts_at, a.ends_at, a.status, a.source,
           a.checked_in_at, a.started_at, a.completed_at, a.cancellation_actor, a.cancellation_reason,
           (a.starts_at at time zone v_tz)::date as day
    from public.appointments a
    where a.clinic_id = p_clinic_id
      and a.doctor_id = any(v_doctors)
      and a.starts_at >= (p_from::timestamp at time zone v_tz)
      and a.starts_at < ((p_to + 1)::timestamp at time zone v_tz)
  ), keyed as (
    select case p_group when 'day' then ap.day::text when 'doctor' then ap.doctor_id::text
                        when 'service' then ap.service_id::text else 'total' end as k,
           ap.*,
           (ap.status = 'cancelled' and ap.cancellation_reason = 'left_before_consultation') as is_left,
           case when ap.status = 'completed' and ap.started_at is not null and ap.checked_in_at is not null then
             greatest(0, extract(epoch from ap.started_at - case when ap.source = 'walk_in' then ap.checked_in_at
                                                                  else greatest(ap.checked_in_at, ap.starts_at) end) / 60)
           end as wait
    from appts ap
  ), counts as (
    select kd.k,
           count(*)::integer as appointments,
           jsonb_build_object(
             'pending', count(*) filter (where kd.status = 'pending'),
             'confirmed', count(*) filter (where kd.status = 'confirmed'),
             'checked_in', count(*) filter (where kd.status = 'checked_in'),
             'in_progress', count(*) filter (where kd.status = 'in_progress'),
             'completed', count(*) filter (where kd.status = 'completed'),
             'cancelled', count(*) filter (where kd.status = 'cancelled'),
             'no_show', count(*) filter (where kd.status = 'no_show')) as by_status,
           jsonb_build_object(
             'staff', count(*) filter (where kd.source = 'staff'),
             'online', count(*) filter (where kd.source = 'online'),
             'walk_in', count(*) filter (where kd.source = 'walk_in')) as by_source,
           (count(*) filter (where kd.status = 'completed'))::integer as completed,
           (count(*) filter (where kd.status = 'cancelled' and not kd.is_left))::integer as cancelled,
           (count(*) filter (where kd.status = 'cancelled' and not kd.is_left and kd.cancellation_actor = 'patient'))::integer as by_patient,
           (count(*) filter (where kd.status = 'cancelled' and not kd.is_left and kd.cancellation_actor = 'clinic'))::integer as by_clinic,
           (count(*) filter (where kd.status = 'cancelled' and not kd.is_left and kd.cancellation_actor = 'system'))::integer as by_system,
           (count(*) filter (where kd.is_left))::integer as left_count,
           (count(*) filter (where kd.status = 'no_show' and kd.source <> 'walk_in'))::integer as no_show,
           (count(*) filter (where kd.source <> 'walk_in' and (kd.status in ('completed', 'no_show') or kd.is_left)))::integer as no_show_den,
           (count(kd.wait))::integer as wait_count,
           round(avg(kd.wait), 1) as wait_mean,
           round((percentile_cont(0.5) within group (order by kd.wait))::numeric, 1) as wait_median,
           round(coalesce(sum(extract(epoch from kd.ends_at - kd.starts_at) / 60) filter (where kd.status <> 'cancelled'), 0))::integer as booked,
           round(coalesce(sum(extract(epoch from kd.completed_at - kd.started_at) / 60)
                   filter (where kd.status = 'completed' and kd.started_at is not null and kd.completed_at is not null), 0))::integer as actual
    from keyed kd
    group by kd.k
  ), days as (
    select (p_from + i) as day from generate_series(0, p_to - p_from) as i
  ), open_days as (
    -- BR-B-06: a clinic closure removes the whole local day.
    select d.doctor_id, dd.day
    from unnest(v_doctors) as d(doctor_id)
    cross join days dd
    where p_group <> 'service'
      and not exists (select 1 from public.clinic_closures cc where cc.clinic_id = p_clinic_id and cc.dates @> dd.day)
  ), applicable as (
    -- The schedule that applies on that local date: an override beats the regular schedule.
    select od.doctor_id, od.day, sch.id as schedule_id
    from open_days od
    cross join lateral (
      select s.id from public.doctor_schedules s
      where s.doctor_id = od.doctor_id and s.valid_from <= od.day and (s.valid_until is null or s.valid_until >= od.day)
      order by (s.kind = 'override') desc
      limit 1) as sch
  ), windows as (
    select ap.doctor_id, ap.day,
           tstzrange((ap.day + a.start_time) at time zone v_tz, (ap.day + a.end_time) at time zone v_tz, '[)') as r
    from applicable ap
    join public.doctor_availability a on a.schedule_id = ap.schedule_id and a.weekday = extract(isodow from ap.day)::smallint
  ), free as (
    select w.doctor_id, w.day,
           (select coalesce(sum(extract(epoch from upper(x) - lower(x))), 0)
            from unnest(tstzmultirange(w.r) - coalesce(
                   (select range_agg(t.period) from public.doctor_time_off t where t.doctor_id = w.doctor_id and t.period && w.r),
                   '{}'::tstzmultirange)) as x) / 60 as minutes
    from windows w
  ), available as (
    select case p_group when 'day' then f.day::text when 'doctor' then f.doctor_id::text else 'total' end as k,
           round(sum(f.minutes))::integer as minutes
    from free f
    group by 1
  ), keys as (
    -- A period always answers one row (zeros, no rate), even without any record.
    select 'total'::text as k where p_group = 'total'
    union select c.k from counts c
    union select av.k from available av
  )
  select ks.k,
         coalesce(c.appointments, 0),
         coalesce(c.by_status, '{}'::jsonb),
         coalesce(c.by_source, '{}'::jsonb),
         coalesce(c.completed, 0),
         coalesce(c.cancelled, 0),
         coalesce(c.by_patient, 0),
         coalesce(c.by_clinic, 0),
         coalesce(c.by_system, 0),
         coalesce(c.left_count, 0),
         coalesce(c.no_show, 0),
         coalesce(c.no_show_den, 0),
         coalesce(c.wait_count, 0),
         c.wait_mean,
         c.wait_median,
         coalesce(c.booked, 0),
         case when p_group = 'service' then null else coalesce(av.minutes, 0) end,
         coalesce(c.actual, 0)
  from keys ks
  left join counts c on c.k = ks.k
  left join available av on av.k = ks.k
  order by 1;
end;
$$;

revoke all on function public.kpi_operational(uuid, date, date, text, uuid) from public, anon;
grant execute on function public.kpi_operational(uuid, date, date, text, uuid) to authenticated;
