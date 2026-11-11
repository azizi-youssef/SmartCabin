-- SmartCabin 0009 — Grants and Row-Level Security.
-- Grants decide WHICH operations an API role can attempt (and on which columns);
-- RLS decides on WHICH rows. Every table starts from zero privileges for anon/authenticated.
-- Command tables get SELECT only: their writes go through SECURITY DEFINER commands (MD-04).

-- ---------------------------------------------------------------------------
-- Start from zero on every table created so far.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all tables in schema private from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

alter table public.clinics                        enable row level security;
alter table public.clinic_settings                enable row level security;
alter table public.user_profiles                  enable row level security;
alter table public.platform_admins                enable row level security;
alter table public.permissions                    enable row level security;
alter table public.role_permissions               enable row level security;
alter table public.clinic_members                 enable row level security;
alter table public.clinic_invitations             enable row level security;
alter table public.clinic_closures                enable row level security;
alter table public.specialties                    enable row level security;
alter table public.services                       enable row level security;
alter table public.doctors                        enable row level security;
alter table public.doctor_services                enable row level security;
alter table public.doctor_schedules               enable row level security;
alter table public.doctor_availability            enable row level security;
alter table public.doctor_time_off                enable row level security;
alter table public.patients                       enable row level security;
alter table public.patient_accounts               enable row level security;
alter table public.patient_consents               enable row level security;
alter table public.appointment_status_transitions enable row level security;
alter table public.appointments                   enable row level security;
alter table public.appointment_history            enable row level security;
alter table public.audit_logs                     enable row level security;
alter table public.legal_documents                enable row level security;
alter table public.legal_acceptances              enable row level security;
alter table public.domain_events                  enable row level security;  -- no policy: API roles see nothing
alter table private.clinic_counters               enable row level security;  -- no policy, no grant

-- ===========================================================================
-- Reference data readable by everyone
-- ===========================================================================
grant select on public.specialties to anon, authenticated;
create policy specialties_select on public.specialties
  for select to anon, authenticated using (true);

grant select on public.legal_documents to anon, authenticated;
create policy legal_documents_select on public.legal_documents
  for select to anon, authenticated using (true);

grant select on public.permissions, public.role_permissions, public.appointment_status_transitions to authenticated;
create policy permissions_select on public.permissions for select to authenticated using (true);
create policy role_permissions_select on public.role_permissions for select to authenticated using (true);
create policy appointment_status_transitions_select on public.appointment_status_transitions
  for select to authenticated using (true);

-- ===========================================================================
-- Tenancy
-- ===========================================================================
-- clinics: members read; owner/admin edit profile columns only (status is platform-only).
grant select on public.clinics to authenticated;
grant update (display_name, legal_name, city, address_line, phone_e164, email, default_locale, ice, logo_path)
  on public.clinics to authenticated;
create policy clinics_select on public.clinics for select to authenticated
  using (id in (select private.clinics_with_permission('clinic.profile.view')));
create policy clinics_update on public.clinics for update to authenticated
  using (id in (select private.clinics_with_permission('clinic.profile.update')))
  with check (id in (select private.clinics_with_permission('clinic.profile.update')));

-- clinic_settings
grant select on public.clinic_settings to authenticated;
grant update (online_booking_enabled, auto_confirm_online, min_lead_minutes, max_horizon_days,
              patient_cancel_cutoff_hours, max_active_online_bookings, reminder_offsets_minutes,
              checkin_grace_minutes, turn_approaching_positions, sms_sender_name)
  on public.clinic_settings to authenticated;
create policy clinic_settings_select on public.clinic_settings for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('clinic.profile.view')));
create policy clinic_settings_update on public.clinic_settings for update to authenticated
  using (clinic_id in (select private.clinics_with_permission('clinic.settings.update')))
  with check (clinic_id in (select private.clinics_with_permission('clinic.settings.update')));

-- Records who changed the settings (server-controlled, not a granted column).
create function private.clinic_settings_stamp_user()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;
create trigger clinic_settings_stamp_user
  before update on public.clinic_settings
  for each row execute function private.clinic_settings_stamp_user();

-- clinic_closures (managed)
grant select on public.clinic_closures to authenticated;
grant insert (clinic_id, dates, reason) on public.clinic_closures to authenticated;
grant update (dates, reason) on public.clinic_closures to authenticated;
grant delete on public.clinic_closures to authenticated;
create policy clinic_closures_select on public.clinic_closures for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('schedules.view')));
create policy clinic_closures_insert on public.clinic_closures for insert to authenticated
  with check (clinic_id in (select private.clinics_with_permission('clinic.closures.manage')));
create policy clinic_closures_update on public.clinic_closures for update to authenticated
  using (clinic_id in (select private.clinics_with_permission('clinic.closures.manage')))
  with check (clinic_id in (select private.clinics_with_permission('clinic.closures.manage')));
create policy clinic_closures_delete on public.clinic_closures for delete to authenticated
  using (clinic_id in (select private.clinics_with_permission('clinic.closures.manage')));

-- ===========================================================================
-- Identity & Access
-- ===========================================================================
-- user_profiles: own row only.
grant select on public.user_profiles to authenticated;
grant update (full_name, phone_e164, locale) on public.user_profiles to authenticated;
create policy user_profiles_select_own on public.user_profiles for select to authenticated
  using (id = (select auth.uid()));
create policy user_profiles_update_own on public.user_profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- platform_admins: a user can see whether they are one; nothing else.
grant select on public.platform_admins to authenticated;
create policy platform_admins_select_own on public.platform_admins for select to authenticated
  using (user_id = (select auth.uid()));

-- clinic_members (command table): own memberships, or all members with members.view.
grant select on public.clinic_members to authenticated;
create policy clinic_members_select on public.clinic_members for select to authenticated
  using (user_id = (select auth.uid())
         or clinic_id in (select private.clinics_with_permission('members.view')));

-- clinic_invitations (command table): token_hash is never readable through the API.
grant select (id, clinic_id, email, role, invited_by, expires_at, accepted_at, accepted_by, revoked_at, created_at)
  on public.clinic_invitations to authenticated;
create policy clinic_invitations_select on public.clinic_invitations for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('members.view')));

-- ===========================================================================
-- Practice Catalog (managed tables)
-- ===========================================================================
grant select on public.services to authenticated;
grant insert (clinic_id, specialty_id, name_fr, name_ar, default_duration_minutes, price_mad, online_bookable, status)
  on public.services to authenticated;
grant update (specialty_id, name_fr, name_ar, default_duration_minutes, price_mad, online_bookable, status)
  on public.services to authenticated;
grant delete on public.services to authenticated;
create policy services_select on public.services for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('services.view')));
create policy services_insert on public.services for insert to authenticated
  with check (clinic_id in (select private.clinics_with_permission('services.manage')));
create policy services_update on public.services for update to authenticated
  using (clinic_id in (select private.clinics_with_permission('services.manage')))
  with check (clinic_id in (select private.clinics_with_permission('services.manage')));
create policy services_delete on public.services for delete to authenticated
  using (clinic_id in (select private.clinics_with_permission('services.manage')));

grant select on public.doctors to authenticated;
grant insert (clinic_id, user_id, full_name, full_name_ar, specialty_id, inpe, phone_e164, online_bookable, status)
  on public.doctors to authenticated;
grant update (user_id, full_name, full_name_ar, specialty_id, inpe, phone_e164, online_bookable, status)
  on public.doctors to authenticated;
grant delete on public.doctors to authenticated;
create policy doctors_select on public.doctors for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('doctors.view')));
create policy doctors_insert on public.doctors for insert to authenticated
  with check (clinic_id in (select private.clinics_with_permission('doctors.manage')));
create policy doctors_update on public.doctors for update to authenticated
  using (clinic_id in (select private.clinics_with_permission('doctors.manage')))
  with check (clinic_id in (select private.clinics_with_permission('doctors.manage')));
create policy doctors_delete on public.doctors for delete to authenticated
  using (clinic_id in (select private.clinics_with_permission('doctors.manage')));

grant select on public.doctor_services to authenticated;
grant insert (clinic_id, doctor_id, service_id, duration_minutes, price_mad, online_bookable, is_active)
  on public.doctor_services to authenticated;
grant update (duration_minutes, price_mad, online_bookable, is_active) on public.doctor_services to authenticated;
grant delete on public.doctor_services to authenticated;
create policy doctor_services_select on public.doctor_services for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('doctors.view')));
create policy doctor_services_insert on public.doctor_services for insert to authenticated
  with check (clinic_id in (select private.clinics_with_permission('doctors.manage')));
create policy doctor_services_update on public.doctor_services for update to authenticated
  using (clinic_id in (select private.clinics_with_permission('doctors.manage')))
  with check (clinic_id in (select private.clinics_with_permission('doctors.manage')));
create policy doctor_services_delete on public.doctor_services for delete to authenticated
  using (clinic_id in (select private.clinics_with_permission('doctors.manage')));

-- ===========================================================================
-- Scheduling (managed tables; doctors limited to their own records — MD-22)
-- ===========================================================================
grant select on public.doctor_schedules to authenticated;
grant insert (clinic_id, doctor_id, name, kind, valid_from, valid_until) on public.doctor_schedules to authenticated;
grant update (name, valid_from, valid_until) on public.doctor_schedules to authenticated;
grant delete on public.doctor_schedules to authenticated;
create policy doctor_schedules_select on public.doctor_schedules for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('schedules.view')));
create policy doctor_schedules_insert on public.doctor_schedules for insert to authenticated
  with check (clinic_id in (select private.clinics_with_permission('schedules.manage'))
              and (clinic_id not in (select private.practitioner_only_clinics())
                   or doctor_id in (select private.my_doctor_ids())));
create policy doctor_schedules_update on public.doctor_schedules for update to authenticated
  using (clinic_id in (select private.clinics_with_permission('schedules.manage'))
         and (clinic_id not in (select private.practitioner_only_clinics())
              or doctor_id in (select private.my_doctor_ids())))
  with check (clinic_id in (select private.clinics_with_permission('schedules.manage'))
              and (clinic_id not in (select private.practitioner_only_clinics())
                   or doctor_id in (select private.my_doctor_ids())));
create policy doctor_schedules_delete on public.doctor_schedules for delete to authenticated
  using (clinic_id in (select private.clinics_with_permission('schedules.manage'))
         and (clinic_id not in (select private.practitioner_only_clinics())
              or doctor_id in (select private.my_doctor_ids())));

grant select on public.doctor_availability to authenticated;
grant insert (clinic_id, schedule_id, doctor_id, weekday, start_time, end_time) on public.doctor_availability to authenticated;
grant update (weekday, start_time, end_time) on public.doctor_availability to authenticated;
grant delete on public.doctor_availability to authenticated;
create policy doctor_availability_select on public.doctor_availability for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('schedules.view')));
create policy doctor_availability_insert on public.doctor_availability for insert to authenticated
  with check (clinic_id in (select private.clinics_with_permission('schedules.manage'))
              and (clinic_id not in (select private.practitioner_only_clinics())
                   or doctor_id in (select private.my_doctor_ids())));
create policy doctor_availability_update on public.doctor_availability for update to authenticated
  using (clinic_id in (select private.clinics_with_permission('schedules.manage'))
         and (clinic_id not in (select private.practitioner_only_clinics())
              or doctor_id in (select private.my_doctor_ids())))
  with check (clinic_id in (select private.clinics_with_permission('schedules.manage'))
              and (clinic_id not in (select private.practitioner_only_clinics())
                   or doctor_id in (select private.my_doctor_ids())));
create policy doctor_availability_delete on public.doctor_availability for delete to authenticated
  using (clinic_id in (select private.clinics_with_permission('schedules.manage'))
         and (clinic_id not in (select private.practitioner_only_clinics())
              or doctor_id in (select private.my_doctor_ids())));

grant select on public.doctor_time_off to authenticated;
grant insert (clinic_id, doctor_id, period, reason_category, note) on public.doctor_time_off to authenticated;
grant update (period, reason_category, note) on public.doctor_time_off to authenticated;
grant delete on public.doctor_time_off to authenticated;
create policy doctor_time_off_select on public.doctor_time_off for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('schedules.view')));
create policy doctor_time_off_insert on public.doctor_time_off for insert to authenticated
  with check (clinic_id in (select private.clinics_with_permission('time_off.manage'))
              and (clinic_id not in (select private.practitioner_only_clinics())
                   or doctor_id in (select private.my_doctor_ids())));
create policy doctor_time_off_update on public.doctor_time_off for update to authenticated
  using (clinic_id in (select private.clinics_with_permission('time_off.manage'))
         and (clinic_id not in (select private.practitioner_only_clinics())
              or doctor_id in (select private.my_doctor_ids())))
  with check (clinic_id in (select private.clinics_with_permission('time_off.manage'))
              and (clinic_id not in (select private.practitioner_only_clinics())
                   or doctor_id in (select private.my_doctor_ids())));
create policy doctor_time_off_delete on public.doctor_time_off for delete to authenticated
  using (clinic_id in (select private.clinics_with_permission('time_off.manage'))
         and (clinic_id not in (select private.practitioner_only_clinics())
              or doctor_id in (select private.my_doctor_ids())));

-- ===========================================================================
-- Patients (doctors see only patients they have appointments with — Q7)
-- ===========================================================================
grant select on public.patients to authenticated;
grant insert (clinic_id, first_name, last_name, first_name_ar, last_name_ar, sex, date_of_birth,
              phone_e164, email, preferred_locale, preferred_channel, created_via)
  on public.patients to authenticated;
grant update (first_name, last_name, first_name_ar, last_name_ar, sex, date_of_birth,
              phone_e164, email, preferred_locale, preferred_channel)
  on public.patients to authenticated;
create policy patients_select on public.patients for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('patients.view'))
         and (clinic_id not in (select private.practitioner_only_clinics())
              or id in (select private.my_doctor_patient_ids())));
create policy patients_insert on public.patients for insert to authenticated
  with check (clinic_id in (select private.clinics_with_permission('patients.create'))
              and created_via in ('reception', 'walk_in', 'import'));
create policy patients_update on public.patients for update to authenticated
  using (clinic_id in (select private.clinics_with_permission('patients.update')))
  with check (clinic_id in (select private.clinics_with_permission('patients.update')));

-- patient_accounts (command table; portal commands arrive with slice S7)
grant select on public.patient_accounts to authenticated;
create policy patient_accounts_select on public.patient_accounts for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('patients.view'))
         and (clinic_id not in (select private.practitioner_only_clinics())
              or patient_id in (select private.my_doctor_patient_ids())));

-- patient_consents (append-only; recorded_by is stamped by trigger)
grant select on public.patient_consents to authenticated;
grant insert (clinic_id, patient_id, purpose, granted, document_version, source) on public.patient_consents to authenticated;
create policy patient_consents_select on public.patient_consents for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('patients.view'))
         and (clinic_id not in (select private.practitioner_only_clinics())
              or patient_id in (select private.my_doctor_patient_ids())));
create policy patient_consents_insert on public.patient_consents for insert to authenticated
  with check (clinic_id in (select private.clinics_with_permission('consents.record')));

-- ===========================================================================
-- Appointments (command tables: SELECT only)
-- ===========================================================================
grant select on public.appointments to authenticated;
create policy appointments_select on public.appointments for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('appointments.view'))
         and (clinic_id not in (select private.practitioner_only_clinics())
              or doctor_id in (select private.my_doctor_ids())));

grant select on public.appointment_history to authenticated;
-- Visibility follows the appointment (the sub-select is itself filtered by appointments_select).
create policy appointment_history_select on public.appointment_history for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('appointments.view'))
         and exists (select 1 from public.appointments a where a.id = appointment_id));

-- ===========================================================================
-- Compliance
-- ===========================================================================
grant select on public.audit_logs to authenticated;
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('audit.view')));

grant select on public.legal_acceptances to authenticated;
grant insert (document_id, clinic_id, context) on public.legal_acceptances to authenticated;
create policy legal_acceptances_select_own on public.legal_acceptances for select to authenticated
  using (user_id = (select auth.uid()));
create policy legal_acceptances_insert_own on public.legal_acceptances for insert to authenticated
  with check (user_id = (select auth.uid())
              and (clinic_id is null
                   or clinic_id in (select private.clinics_with_permission('legal.accept_clinic_dpa'))));
