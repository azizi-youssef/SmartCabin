-- SmartClinic 0008 — RBAC seed and authorization helpers.
-- The permission matrix mirrors docs/RBAC_PERMISSION_MATRIX.md §3 (clinic roles only;
-- platform operations use platform_admins, MD-18). Changing it requires a migration.

-- ---------------------------------------------------------------------------
-- Permission catalog
-- ---------------------------------------------------------------------------
insert into public.permissions (key, context, access, description) values
  ('clinic.profile.view',          'tenancy',      'read',  'View the clinic profile and settings'),
  ('clinic.profile.update',        'tenancy',      'write', 'Edit name, contact details, logo, ICE'),
  ('clinic.settings.update',       'tenancy',      'write', 'Edit booking, reminder and queue policy'),
  ('clinic.closures.manage',       'tenancy',      'write', 'Add or remove clinic closures'),
  ('clinic.close',                 'tenancy',      'write', 'Request closure of the clinic'),
  ('members.view',                 'identity',     'read',  'List members and invitations'),
  ('members.invite',               'identity',     'write', 'Invite staff (admins: non-admin roles only)'),
  ('members.change_role',          'identity',     'write', 'Change a member role (admins: non-admin roles only)'),
  ('members.suspend',              'identity',     'write', 'Suspend, reactivate or remove members'),
  ('ownership.transfer',           'identity',     'write', 'Transfer clinic ownership'),
  ('subscription.view',            'subscriptions','read',  'View the clinic subscription'),
  ('subscription.request_change',  'subscriptions','write', 'Request a plan change'),
  ('audit.view',                   'compliance',   'read',  'Read the clinic audit log'),
  ('legal.accept_clinic_dpa',      'compliance',   'write', 'Accept the data processing agreement for the clinic'),
  ('services.view',                'catalog',      'read',  'View services'),
  ('services.manage',              'catalog',      'write', 'Create and edit services and prices'),
  ('doctors.view',                 'catalog',      'read',  'View doctors and the services they offer'),
  ('doctors.manage',               'catalog',      'write', 'Create and edit doctors and their services'),
  ('schedules.view',               'scheduling',   'read',  'View schedules, time off and closures'),
  ('schedules.manage',             'scheduling',   'write', 'Edit schedules (doctors: own only)'),
  ('time_off.manage',              'scheduling',   'write', 'Edit time off (doctors: own only)'),
  ('slots.view',                   'scheduling',   'read',  'Compute available slots'),
  ('patients.view',                'patients',     'read',  'View patients (doctors: own patients only)'),
  ('patients.create',              'patients',     'write', 'Register patients'),
  ('patients.update',              'patients',     'write', 'Edit patient administrative data'),
  ('patients.merge',               'patients',     'write', 'Merge duplicate patient records'),
  ('patients.archive',             'patients',     'write', 'Archive patient records'),
  ('patients.link_account',        'patients',     'write', 'Link a portal account to a patient record'),
  ('patients.export',              'patients',     'read',  'Export a patient file (data-subject access)'),
  ('consents.record',              'patients',     'write', 'Record consents'),
  ('dsr.manage',                   'compliance',   'write', 'Handle data-subject requests'),
  ('appointments.view',            'appointments', 'read',  'View appointments (doctors: own only)'),
  ('appointments.view_reason',     'appointments', 'read',  'View the patient-provided visit reason'),
  ('appointments.book',            'appointments', 'write', 'Book appointments (doctors: own agenda)'),
  ('appointments.confirm',         'appointments', 'write', 'Confirm pending appointments'),
  ('appointments.reschedule',      'appointments', 'write', 'Reschedule appointments'),
  ('appointments.cancel',          'appointments', 'write', 'Cancel appointments'),
  ('appointments.overbook',        'appointments', 'write', 'Book over an occupied slot, with a reason'),
  ('appointments.mark_no_show',    'appointments', 'write', 'Mark an appointment as no-show'),
  ('appointments.correct_status',  'appointments', 'write', 'Apply audited status corrections'),
  ('queue.view',                   'patient_flow', 'read',  'View queues (doctors: own queue)'),
  ('queue.check_in',               'patient_flow', 'write', 'Check patients in, register walk-ins'),
  ('queue.call',                   'patient_flow', 'write', 'Call or recall patients'),
  ('queue.start',                  'patient_flow', 'write', 'Start a consultation'),
  ('queue.complete',               'patient_flow', 'write', 'Complete a consultation'),
  ('queue.prioritize',             'patient_flow', 'write', 'Set a human priority with a reason'),
  ('queue.reorder',                'patient_flow', 'write', 'Reorder the queue with a reason'),
  ('queue.mark_left',              'patient_flow', 'write', 'Close an entry as left before consultation'),
  ('queue.manage_session',         'patient_flow', 'write', 'Open, pause, close sessions, report delays'),
  ('queue.displays.manage',        'patient_flow', 'write', 'Manage waiting-room display tokens'),
  ('notifications.view_log',       'communications','read', 'View notification delivery status'),
  ('notifications.resend',         'communications','write','Resend a notification'),
  ('templates.manage',             'communications','write','Manage clinic message templates'),
  ('invoices.view',                'billing',      'read',  'View invoices and receipts'),
  ('invoices.create',              'billing',      'write', 'Create draft invoices'),
  ('invoices.issue',               'billing',      'write', 'Issue invoices'),
  ('invoices.void',                'billing',      'write', 'Void invoices without payments'),
  ('payments.record',              'billing',      'write', 'Record payments'),
  ('payments.reverse',             'billing',      'write', 'Reverse payments with a reason'),
  ('billing.reports',              'billing',      'read',  'Revenue reports'),
  ('analytics.operational',        'analytics',    'read',  'Operational KPIs (doctors: own)'),
  ('analytics.financial',          'analytics',    'read',  'Financial KPIs');

-- ---------------------------------------------------------------------------
-- Role grants (O = owner, A = admin, D = doctor, R = receptionist, C = accountant)
-- ---------------------------------------------------------------------------
insert into public.role_permissions (role, permission_key)
select r.role::public.clinic_role, g.key
from (values
  ('clinic.profile.view',         'OADRC'),
  ('clinic.profile.update',       'OA'),
  ('clinic.settings.update',      'OA'),
  ('clinic.closures.manage',      'OAR'),
  ('clinic.close',                'O'),
  ('members.view',                'OA'),
  ('members.invite',              'OA'),
  ('members.change_role',         'OA'),
  ('members.suspend',             'OA'),
  ('ownership.transfer',          'O'),
  ('subscription.view',           'OAC'),
  ('subscription.request_change', 'O'),
  ('audit.view',                  'OA'),
  ('legal.accept_clinic_dpa',     'O'),
  ('services.view',               'OADRC'),
  ('services.manage',             'OA'),
  ('doctors.view',                'OADRC'),
  ('doctors.manage',              'OA'),
  ('schedules.view',              'OADR'),
  ('schedules.manage',            'OAD'),
  ('time_off.manage',             'OADR'),
  ('slots.view',                  'OADR'),
  ('patients.view',               'OADR'),
  ('patients.create',             'OAR'),
  ('patients.update',             'OAR'),
  ('patients.merge',              'OA'),
  ('patients.archive',            'OA'),
  ('patients.link_account',       'OAR'),
  ('patients.export',             'OA'),
  ('consents.record',             'OAR'),
  ('dsr.manage',                  'OA'),
  ('appointments.view',           'OADR'),
  ('appointments.view_reason',    'OADR'),
  ('appointments.book',           'OADR'),
  ('appointments.confirm',        'OADR'),
  ('appointments.reschedule',     'OADR'),
  ('appointments.cancel',         'OADR'),
  ('appointments.overbook',       'OADR'),
  ('appointments.mark_no_show',   'OADR'),
  ('appointments.correct_status', 'OA'),
  ('queue.view',                  'OADR'),
  ('queue.check_in',              'OAR'),
  ('queue.call',                  'OADR'),
  ('queue.start',                 'OADR'),
  ('queue.complete',              'OADR'),
  ('queue.prioritize',            'OADR'),
  ('queue.reorder',               'OADR'),
  ('queue.mark_left',             'OAR'),
  ('queue.manage_session',        'OADR'),
  ('queue.displays.manage',       'OA'),
  ('notifications.view_log',      'OAR'),
  ('notifications.resend',        'OAR'),
  ('templates.manage',            'OA'),
  ('invoices.view',               'OARC'),
  ('invoices.create',             'OARC'),
  ('invoices.issue',              'OARC'),
  ('invoices.void',               'OAC'),
  ('payments.record',             'OARC'),
  ('payments.reverse',            'OAC'),
  ('billing.reports',             'OAC'),
  ('analytics.operational',       'OAD'),
  ('analytics.financial',         'OAC')
) as g(key, roles)
cross join lateral (
  select case letter
           when 'O' then 'clinic_owner'
           when 'A' then 'clinic_admin'
           when 'D' then 'doctor'
           when 'R' then 'receptionist'
           when 'C' then 'accountant'
         end as role
  from regexp_split_to_table(g.roles, '') as letter
) as r;

-- ---------------------------------------------------------------------------
-- Helpers. All are SECURITY DEFINER with an empty search_path, live in `private`
-- (not exposed), and depend only on auth.uid() / auth.jwt() of the caller.
-- Set-returning helpers are used in RLS as uncorrelated sub-selects, so PostgreSQL
-- evaluates them once per statement instead of once per row.
-- ---------------------------------------------------------------------------

-- Session assurance level from the verified JWT ('aal1' when absent).
create function private.session_aal()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce((select auth.jwt()) ->> 'aal', 'aal1');
$$;

-- Roles that must use an MFA (aal2) session for every clinic operation (MD-23).
create function private.role_requires_mfa(p_role public.clinic_role)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_role in ('clinic_owner', 'clinic_admin', 'accountant');
$$;

-- Clinics where the caller currently holds a permission (membership active, clinic usable,
-- MFA satisfied; suspended clinics keep read permissions only).
create function private.clinics_with_permission(p_permission text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.clinic_id
  from public.clinic_members m
  join public.clinics c           on c.id = m.clinic_id
  join public.role_permissions rp on rp.role = m.role and rp.permission_key = p_permission
  join public.permissions p       on p.key = rp.permission_key
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and (c.status in ('active', 'pending_approval') or (c.status = 'suspended' and p.access = 'read'))
    and (not private.role_requires_mfa(m.role) or private.session_aal() = 'aal2');
$$;

-- Clinics where the caller's role is the practitioner-only DOCTOR role (data limited to own doctor).
create function private.practitioner_only_clinics()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.clinic_id
  from public.clinic_members m
  where m.user_id = (select auth.uid()) and m.status = 'active' and m.role = 'doctor';
$$;

-- Doctor records linked to the caller through an active membership (practitioner scope).
create function private.my_doctor_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.id
  from public.doctors d
  join public.clinic_members m on m.clinic_id = d.clinic_id and m.user_id = d.user_id
  where d.user_id = (select auth.uid()) and m.status = 'active';
$$;

-- Patients who have (or had) an appointment with one of the caller's doctor records (Q7).
create function private.my_doctor_patient_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct a.patient_id
  from public.appointments a
  where a.doctor_id in (select private.my_doctor_ids());
$$;

create function private.has_permission(p_clinic_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.clinics_with_permission(p_permission) as x(clinic_id) where x.clinic_id = p_clinic_id);
$$;

create function private.member_role(p_clinic_id uuid)
returns public.clinic_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role from public.clinic_members m
  where m.clinic_id = p_clinic_id and m.user_id = (select auth.uid()) and m.status = 'active';
$$;

create function private.is_practitioner_only(p_clinic_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.member_role(p_clinic_id) = 'doctor', false);
$$;

-- Row-targeted commands call this first: a caller with no active membership in the clinic
-- gets NOT_FOUND, never FORBIDDEN, so another tenant's ids reveal nothing.
create function private.require_clinic_access(p_clinic_id uuid)
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
  if private.member_role(p_clinic_id) is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
end;
$$;

-- First statement of every command function (RBAC_PERMISSION_MATRIX §6).
create function private.require_permission(p_clinic_id uuid, p_permission text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role public.clinic_role;
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'UNAUTHENTICATED';
  end if;
  if private.has_permission(p_clinic_id, p_permission) then
    return;
  end if;
  v_role := private.member_role(p_clinic_id);
  if v_role is not null and private.role_requires_mfa(v_role) and private.session_aal() <> 'aal2'
     and exists (select 1 from public.role_permissions rp where rp.role = v_role and rp.permission_key = p_permission) then
    raise exception using errcode = '42501', message = 'MFA_REQUIRED';
  end if;
  raise exception using errcode = '42501', message = 'FORBIDDEN', detail = p_permission;
end;
$$;

-- Practitioner-only members may act on their own doctor records only. Others' records are
-- invisible to them under RLS, so the error is NOT_FOUND.
create function private.require_doctor_scope(p_clinic_id uuid, p_doctor_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.is_practitioner_only(p_clinic_id)
     and p_doctor_id not in (select private.my_doctor_ids()) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
end;
$$;

create function private.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins pa
    where pa.user_id = (select auth.uid()) and pa.revoked_at is null)
  and private.session_aal() = 'aal2';
$$;

create function private.require_platform_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin() then
    raise exception using errcode = '42501', message = 'FORBIDDEN', detail = 'platform admin with aal2 required';
  end if;
end;
$$;

-- Helpers called from RLS policies run with the caller's privileges: grant only those.
grant execute on function private.clinics_with_permission(text) to authenticated;
grant execute on function private.practitioner_only_clinics() to authenticated;
grant execute on function private.my_doctor_ids() to authenticated;
grant execute on function private.my_doctor_patient_ids() to authenticated;
grant execute on function private.session_aal() to authenticated;
grant execute on function private.role_requires_mfa(public.clinic_role) to authenticated;
