-- =============================================================================
-- 0030 patient portal (slice S7): account creation guard, public clinic profile and online
-- slots, online booking, cancellation by the patient, expiry of unconfirmed bookings.
-- BUSINESS_RULES §2 (A1, A2, A6, A7, BR-B-01…11), BR-D-02, BR-P-01/02; SC-AUD-01.
--
-- Accounts: Supabase Auth creates a phone account during online booking (sign-ups by SMS are
-- enabled again), and this migration's before-user-created hook accepts only Moroccan mobile
-- numbers. With CAPTCHA and the SMS rate limits (config.toml), abuse stays capped and never
-- reaches premium or foreign ranges.
-- Public reads (anon) return clinic profile data and free slot times only: no patient data.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Supabase Auth hook: before a user is created (config.toml [auth.hook.before_user_created]).
-- Email sign-ups pass (staff); a phone sign-up must be a Moroccan mobile number.
-- ---------------------------------------------------------------------------
create function public.before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_phone text := regexp_replace(coalesce(event -> 'user' ->> 'phone', ''), '^\+', '');
begin
  if v_phone = '' or v_phone ~ '^212[67][0-9]{8}$' then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'Only Moroccan mobile numbers can create a patient account.'));
end;
$$;
revoke all on function public.before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.before_user_created(jsonb) to supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- A clinic takes online bookings: active (BR-B-01, BR-P-02), switched on, subscription not
-- expired (BR-P-01).
create function private.online_booking_open(p_clinic_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.clinics c join public.clinic_settings s on s.clinic_id = c.id
    where c.id = p_clinic_id and c.status = 'active' and s.online_booking_enabled)
    and not private.subscription_expired(p_clinic_id);
$$;
revoke all on function private.online_booking_open(uuid) from public, anon, authenticated;

-- The signed-in portal account and its phone (E.164). Phone accounts only.
create function private.require_portal_account()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_phone text;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'UNAUTHENTICATED';
  end if;
  select u.phone into v_phone from auth.users u where u.id = (select auth.uid());
  if coalesce(v_phone, '') = '' then
    raise exception using errcode = '42501', message = 'FORBIDDEN', detail = 'phone account required';
  end if;
  return '+' || regexp_replace(v_phone, '^\+', '');
end;
$$;
revoke all on function private.require_portal_account() from public, anon, authenticated;

-- Free online slots (BR-B-04…08 with the online flags, BR-B-07 lead time and horizon).
-- Same computation as get_available_slots (migration 0021), with the online rules on top.
create function private.free_online_slots(p_clinic_id uuid, p_doctor_id uuid, p_service_id uuid, p_from date, p_to date)
returns table (slot_starts_at timestamptz, slot_ends_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz       text;
  v_duration integer;
  v_lead     integer;
  v_horizon  integer;
begin
  select c.timezone, s.min_lead_minutes, s.max_horizon_days into v_tz, v_lead, v_horizon
  from public.clinics c join public.clinic_settings s on s.clinic_id = c.id where c.id = p_clinic_id;
  select e.duration_minutes into v_duration from private.effective_service(p_clinic_id, p_doctor_id, p_service_id, true) e;

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
  where sl.s >= now() + make_interval(mins => v_lead)
    and sl.s < now() + make_interval(days => v_horizon)
    and (sl.e at time zone v_tz) <= sl.day + sl.end_time
    and not exists (select 1 from public.doctor_time_off t
                    where t.doctor_id = p_doctor_id and t.period && tstzrange(sl.s, sl.e, '[)'))
    and not exists (select 1 from public.clinic_closures cc
                    where cc.clinic_id = p_clinic_id and cc.dates @> (sl.s at time zone v_tz)::date)
    and not exists (select 1 from public.appointments x
                    where x.doctor_id = p_doctor_id
                      and x.starts_at < sl.e
                      and x.starts_at > sl.s - interval '480 minutes'
                      and x.ends_at > sl.s
                      and x.status in ('pending', 'confirmed', 'checked_in', 'in_progress'))
  order by sl.s;
end;
$$;
revoke all on function private.free_online_slots(uuid, uuid, uuid, date, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Public reads (anon): the clinic's booking page. Clinic profile and slot times only.
-- ---------------------------------------------------------------------------
create function public.public_get_clinic_profile(p_slug text)
returns table (
  clinic_id uuid, slug text, display_name text, city text, address_line text, phone_e164 text, timezone text,
  default_locale text, online_booking_open boolean, auto_confirm_online boolean, min_lead_minutes integer,
  max_horizon_days integer, patient_cancel_cutoff_hours integer, offerings jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_clinic public.clinics;
begin
  select * into v_clinic from public.clinics c where c.slug = lower(btrim(p_slug)) and c.status = 'active';
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  return query
  select v_clinic.id, v_clinic.slug::text, v_clinic.display_name, v_clinic.city, v_clinic.address_line, v_clinic.phone_e164,
         v_clinic.timezone, v_clinic.default_locale, private.online_booking_open(v_clinic.id), s.auto_confirm_online,
         s.min_lead_minutes, s.max_horizon_days, s.patient_cancel_cutoff_hours,
         case when private.online_booking_open(v_clinic.id) then coalesce((
           select jsonb_agg(jsonb_build_object(
                    'doctor_id', d.id, 'doctor_name', d.full_name, 'doctor_name_ar', d.full_name_ar,
                    'service_id', sv.id, 'service_name_fr', sv.name_fr, 'service_name_ar', sv.name_ar,
                    'duration_minutes', coalesce(ds.duration_minutes, sv.default_duration_minutes),
                    'price_mad', coalesce(ds.price_mad, sv.price_mad))
                  order by sv.name_fr, d.full_name)
           from public.doctor_services ds
           join public.doctors d   on d.clinic_id = ds.clinic_id and d.id = ds.doctor_id
           join public.services sv on sv.clinic_id = ds.clinic_id and sv.id = ds.service_id
           where ds.clinic_id = v_clinic.id and ds.is_active and ds.online_bookable
             and d.status = 'active' and d.online_bookable and sv.status = 'active' and sv.online_bookable), '[]'::jsonb)
         else '[]'::jsonb end
  from public.clinic_settings s where s.clinic_id = v_clinic.id;
end;
$$;

create function public.public_get_available_slots(p_slug text, p_doctor_id uuid, p_service_id uuid, p_from date, p_to date)
returns table (slot_starts_at timestamptz, slot_ends_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid;
begin
  select c.id into v_clinic_id from public.clinics c where c.slug = lower(btrim(p_slug)) and c.status = 'active';
  if v_clinic_id is null or not private.online_booking_open(v_clinic_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 13 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'date range must cover 1 to 14 days';
  end if;
  if not exists (select 1 from public.doctors d where d.id = p_doctor_id and d.clinic_id = v_clinic_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  return query select * from private.free_online_slots(v_clinic_id, p_doctor_id, p_service_id, p_from, p_to);
end;
$$;

-- ---------------------------------------------------------------------------
-- Portal (signed-in phone account): people linked in a clinic, booking, cancellation.
-- ---------------------------------------------------------------------------
create function public.portal_list_my_people(p_clinic_id uuid)
returns table (patient_id uuid, first_name text, last_name text, relationship public.patient_relationship)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.require_portal_account();
  return query
  select p.id, p.first_name, p.last_name, pa.relationship
  from public.patient_accounts pa
  join public.patients p on p.clinic_id = pa.clinic_id and p.id = pa.patient_id
  where pa.user_id = (select auth.uid()) and pa.clinic_id = p_clinic_id and pa.revoked_at is null and p.status = 'active'
  order by (pa.relationship = 'self') desc, p.first_name;
end;
$$;

-- A1/A2 online. The person is one already linked to this account in this clinic, or a new
-- record created now and linked (BR-D-02: never found by phone matching; reception merges
-- duplicates). p_new_person: {"first_name", "last_name", "relationship", "date_of_birth"?,
-- "sex"?, "preferred_locale"?, "reminders_sms": bool, "data_processing": true}.
create function public.portal_book_appointment(
  p_clinic_id       uuid,
  p_doctor_id       uuid,
  p_service_id      uuid,
  p_starts_at       timestamptz,
  p_patient_id      uuid default null,
  p_new_person      jsonb default null,
  p_idempotency_key text default null)
returns table (appointment_id uuid, status public.appointment_status)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_phone    text := private.require_portal_account();
  v_settings public.clinic_settings;
  v_existing public.appointments;
  v_patient  uuid;
  v_rel      public.patient_relationship;
  v_duration integer;
  v_price    numeric;
  v_status   public.appointment_status;
  v_row      public.appointments;
begin
  perform set_config('smartcabin.actor_type', 'patient', true);
  if not private.online_booking_open(p_clinic_id) then
    raise exception using errcode = 'P0001', message = 'ONLINE_BOOKING_NOT_ALLOWED';
  end if;
  if not exists (select 1 from public.doctors d where d.id = p_doctor_id and d.clinic_id = p_clinic_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND', detail = 'doctor';
  end if;
  if (p_patient_id is null) = (p_new_person is null) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'one person required';
  end if;

  -- BR-B-10: a retried request returns the first booking.
  if p_idempotency_key is not null then
    if char_length(p_idempotency_key) not between 8 and 100 then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'idempotency key length';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(p_clinic_id::text || ':' || p_idempotency_key, 0));
    select * into v_existing from public.appointments a where a.clinic_id = p_clinic_id and a.idempotency_key = p_idempotency_key;
    if found then
      if v_existing.booked_by_user_id is distinct from (select auth.uid()) or v_existing.doctor_id <> p_doctor_id
         or v_existing.service_id <> p_service_id or v_existing.starts_at <> p_starts_at then
        raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
      end if;
      return query select v_existing.id, v_existing.status;
      return;
    end if;
  end if;

  select * into v_settings from public.clinic_settings s where s.clinic_id = p_clinic_id;
  -- BR-B-07: lead time and horizon.
  if p_starts_at is null or p_starts_at < now() + make_interval(mins => v_settings.min_lead_minutes)
     or p_starts_at >= now() + make_interval(days => v_settings.max_horizon_days) then
    raise exception using errcode = 'P0001', message = 'BOOKING_RULE_VIOLATED', detail = 'lead time or horizon';
  end if;
  -- BR-B-09: active future online bookings of this account in this clinic.
  if (select count(*) from public.appointments a
      where a.clinic_id = p_clinic_id and a.booked_by_user_id = (select auth.uid()) and a.source = 'online'
        and a.status in ('pending', 'confirmed') and a.starts_at > now()) >= v_settings.max_active_online_bookings then
    raise exception using errcode = 'P0001', message = 'BOOKING_RULE_VIOLATED', detail = 'active booking limit';
  end if;

  select e.duration_minutes, e.price_mad into v_duration, v_price
  from private.effective_service(p_clinic_id, p_doctor_id, p_service_id, true) e;
  perform private.assert_slot_bookable(p_clinic_id, p_doctor_id, p_starts_at, p_starts_at + make_interval(mins => v_duration));

  if p_patient_id is not null then
    -- Only a person linked to this account (BR-D-02); anything else looks like nothing.
    select pa.patient_id into v_patient
    from public.patient_accounts pa join public.patients p on p.clinic_id = pa.clinic_id and p.id = pa.patient_id
    where pa.user_id = (select auth.uid()) and pa.clinic_id = p_clinic_id and pa.patient_id = p_patient_id
      and pa.revoked_at is null and p.status = 'active';
    if v_patient is null then
      raise exception using errcode = 'P0002', message = 'NOT_FOUND', detail = 'patient';
    end if;
  else
    begin
      v_rel := (p_new_person ->> 'relationship')::public.patient_relationship;
    exception when others then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'relationship';
    end;
    if v_rel is null or coalesce((p_new_person ->> 'data_processing')::boolean, false) is not true
       or char_length(btrim(coalesce(p_new_person ->> 'first_name', ''))) not between 1 and 80
       or char_length(btrim(coalesce(p_new_person ->> 'last_name', ''))) not between 1 and 80 then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'person';
    end if;
    if v_rel = 'self' and exists (select 1 from public.patient_accounts pa
                                  where pa.user_id = (select auth.uid()) and pa.clinic_id = p_clinic_id
                                    and pa.relationship = 'self' and pa.revoked_at is null) then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'self already linked';
    end if;
    begin
      insert into public.patients (clinic_id, first_name, last_name, sex, date_of_birth, phone_e164, preferred_locale,
                                   preferred_channel, created_via)
      values (p_clinic_id, btrim(p_new_person ->> 'first_name'), btrim(p_new_person ->> 'last_name'),
              nullif(p_new_person ->> 'sex', '')::public.sex, nullif(p_new_person ->> 'date_of_birth', '')::date,
              v_phone, coalesce(nullif(p_new_person ->> 'preferred_locale', ''), 'fr'),
              case when coalesce((p_new_person ->> 'reminders_sms')::boolean, false) then 'sms' else 'none' end::public.contact_channel,
              'online')
      returning id into v_patient;
    exception
      when check_violation or invalid_text_representation or datetime_field_overflow or invalid_datetime_format then
        raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'person';
    end;
    insert into public.patient_consents (clinic_id, patient_id, purpose, granted, document_version, source)
    values (p_clinic_id, v_patient, 'data_processing', true, 'v1', 'online'),
           (p_clinic_id, v_patient, 'reminders_sms', coalesce((p_new_person ->> 'reminders_sms')::boolean, false), 'v1', 'online');
    insert into public.patient_accounts (user_id, clinic_id, patient_id, relationship, linked_via)
    values ((select auth.uid()), p_clinic_id, v_patient, v_rel, 'online_booking');
  end if;

  -- A1 (pending, the clinic confirms) or A2 (auto-confirmed).
  v_status := case when v_settings.auto_confirm_online then 'confirmed' else 'pending' end;
  perform private.lock_doctor_bookings(p_doctor_id);
  begin
    insert into public.appointments (
      clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, source,
      price_mad, idempotency_key, booked_by_user_id, confirmed_at)
    values (
      p_clinic_id, v_patient, p_doctor_id, p_service_id, p_starts_at, p_starts_at + make_interval(mins => v_duration),
      v_status, 'online', v_price, p_idempotency_key, (select auth.uid()), case when v_status = 'confirmed' then now() end)
    returning * into v_row;
  exception
    when exclusion_violation then
      raise exception using errcode = 'P0001', message = 'SLOT_UNAVAILABLE', detail = 'overlaps another appointment';
  end;
  perform private.emit_event(p_clinic_id, 'appointment', v_row.id,
    case when v_status = 'confirmed' then 'appointment.confirmed' else 'appointment.booked' end);
  return query select v_row.id, v_row.status;
end;
$$;

-- A6 by the patient: an appointment of a person linked to this account, before the cutoff.
create function public.portal_cancel_appointment(p_appointment_id uuid)
returns public.appointment_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_appt   public.appointments;
  v_cutoff integer;
begin
  perform private.require_portal_account();
  perform set_config('smartcabin.actor_type', 'patient', true);
  select a.* into v_appt
  from public.appointments a
  join public.patient_accounts pa on pa.clinic_id = a.clinic_id and pa.patient_id = a.patient_id
  where a.id = p_appointment_id and pa.user_id = (select auth.uid()) and pa.revoked_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  select * into v_appt from public.appointments a where a.id = p_appointment_id for update;
  if v_appt.status not in ('pending', 'confirmed') then
    raise exception using errcode = 'P0001', message = 'APPT_INVALID_TRANSITION';
  end if;
  select s.patient_cancel_cutoff_hours into v_cutoff from public.clinic_settings s where s.clinic_id = v_appt.clinic_id;
  if now() > v_appt.starts_at - make_interval(hours => v_cutoff) then
    raise exception using errcode = 'P0001', message = 'BOOKING_RULE_VIOLATED', detail = 'cancellation cutoff passed';
  end if;
  perform set_config('smartcabin.change_reason', '', true);
  update public.appointments
     set status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = (select auth.uid()),
         cancellation_actor = 'patient', cancellation_reason = 'patient_request'
   where id = p_appointment_id;
  perform private.emit_event(v_appt.clinic_id, 'appointment', v_appt.id, 'appointment.cancelled');
  return 'cancelled';
end;
$$;

-- Portal list, now with the clinic's booking page and the cancellation deadline. The return type
-- changes, so the function is recreated (same name, same rules as migration 0013).
drop function public.portal_list_my_appointments();
create function public.portal_list_my_appointments()
returns table (
  appointment_id     uuid,
  clinic_name        text,
  clinic_slug        text,
  clinic_timezone    text,
  patient_first_name text,
  relationship       public.patient_relationship,
  doctor_name        text,
  service_name_fr    text,
  service_name_ar    text,
  starts_at          timestamptz,
  ends_at            timestamptz,
  status             public.appointment_status,
  cancel_until       timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_authenticated();
  return query
  select a.id, c.display_name, c.slug::text, c.timezone, p.first_name, pa.relationship, d.full_name, s.name_fr, s.name_ar,
         a.starts_at, a.ends_at, a.status,
         case when a.status in ('pending', 'confirmed') and c.status = 'active'
              then a.starts_at - make_interval(hours => cs.patient_cancel_cutoff_hours) end
  from public.patient_accounts pa
  join public.patients p          on p.clinic_id = pa.clinic_id and p.id = pa.patient_id
  join public.clinics c           on c.id = pa.clinic_id
  join public.clinic_settings cs  on cs.clinic_id = c.id
  join public.appointments a      on a.clinic_id = pa.clinic_id and a.patient_id = pa.patient_id
  join public.doctors d           on d.clinic_id = a.clinic_id and d.id = a.doctor_id
  join public.services s          on s.clinic_id = a.clinic_id and s.id = a.service_id
  where pa.user_id = (select auth.uid())
    and pa.revoked_at is null
    and c.status in ('active', 'suspended')
    and a.starts_at >= now() - interval '30 days'
  order by a.starts_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- A7: unconfirmed online bookings whose start has passed are cancelled by the system.
-- ---------------------------------------------------------------------------
create function private.expire_pending_appointments()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_appt  public.appointments;
  v_count integer := 0;
begin
  perform set_config('smartcabin.actor_type', 'system', true);
  for v_appt in
    select * from public.appointments a where a.status = 'pending' and a.starts_at <= now()
    for update skip locked
  loop
    update public.appointments
       set status = 'cancelled', cancelled_at = now(), cancellation_actor = 'system', cancellation_reason = 'not_confirmed_in_time'
     where id = v_appt.id;
    perform private.emit_event(v_appt.clinic_id, 'appointment', v_appt.id, 'appointment.cancelled');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function private.expire_pending_appointments() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule('smartcabin-expire-pending', '*/10 * * * *', 'select private.expire_pending_appointments()');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: the two public reads to anon and authenticated; portal functions to authenticated.
-- ---------------------------------------------------------------------------
revoke all on function public.public_get_clinic_profile(text) from public;
revoke all on function public.public_get_available_slots(text, uuid, uuid, date, date) from public;
revoke all on function public.portal_list_my_people(uuid) from public, anon;
revoke all on function public.portal_book_appointment(uuid, uuid, uuid, timestamptz, uuid, jsonb, text) from public, anon;
revoke all on function public.portal_cancel_appointment(uuid) from public, anon;
revoke all on function public.portal_list_my_appointments() from public, anon;
grant execute on function public.public_get_clinic_profile(text) to anon, authenticated;
grant execute on function public.public_get_available_slots(text, uuid, uuid, date, date) to anon, authenticated;
grant execute on function public.portal_list_my_people(uuid) to authenticated;
grant execute on function public.portal_book_appointment(uuid, uuid, uuid, timestamptz, uuid, jsonb, text) to authenticated;
grant execute on function public.portal_cancel_appointment(uuid) to authenticated;
grant execute on function public.portal_list_my_appointments() to authenticated;
