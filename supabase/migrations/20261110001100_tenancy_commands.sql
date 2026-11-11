-- SmartCabin 0011 — Tenancy and membership commands (BC1, BC2).
-- Every function: SECURITY DEFINER, empty search_path, explicit authorization first,
-- tenant derived server-side, EXECUTE granted to `authenticated` only.

-- ---------------------------------------------------------------------------
-- create_clinic — onboarding step: clinic (pending_approval) + settings + owner membership
-- ---------------------------------------------------------------------------
create function public.create_clinic(
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
  -- Abuse guard: a user cannot pile up clinics waiting for approval.
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

-- ---------------------------------------------------------------------------
-- get_my_memberships — clinic switcher and MFA prompt (works before MFA, own rows only)
-- ---------------------------------------------------------------------------
create function public.get_my_memberships()
returns table (
  clinic_id       uuid,
  slug            text,
  display_name    text,
  clinic_status   public.clinic_status,
  role            public.clinic_role,
  is_practitioner boolean,
  requires_mfa    boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.slug::text, c.display_name, c.status, m.role,
         exists (select 1 from public.doctors d where d.clinic_id = c.id and d.user_id = m.user_id),
         private.role_requires_mfa(m.role)
  from public.clinic_members m
  join public.clinics c on c.id = m.clinic_id
  where m.user_id = (select auth.uid()) and m.status = 'active' and c.status <> 'closed'
  order by c.display_name;
$$;

-- ---------------------------------------------------------------------------
-- invite_member — returns the plain token ONCE; only its SHA-256 is stored.
-- The caller (server action) emails it; resending = inviting again (rotates the token).
-- ---------------------------------------------------------------------------
create function public.invite_member(p_clinic_id uuid, p_email text, p_role public.clinic_role)
returns table (invitation_id uuid, invitation_token text, invitation_expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email   text := lower(btrim(p_email));
  v_token   text;
  v_id      uuid;
  v_expires timestamptz;
begin
  perform private.require_clinic_access(p_clinic_id);
  perform private.require_permission(p_clinic_id, 'members.invite');
  if private.member_role(p_clinic_id) = 'clinic_admin' and p_role in ('clinic_owner', 'clinic_admin') then
    raise exception using errcode = '42501', message = 'FORBIDDEN', detail = 'admins cannot invite owners or admins';
  end if;
  if exists (
      select 1 from public.clinic_members m
      join auth.users u on u.id = m.user_id
      where m.clinic_id = p_clinic_id and m.status = 'active' and lower(u.email) = v_email) then
    raise exception using errcode = 'P0001', message = 'ALREADY_MEMBER';
  end if;

  update public.clinic_invitations i
     set revoked_at = now()
   where i.clinic_id = p_clinic_id and i.email = v_email::extensions.citext
     and i.accepted_at is null and i.revoked_at is null;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.clinic_invitations (clinic_id, email, role, token_hash, invited_by)
  values (p_clinic_id, v_email, p_role, encode(extensions.digest(v_token, 'sha256'), 'hex'), auth.uid())
  returning id, expires_at into v_id, v_expires;

  perform private.emit_event(p_clinic_id, 'clinic_invitation', v_id, 'member.invited');
  return query select v_id, v_token, v_expires;
end;
$$;

-- ---------------------------------------------------------------------------
-- accept_invitation — the signed-in user's confirmed email must match the invitation
-- ---------------------------------------------------------------------------
create function public.accept_invitation(p_token text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_inv   public.clinic_invitations;
  v_email text;
  v_rows  integer;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'UNAUTHENTICATED';
  end if;

  select * into v_inv
  from public.clinic_invitations i
  where i.token_hash = encode(extensions.digest(btrim(coalesce(p_token, '')), 'sha256'), 'hex')
  for update;
  -- One error for unknown, used, revoked and expired tokens (no oracle).
  if not found or v_inv.accepted_at is not null or v_inv.revoked_at is not null or v_inv.expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'INVITATION_INVALID';
  end if;

  select lower(u.email) into v_email from auth.users u where u.id = v_uid and u.email_confirmed_at is not null;
  if v_email is null or v_email <> lower(v_inv.email::text) then
    raise exception using errcode = 'P0001', message = 'INVITATION_EMAIL_MISMATCH';
  end if;

  perform 1 from public.clinics c where c.id = v_inv.clinic_id and c.status in ('pending_approval', 'active') for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'INVITATION_INVALID';
  end if;

  insert into public.clinic_members as m (clinic_id, user_id, role, status, invited_by)
  values (v_inv.clinic_id, v_uid, v_inv.role, 'active', v_inv.invited_by)
  on conflict (clinic_id, user_id) do update
    set role = excluded.role, status = 'active', status_changed_at = now(), invited_by = excluded.invited_by
    where m.status <> 'active';
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception using errcode = 'P0001', message = 'ALREADY_MEMBER';
  end if;

  update public.clinic_invitations set accepted_at = now(), accepted_by = v_uid where id = v_inv.id;
  return v_inv.clinic_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- revoke_invitation
-- ---------------------------------------------------------------------------
create function public.revoke_invitation(p_invitation_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inv public.clinic_invitations;
begin
  select * into v_inv from public.clinic_invitations where id = p_invitation_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.require_clinic_access(v_inv.clinic_id);
  perform private.require_permission(v_inv.clinic_id, 'members.invite');
  if v_inv.accepted_at is not null or v_inv.revoked_at is not null then
    raise exception using errcode = 'P0001', message = 'INVITATION_INVALID';
  end if;
  if private.member_role(v_inv.clinic_id) = 'clinic_admin' and v_inv.role in ('clinic_owner', 'clinic_admin') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  update public.clinic_invitations set revoked_at = now() where id = p_invitation_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Member changes: the clinic row is locked first so concurrent demotions are serialized
-- (the deferred last-owner check then sees committed state).
-- ---------------------------------------------------------------------------
create function private.lock_member_for_change(p_member_id uuid, p_permission text)
returns public.clinic_members
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid;
  v_member    public.clinic_members;
begin
  select m.clinic_id into v_clinic_id from public.clinic_members m where m.id = p_member_id;
  if v_clinic_id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.require_clinic_access(v_clinic_id);
  perform 1 from public.clinics c where c.id = v_clinic_id for update;
  select * into v_member from public.clinic_members m where m.id = p_member_id for update;
  perform private.require_permission(v_clinic_id, p_permission);
  if v_member.user_id = auth.uid() then
    raise exception using errcode = '42501', message = 'FORBIDDEN', detail = 'members cannot change their own role or status';
  end if;
  return v_member;
end;
$$;

create function public.change_member_role(p_member_id uuid, p_role public.clinic_role)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_member public.clinic_members := private.lock_member_for_change(p_member_id, 'members.change_role');
begin
  if private.member_role(v_member.clinic_id) = 'clinic_admin'
     and (v_member.role in ('clinic_owner', 'clinic_admin') or p_role in ('clinic_owner', 'clinic_admin')) then
    raise exception using errcode = '42501', message = 'FORBIDDEN', detail = 'admins manage non-admin roles only';
  end if;
  if v_member.status <> 'active' then
    raise exception using errcode = 'P0001', message = 'MEMBER_NOT_ACTIVE';
  end if;
  update public.clinic_members set role = p_role where id = p_member_id and role <> p_role;
end;
$$;

create function public.set_member_status(p_member_id uuid, p_status public.member_status)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_member public.clinic_members := private.lock_member_for_change(p_member_id, 'members.suspend');
begin
  if private.member_role(v_member.clinic_id) = 'clinic_admin' and v_member.role in ('clinic_owner', 'clinic_admin') then
    raise exception using errcode = '42501', message = 'FORBIDDEN', detail = 'admins manage non-admin members only';
  end if;
  if v_member.status = 'removed' then
    raise exception using errcode = 'P0001', message = 'MEMBER_REMOVED', detail = 'a removed member returns only through a new invitation';
  end if;
  if v_member.status = p_status then
    return;
  end if;
  update public.clinic_members set status = p_status, status_changed_at = now() where id = p_member_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- platform_set_clinic_status — platform path only (aal2 platform admin)
-- ---------------------------------------------------------------------------
create function public.platform_set_clinic_status(p_clinic_id uuid, p_status public.clinic_status, p_reason text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old public.clinic_status;
begin
  perform private.require_platform_admin();
  perform set_config('smartcabin.actor_type', 'platform_admin', true);

  select c.status into v_old from public.clinics c where c.id = p_clinic_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if not ((v_old, p_status) in (
      ('pending_approval'::public.clinic_status, 'active'::public.clinic_status),
      ('pending_approval', 'closed'), ('active', 'suspended'), ('suspended', 'active'),
      ('active', 'closed'), ('suspended', 'closed'))) then
    raise exception using errcode = 'P0001', message = 'CLINIC_INVALID_TRANSITION',
      detail = format('%s -> %s is not allowed', v_old, p_status);
  end if;
  if p_status = 'suspended' and coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'a suspension needs a reason';
  end if;

  if p_status in ('suspended', 'closed') then
    update public.clinic_settings set online_booking_enabled = false where clinic_id = p_clinic_id and online_booking_enabled;
  end if;
  update public.clinics c
     set status           = p_status,
         approved_at      = case when p_status = 'active' and c.approved_at is null then now() else c.approved_at end,
         approved_by      = case when p_status = 'active' and c.approved_by is null then auth.uid() else c.approved_by end,
         suspended_reason = case when p_status = 'suspended' then btrim(p_reason) end,
         closed_at        = case when p_status = 'closed' then now() end
   where c.id = p_clinic_id;

  perform private.emit_event(p_clinic_id, 'clinic', p_clinic_id,
    case
      when v_old = 'pending_approval' and p_status = 'active' then 'clinic.approved'
      when v_old = 'pending_approval' and p_status = 'closed' then 'clinic.rejected'
      when p_status = 'suspended' then 'clinic.suspended'
      when p_status = 'active' then 'clinic.reactivated'
      else 'clinic.closed'
    end);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: authenticated only (anon cannot call any of these).
-- ---------------------------------------------------------------------------
revoke all on function public.create_clinic(text, text, text, text, text) from public, anon;
revoke all on function public.get_my_memberships() from public, anon;
revoke all on function public.invite_member(uuid, text, public.clinic_role) from public, anon;
revoke all on function public.accept_invitation(text) from public, anon;
revoke all on function public.revoke_invitation(uuid) from public, anon;
revoke all on function public.change_member_role(uuid, public.clinic_role) from public, anon;
revoke all on function public.set_member_status(uuid, public.member_status) from public, anon;
revoke all on function public.platform_set_clinic_status(uuid, public.clinic_status, text) from public, anon;

grant execute on function public.create_clinic(text, text, text, text, text) to authenticated;
grant execute on function public.get_my_memberships() to authenticated;
grant execute on function public.invite_member(uuid, text, public.clinic_role) to authenticated;
grant execute on function public.accept_invitation(text) to authenticated;
grant execute on function public.revoke_invitation(uuid) to authenticated;
grant execute on function public.change_member_role(uuid, public.clinic_role) to authenticated;
grant execute on function public.set_member_status(uuid, public.member_status) to authenticated;
grant execute on function public.platform_set_clinic_status(uuid, public.clinic_status, text) to authenticated;
