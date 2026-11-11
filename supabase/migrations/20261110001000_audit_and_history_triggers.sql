-- SmartCabin 0010 — Audit trail and appointment history.
-- Audit rows record WHO changed WHICH fields of WHICH entity — never the values (BR-D-04).
-- Command functions may set two transaction-local settings read here:
--   smartcabin.actor_type    ('platform_admin' for platform commands)
--   smartcabin.change_reason (free-text reason supplied with a command)

create function private.current_actor_type()
returns public.actor_type
language sql
stable
set search_path = ''
as $$
  select coalesce(
    nullif(current_setting('smartcabin.actor_type', true), '')::public.actor_type,
    case when (select auth.uid()) is null then 'system'::public.actor_type else 'user'::public.actor_type end);
$$;

create function private.current_request_id()
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_headers text := nullif(current_setting('request.headers', true), '');
begin
  if v_headers is null then
    return null;
  end if;
  return left(v_headers::jsonb ->> 'x-request-id', 100);
exception when others then
  return null;
end;
$$;

create function private.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new     jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_old     jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_row     jsonb := coalesce(v_new, v_old);
  v_changed text[] := '{}';
  v_entity  uuid;
  v_clinic  uuid;
  v_meta    jsonb := '{}';
begin
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(n.key order by n.key), '{}')
      into v_changed
      from jsonb_each(v_new) as n
     where n.key not in ('updated_at', 'version')
       and n.value is distinct from v_old -> n.key;
    if cardinality(v_changed) = 0 then
      return null;
    end if;
  end if;

  v_entity := case
    when v_row ? 'id' and jsonb_typeof(v_row -> 'id') = 'string' then (v_row ->> 'id')::uuid
    when v_row ? 'user_id' then (v_row ->> 'user_id')::uuid
    when tg_table_name = 'clinic_settings' then (v_row ->> 'clinic_id')::uuid
  end;
  v_clinic := case
    when tg_table_name = 'clinics' then (v_row ->> 'id')::uuid
    when v_row ? 'clinic_id' then (v_row ->> 'clinic_id')::uuid
  end;
  if tg_table_name = 'doctor_services' then
    v_meta := jsonb_build_object('doctor_id', v_row -> 'doctor_id', 'service_id', v_row -> 'service_id');
  end if;

  insert into public.audit_logs
    (actor_type, actor_user_id, clinic_id, action, entity_type, entity_id, changed_fields, metadata, request_id)
  values
    (private.current_actor_type(), auth.uid(),
     -- A clinic row being created does not exist yet for the FK check of other rows: fine (same transaction).
     v_clinic,
     tg_table_name || '.' || lower(tg_op), tg_table_name, v_entity, v_changed, v_meta, private.current_request_id());
  return null;
end;
$$;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'clinics', 'clinic_settings', 'clinic_members', 'clinic_invitations', 'clinic_closures', 'platform_admins',
    'services', 'doctors', 'doctor_services', 'doctor_schedules', 'doctor_availability', 'doctor_time_off',
    'patients', 'patient_accounts', 'appointments']
  loop
    execute format(
      'create trigger %I after insert or update or delete on public.%I
         for each row execute function private.audit_row_change()',
      v_table || '_audit', v_table);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- appointment_history writer
-- ---------------------------------------------------------------------------
create function private.record_appointment_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  public.actor_type := private.current_actor_type();
  v_reason text := left(nullif(current_setting('smartcabin.change_reason', true), ''), 300);
begin
  if tg_op = 'INSERT' then
    insert into public.appointment_history
      (clinic_id, appointment_id, event_type, to_status, new_starts_at, actor_type, actor_user_id, reason)
    values (new.clinic_id, new.id, 'created', new.status, new.starts_at, v_actor, auth.uid(), v_reason);
    return null;
  end if;

  if new.status is distinct from old.status then
    insert into public.appointment_history
      (clinic_id, appointment_id, event_type, from_status, to_status, actor_type, actor_user_id, reason)
    values (new.clinic_id, new.id, 'status_changed', old.status, new.status, v_actor, auth.uid(), v_reason);
  end if;

  if new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at then
    insert into public.appointment_history
      (clinic_id, appointment_id, event_type, previous_starts_at, new_starts_at, actor_type, actor_user_id, reason)
    values (new.clinic_id, new.id, 'rescheduled', old.starts_at, new.starts_at, v_actor, auth.uid(), v_reason);
  end if;
  return null;
end;
$$;

create trigger appointments_history
  after insert or update on public.appointments
  for each row execute function private.record_appointment_history();
