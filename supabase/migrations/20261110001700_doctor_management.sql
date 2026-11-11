-- SmartClinic 0017 — Module 3: doctor management.
-- set_doctor_services replaces a doctor's offered services in ONE transaction (API_SPECIFICATION
-- BC3). Rows already referenced by appointments are never deleted: unselected services are
-- deactivated instead. Overrides must respect the service bounds.

create function public.set_doctor_services(p_doctor_id uuid, p_services jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid;
  v_item      jsonb;
  v_service   uuid;
  v_duration  integer;
  v_price     numeric;
  v_online    boolean;
  v_selected  uuid[] := '{}';
begin
  select d.clinic_id into v_clinic_id from public.doctors d where d.id = p_doctor_id;
  if v_clinic_id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.require_clinic_access(v_clinic_id);
  perform private.require_permission(v_clinic_id, 'doctors.manage');
  if jsonb_typeof(p_services) <> 'array' or jsonb_array_length(p_services) > 100 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'services must be an array of at most 100 items';
  end if;

  for v_item in select value from jsonb_array_elements(p_services) loop
    begin
      v_service  := (v_item ->> 'service_id')::uuid;
      v_duration := nullif(v_item ->> 'duration_minutes', '')::integer;
      v_price    := nullif(v_item ->> 'price_mad', '')::numeric;
      v_online   := coalesce((v_item ->> 'online_bookable')::boolean, true);
    exception when others then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'malformed service item';
    end;
    -- Same clinic only (also guaranteed by the composite foreign key).
    if not exists (select 1 from public.services s where s.clinic_id = v_clinic_id and s.id = v_service) then
      raise exception using errcode = 'P0002', message = 'NOT_FOUND', detail = 'service';
    end if;
    v_selected := v_selected || v_service;
    insert into public.doctor_services (clinic_id, doctor_id, service_id, duration_minutes, price_mad, online_bookable, is_active)
    values (v_clinic_id, p_doctor_id, v_service, v_duration, v_price, v_online, true)
    on conflict (clinic_id, doctor_id, service_id) do update
      set duration_minutes = excluded.duration_minutes,
          price_mad        = excluded.price_mad,
          online_bookable  = excluded.online_bookable,
          is_active        = true;
  end loop;

  update public.doctor_services ds
     set is_active = false
   where ds.clinic_id = v_clinic_id and ds.doctor_id = p_doctor_id and ds.is_active
     and not (ds.service_id = any (v_selected));
end;
$$;

-- Future active appointments of a doctor (count only): shown before deactivating a doctor.
create function public.count_future_appointments(p_doctor_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid;
begin
  select d.clinic_id into v_clinic_id from public.doctors d where d.id = p_doctor_id;
  if v_clinic_id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.require_clinic_access(v_clinic_id);
  perform private.require_permission(v_clinic_id, 'doctors.manage');
  return (select count(*)::integer from public.appointments a
          where a.doctor_id = p_doctor_id and a.starts_at > now()
            and a.status in ('pending', 'confirmed'));
end;
$$;

revoke all on function public.set_doctor_services(uuid, jsonb) from public, anon;
revoke all on function public.count_future_appointments(uuid) from public, anon;
grant execute on function public.set_doctor_services(uuid, jsonb) to authenticated;
grant execute on function public.count_future_appointments(uuid) to authenticated;
