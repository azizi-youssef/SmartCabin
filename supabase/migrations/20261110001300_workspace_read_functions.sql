-- SmartCabin 0013 — Read-only functions for the platform and patient-portal workspaces.
-- Additive only. Neither function writes data; both are guarded and return minimal columns.

create function private.require_authenticated()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'UNAUTHENTICATED';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- platform_list_clinics — clinic metadata and counts only; no patient-level data (MD-18)
-- ---------------------------------------------------------------------------
create function public.platform_list_clinics()
returns table (
  clinic_id        uuid,
  slug             text,
  display_name     text,
  city             text,
  status           public.clinic_status,
  created_at       timestamptz,
  approved_at      timestamptz,
  suspended_reason text,
  active_members   integer,
  active_doctors   integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return query
  select c.id, c.slug::text, c.display_name, c.city, c.status, c.created_at, c.approved_at, c.suspended_reason,
         (select count(*)::integer from public.clinic_members m where m.clinic_id = c.id and m.status = 'active'),
         (select count(*)::integer from public.doctors d where d.clinic_id = c.id and d.status = 'active')
  from public.clinics c
  order by (c.status = 'pending_approval') desc, c.created_at desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- portal_list_my_appointments — appointments of the patient records explicitly linked to the
-- caller's portal account (BR-D-02). Recent past (30 days) and upcoming only.
-- ---------------------------------------------------------------------------
create function public.portal_list_my_appointments()
returns table (
  appointment_id   uuid,
  clinic_name      text,
  clinic_timezone  text,
  patient_first_name text,
  relationship     public.patient_relationship,
  doctor_name      text,
  service_name_fr  text,
  service_name_ar  text,
  starts_at        timestamptz,
  ends_at          timestamptz,
  status           public.appointment_status)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_authenticated();
  return query
  select a.id, c.display_name, c.timezone, p.first_name, pa.relationship, d.full_name, s.name_fr, s.name_ar,
         a.starts_at, a.ends_at, a.status
  from public.patient_accounts pa
  join public.patients p     on p.clinic_id = pa.clinic_id and p.id = pa.patient_id
  join public.clinics c      on c.id = pa.clinic_id
  join public.appointments a on a.clinic_id = pa.clinic_id and a.patient_id = pa.patient_id
  join public.doctors d      on d.clinic_id = a.clinic_id and d.id = a.doctor_id
  join public.services s     on s.clinic_id = a.clinic_id and s.id = a.service_id
  where pa.user_id = (select auth.uid())
    and pa.revoked_at is null
    and c.status in ('active', 'suspended')
    and a.starts_at >= now() - interval '30 days'
  order by a.starts_at;
end;
$$;

revoke all on function public.platform_list_clinics() from public, anon;
revoke all on function public.portal_list_my_appointments() from public, anon;
grant execute on function public.platform_list_clinics() to authenticated;
grant execute on function public.portal_list_my_appointments() to authenticated;
