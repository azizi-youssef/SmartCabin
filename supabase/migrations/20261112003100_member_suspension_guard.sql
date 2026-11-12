-- =============================================================================
-- 0031 member suspension guard (audit SC-AUD-03, MEDIUM).
-- An admin could lift an owner-decided suspension of an admin by inviting the same e-mail with
-- another role: accept_invitation reactivated any non-active membership. Now:
-- - invite_member refuses the e-mail of a suspended member (MEMBER_SUSPENDED);
-- - accept_invitation reactivates removed memberships only, and refuses suspended ones.
-- Lifting a suspension stays with set_member_status. Forward-only: both functions are replaced
-- with migration 0011's bodies, changed only where marked SC-AUD-03; signatures and grants kept.
-- =============================================================================

create or replace function public.invite_member(p_clinic_id uuid, p_email text, p_role public.clinic_role)
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
  -- SC-AUD-03: a suspension is lifted only through set_member_status (with its role rules),
  -- never by inviting the same person again.
  if exists (
      select 1 from public.clinic_members m
      join auth.users u on u.id = m.user_id
      where m.clinic_id = p_clinic_id and m.status = 'suspended' and lower(u.email) = v_email) then
    raise exception using errcode = 'P0001', message = 'MEMBER_SUSPENDED';
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

create or replace function public.accept_invitation(p_token text)
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
    -- SC-AUD-03: only a removed member comes back by invitation; a suspended one does not
    -- (suspensions decided after the invitation was sent included).
    where m.status = 'removed';
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    if exists (select 1 from public.clinic_members m
               where m.clinic_id = v_inv.clinic_id and m.user_id = v_uid and m.status = 'suspended') then
      raise exception using errcode = 'P0001', message = 'MEMBER_SUSPENDED';
    end if;
    raise exception using errcode = 'P0001', message = 'ALREADY_MEMBER';
  end if;

  update public.clinic_invitations set accepted_at = now(), accepted_by = v_uid where id = v_inv.id;
  return v_inv.clinic_id;
end;
$$;
