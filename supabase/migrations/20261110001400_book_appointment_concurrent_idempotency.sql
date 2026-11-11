-- SmartCabin 0014 — Fix: concurrent retries with the same idempotency key.
--
-- Found by tests/db/concurrency.test.ts: when several retries of one booking run at the same
-- time, the losers hit the exclusion constraint (same doctor, same slot) before the unique
-- idempotency index, and received SLOT_UNAVAILABLE instead of the original appointment.
-- Both violations now first look for a committed appointment with the same key.
-- Forward-only replacement of the function from 0012; signature and grants unchanged.

create or replace function public.book_appointment(
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
    v_existing := private.find_idempotent_booking(v_clinic_id, p_idempotency_key, p_patient_id, p_doctor_id, p_service_id, p_starts_at);
    if v_existing.id is not null then
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

  perform set_config('smartcabin.change_reason', coalesce(nullif(btrim(p_overbook_reason), ''), ''), true);
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
    when exclusion_violation or unique_violation then
      -- A concurrent request with the same key may have committed first: return its result.
      -- The statement waited for that transaction, so the row is visible to this new query.
      if p_idempotency_key is not null then
        v_existing := private.find_idempotent_booking(v_clinic_id, p_idempotency_key, p_patient_id, p_doctor_id, p_service_id, p_starts_at);
        if v_existing.id is not null then
          return v_existing;
        end if;
      end if;
      if sqlstate = '23P01' then
        raise exception using errcode = 'P0001', message = 'SLOT_UNAVAILABLE', detail = 'overlaps another appointment';
      end if;
      raise;
  end;

  perform private.emit_event(v_clinic_id, 'appointment', v_row.id, 'appointment.confirmed');
  return v_row;
end;
$$;

-- Returns the appointment already booked with this key (empty record if none), or raises
-- IDEMPOTENCY_KEY_REUSED when the key was used for a different booking.
create function private.find_idempotent_booking(
  p_clinic_id uuid, p_key text, p_patient_id uuid, p_doctor_id uuid, p_service_id uuid, p_starts_at timestamptz)
returns public.appointments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_existing public.appointments;
begin
  select * into v_existing from public.appointments a where a.clinic_id = p_clinic_id and a.idempotency_key = p_key;
  if found and (v_existing.patient_id <> p_patient_id or v_existing.doctor_id <> p_doctor_id
                or v_existing.service_id <> p_service_id or v_existing.starts_at <> p_starts_at) then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
  end if;
  return v_existing;
end;
$$;
