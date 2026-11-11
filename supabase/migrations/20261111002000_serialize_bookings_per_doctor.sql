-- SmartClinic 0020 — Fix SC-AUD-23: deadlocks between simultaneous overlapping bookings.
--
-- With an exclusion constraint, two transactions that insert overlapping appointments for the
-- same doctor each add their index entry, then wait for the other's in-progress entry. That cycle
-- is broken by PostgreSQL with 40P01 (deadlock detected), so reception saw "unexpected error"
-- instead of SLOT_UNAVAILABLE. Integrity was never at risk: no overlapping pair was committed.
--
-- Correction: writes that place an appointment in a doctor's agenda take a transaction-scoped
-- advisory lock per doctor just before writing. The second writer waits for the first to commit,
-- then meets a committed conflict and gets exclusion_violation → SLOT_UNAVAILABLE.
--
-- Lock order (acyclic, so no new deadlock is possible):
--   book_appointment:       idempotency key (0019) → doctor
--   reschedule_appointment: appointment row (FOR UPDATE) → doctor
-- Future commands that put an appointment back into an active status or move it (for example the
-- no_show → checked_in correction, module 7) must call private.lock_doctor_bookings too.
--
-- Forward-only: book_appointment (0019) and reschedule_appointment (0012) are replaced with the
-- lock added and nothing else changed; signatures and grants are unchanged.

-- ---------------------------------------------------------------------------
-- private.lock_doctor_bookings — serializes writes to one doctor's agenda until commit
-- ---------------------------------------------------------------------------
create function private.lock_doctor_bookings(p_doctor_id uuid)
returns void
language sql
volatile
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('smartclinic:doctor-bookings:' || p_doctor_id::text, 0));
$$;

revoke all on function private.lock_doctor_bookings(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- book_appointment — as in 0019, plus the per-doctor lock before the insert
-- ---------------------------------------------------------------------------
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

  -- Retries carrying the same key are serialized: the next one waits for the first to commit,
  -- then finds its appointment. Without this, two retries can deadlock on the unique key
  -- index and the exclusion constraint (found by tests/db/concurrency.test.ts).
  if p_idempotency_key is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_clinic_id::text || ':' || p_idempotency_key, 0));
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

  -- SC-AUD-23: one writer at a time per doctor (see the header).
  perform private.lock_doctor_bookings(p_doctor_id);

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

-- ---------------------------------------------------------------------------
-- reschedule_appointment — as in 0012, plus the per-doctor lock before the update
-- ---------------------------------------------------------------------------
create or replace function public.reschedule_appointment(
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

  -- SC-AUD-23: one writer at a time per doctor (see the header). Taken after the row lock.
  perform private.lock_doctor_bookings(v_appt.doctor_id);

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
