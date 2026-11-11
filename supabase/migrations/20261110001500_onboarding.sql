-- SmartClinic 0015 — Module 1: clinic onboarding.
-- 1. create_clinic now requires the current terms of service and privacy policy to have been
--    accepted by the caller (MD-20; enforced in the database, not only in the form).
-- 2. is_slug_available: availability check for the onboarding form (slugs are public URLs).
-- Forward-only: create or replace keeps the 0011 signature and grants.

create or replace function public.create_clinic(
  p_display_name   text,
  p_slug           text,
  p_city           text,
  p_phone_e164     text default null,
  p_default_locale text default 'fr')
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_clinic_id uuid;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'UNAUTHENTICATED';
  end if;
  if not exists (select 1 from auth.users u where u.id = v_uid and u.email_confirmed_at is not null) then
    raise exception using errcode = '42501', message = 'EMAIL_NOT_CONFIRMED';
  end if;
  -- Terms of service and privacy policy: the caller accepted a currently published version
  -- (any language) of each. Without published documents, onboarding is closed.
  if exists (
      select 1 from (values ('terms_of_service'::public.legal_kind), ('privacy_policy'::public.legal_kind)) as k(kind)
      where not exists (
        select 1 from public.legal_acceptances la
        join public.legal_documents d on d.id = la.document_id
        where la.user_id = v_uid and d.kind = k.kind and d.is_current)) then
    raise exception using errcode = 'P0001', message = 'LEGAL_ACCEPTANCE_REQUIRED';
  end if;
  if (select count(*) from public.clinics c where c.created_by = v_uid and c.status = 'pending_approval') >= 3 then
    raise exception using errcode = 'P0001', message = 'CLINIC_CREATION_LIMIT';
  end if;

  begin
    insert into public.clinics (slug, display_name, city, phone_e164, default_locale, created_by)
    values (lower(btrim(p_slug)), btrim(p_display_name), btrim(p_city), nullif(btrim(p_phone_e164), ''),
            coalesce(p_default_locale, 'fr'), v_uid)
    returning id into v_clinic_id;
  exception when unique_violation then
    raise exception using errcode = 'P0001', message = 'SLUG_TAKEN';
  end;

  insert into public.clinic_settings (clinic_id) values (v_clinic_id);
  insert into public.clinic_members (clinic_id, user_id, role, status)
  values (v_clinic_id, v_uid, 'clinic_owner', 'active');
  perform private.emit_event(v_clinic_id, 'clinic', v_clinic_id, 'clinic.submitted');
  return v_clinic_id;
end;
$$;

-- Slugs are public booking URLs; checking availability reveals nothing confidential.
create function public.is_slug_available(p_slug text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_authenticated();
  return lower(btrim(p_slug)) ~ '^[a-z0-9](-?[a-z0-9]){2,40}$'
     and lower(btrim(p_slug)) not in ('admin', 'api', 'app', 'auth', 'platform', 'www', 'static', 'assets',
                                      'login', 'register', 'book', 'me', 'w', 'c')
     and not exists (select 1 from public.clinics c where c.slug = lower(btrim(p_slug))::extensions.citext);
end;
$$;

revoke all on function public.is_slug_available(text) from public, anon;
grant execute on function public.is_slug_available(text) to authenticated;
