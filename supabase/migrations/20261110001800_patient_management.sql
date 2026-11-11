-- SmartClinic 0018 — Module 4: patient management.
-- register_patient   : record + consents in ONE transaction (fixes the two-write gap of Phase 4).
-- get_patient        : detail view, writes `patient.viewed` to the audit log (BR-D-03).
-- set_patient_archived, merge_patients, list_patient_duplicates.
-- Appointments keep pointing at their original record (patient_id is immutable): a merged
-- record stays as history, linked to the surviving one through merged_into_id.

create function public.register_patient(p_clinic_id uuid, p_patient jsonb, p_consents jsonb default '[]')
returns table (patient_id uuid, file_number text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.patients;
  v_item jsonb;
begin
  perform private.require_clinic_access(p_clinic_id);
  perform private.require_permission(p_clinic_id, 'patients.create');
  if jsonb_typeof(coalesce(p_consents, '[]')) <> 'array' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'consents must be an array';
  end if;
  if jsonb_array_length(coalesce(p_consents, '[]')) > 0 then
    perform private.require_permission(p_clinic_id, 'consents.record');
  end if;
  if coalesce(p_patient ->> 'created_via', 'reception') not in ('reception', 'walk_in', 'import') then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'created_via';
  end if;

  insert into public.patients (clinic_id, first_name, last_name, first_name_ar, last_name_ar, sex, date_of_birth,
                               phone_e164, email, preferred_locale, preferred_channel, created_via)
  values (
    p_clinic_id,
    btrim(p_patient ->> 'first_name'),
    btrim(p_patient ->> 'last_name'),
    nullif(btrim(p_patient ->> 'first_name_ar'), ''),
    nullif(btrim(p_patient ->> 'last_name_ar'), ''),
    nullif(p_patient ->> 'sex', '')::public.sex,
    nullif(p_patient ->> 'date_of_birth', '')::date,
    nullif(p_patient ->> 'phone_e164', ''),
    nullif(p_patient ->> 'email', '')::extensions.citext,
    coalesce(nullif(p_patient ->> 'preferred_locale', ''), 'fr'),
    coalesce(nullif(p_patient ->> 'preferred_channel', ''), 'sms')::public.contact_channel,
    coalesce(nullif(p_patient ->> 'created_via', ''), 'reception')::public.patient_origin)
  returning * into v_row;

  for v_item in select value from jsonb_array_elements(coalesce(p_consents, '[]')) loop
    insert into public.patient_consents (clinic_id, patient_id, purpose, granted, document_version, source)
    values (p_clinic_id, v_row.id, (v_item ->> 'purpose')::public.consent_purpose, (v_item ->> 'granted')::boolean,
            coalesce(nullif(v_item ->> 'document_version', ''), 'v1'),
            coalesce(nullif(v_item ->> 'source', ''), 'reception')::public.consent_source);
  end loop;

  return query select v_row.id, v_row.file_number;
end;
$$;

-- Practitioner-only members see only patients they have appointments with (Q7).
create function private.require_patient_access(p_patient_id uuid, p_permission text)
returns public.patients
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row public.patients;
begin
  select * into v_row from public.patients p where p.id = p_patient_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.require_clinic_access(v_row.clinic_id);
  perform private.require_permission(v_row.clinic_id, p_permission);
  if private.is_practitioner_only(v_row.clinic_id)
     and p_patient_id not in (select private.my_doctor_patient_ids()) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  return v_row;
end;
$$;

create function public.get_patient(p_patient_id uuid)
returns setof public.patients
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.patients := private.require_patient_access(p_patient_id, 'patients.view');
begin
  insert into public.audit_logs (actor_type, actor_user_id, clinic_id, action, entity_type, entity_id, request_id)
  values (private.current_actor_type(), auth.uid(), v_row.clinic_id, 'patient.viewed', 'patients', v_row.id, private.current_request_id());
  return next v_row;
end;
$$;

create function public.set_patient_archived(p_patient_id uuid, p_archived boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.patients := private.require_patient_access(p_patient_id, 'patients.archive');
begin
  if v_row.status = 'merged' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'merged records cannot change status';
  end if;
  update public.patients
     set status = case when p_archived then 'archived'::public.patient_status else 'active'::public.patient_status end,
         archived_at = case when p_archived then now() end
   where id = p_patient_id;
end;
$$;

-- Candidate duplicates: same phone number, or same last name and birth date.
create function public.list_patient_duplicates(p_patient_id uuid)
returns table (patient_id uuid, file_number text, first_name text, last_name text, date_of_birth date, phone_e164 text, reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row public.patients := private.require_patient_access(p_patient_id, 'patients.merge');
begin
  return query
  select p.id, p.file_number, p.first_name, p.last_name, p.date_of_birth, p.phone_e164,
         case when p.phone_e164 = v_row.phone_e164 then 'phone' else 'name_birth_date' end
  from public.patients p
  where p.clinic_id = v_row.clinic_id and p.id <> v_row.id and p.status <> 'merged'
    and ((v_row.phone_e164 is not null and p.phone_e164 = v_row.phone_e164)
         or (v_row.date_of_birth is not null and p.date_of_birth = v_row.date_of_birth
             and lower(p.last_name) = lower(v_row.last_name)))
  order by p.last_name, p.first_name
  limit 20;
end;
$$;

-- Merges `source` into `target` (same clinic). The source becomes history: status merged,
-- merged_into_id = target. Portal links move to the target; appointments, consents and
-- invoices keep their original record (immutable history), and the detail view shows both.
create function public.merge_patients(p_source_id uuid, p_target_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_source public.patients := private.require_patient_access(p_source_id, 'patients.merge');
  v_target public.patients;
begin
  select * into v_target from public.patients p where p.id = p_target_id and p.clinic_id = v_source.clinic_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform 1 from public.patients p where p.id = p_source_id for update;
  if p_source_id = p_target_id or v_source.status = 'merged' or v_target.status <> 'active' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'invalid merge pair';
  end if;

  -- Portal links: move to the target, or revoke when the account is already linked to it.
  update public.patient_accounts pa set revoked_at = now()
   where pa.patient_id = p_source_id and pa.revoked_at is null
     and exists (select 1 from public.patient_accounts t where t.user_id = pa.user_id and t.patient_id = p_target_id and t.revoked_at is null);
  update public.patient_accounts pa set patient_id = p_target_id
   where pa.patient_id = p_source_id and pa.revoked_at is null;

  update public.patients set status = 'merged', merged_into_id = p_target_id, archived_at = null where id = p_source_id;
  perform private.emit_event(v_source.clinic_id, 'patient', p_target_id, 'patient.merged', jsonb_build_object('source_id', p_source_id));
end;
$$;

revoke all on function public.register_patient(uuid, jsonb, jsonb) from public, anon;
revoke all on function public.get_patient(uuid) from public, anon;
revoke all on function public.set_patient_archived(uuid, boolean) from public, anon;
revoke all on function public.list_patient_duplicates(uuid) from public, anon;
revoke all on function public.merge_patients(uuid, uuid) from public, anon;
grant execute on function public.register_patient(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.get_patient(uuid) to authenticated;
grant execute on function public.set_patient_archived(uuid, boolean) to authenticated;
grant execute on function public.list_patient_duplicates(uuid) to authenticated;
grant execute on function public.merge_patients(uuid, uuid) to authenticated;
