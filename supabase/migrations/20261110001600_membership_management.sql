-- SmartCabin 0016 — Module 2: clinic and membership management (read functions).
-- user_profiles and auth.users are visible to their owner only, so listing colleagues needs a
-- guarded function that returns names and emails of one clinic's members to members.view.

create function public.list_clinic_members(p_clinic_id uuid)
returns table (
  member_id       uuid,
  user_id         uuid,
  full_name       text,
  email           text,
  role            public.clinic_role,
  status          public.member_status,
  joined_at       timestamptz,
  is_practitioner boolean,
  is_self         boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_clinic_access(p_clinic_id);
  perform private.require_permission(p_clinic_id, 'members.view');
  return query
  select m.id, m.user_id, coalesce(nullif(p.full_name, ''), split_part(u.email, '@', 1))::text, u.email::text,
         m.role, m.status, m.joined_at,
         exists (select 1 from public.doctors d where d.clinic_id = m.clinic_id and d.user_id = m.user_id),
         m.user_id = (select auth.uid())
  from public.clinic_members m
  join auth.users u on u.id = m.user_id
  left join public.user_profiles p on p.id = m.user_id
  where m.clinic_id = p_clinic_id
  order by (m.status = 'active') desc, m.role, 3;
end;
$$;

-- Whether the current clinic data processing agreement has been accepted for this clinic
-- (by any owner). Visible to every member who can see the clinic profile.
create function public.get_clinic_dpa_status(p_clinic_id uuid)
returns table (document_version text, accepted_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_clinic_access(p_clinic_id);
  perform private.require_permission(p_clinic_id, 'clinic.profile.view');
  return query
  select d.version, max(la.accepted_at)
  from public.legal_documents d
  left join public.legal_acceptances la on la.document_id = d.id and la.clinic_id = p_clinic_id
  where d.kind = 'clinic_dpa' and d.is_current
  group by d.version
  order by 2 desc nulls last
  limit 1;
end;
$$;

revoke all on function public.list_clinic_members(uuid) from public, anon;
revoke all on function public.get_clinic_dpa_status(uuid) from public, anon;
grant execute on function public.list_clinic_members(uuid) to authenticated;
grant execute on function public.get_clinic_dpa_status(uuid) to authenticated;
