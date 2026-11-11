-- SmartClinic — LOCAL DEVELOPMENT SEED (applied by `supabase db reset` on the local stack only).
--
-- Every value here is SYNTHETIC:
--   * emails use the reserved `.test` domain (cannot reach a real mailbox);
--   * phone numbers use the unassigned country code +999 (cannot reach a real phone);
--   * names are invented; no real patient data, ever (BR-D-05).
--
-- Development sign-in for every seeded staff account (local only, never reuse elsewhere):
--   password: SmartClinic-dev-2026!
-- Owners, admins and accountants must enroll TOTP before workspace access (aal2, MD-23).
--
-- Accounts:
--   admin@example.test            platform admin
--   dr.amal@example.test          owner of "Cabinet Démo Al Amal" + practising doctor
--   reception.amal@example.test   receptionist, Al Amal
--   compta.amal@example.test      accountant, Al Amal
--   dr.karim@example.test         doctor (practitioner-only role), Al Amal
--   owner.riad@example.test       owner of "Centre Médical Démo Riad" (not a doctor)
--   dr.salma@example.test         doctor, Riad
--   reception.riad@example.test   receptionist, Riad
--   owner.attente@example.test    owner of a clinic still pending approval
--   portal user +99900000101      patient portal account linked to one Al Amal record

-- ---------------------------------------------------------------------------
-- Account helper (pg_temp: disappears at the end of the seed session)
-- ---------------------------------------------------------------------------
create function pg_temp.seed_user(p_id uuid, p_email text, p_phone text, p_full_name text)
returns void
language plpgsql
as $$
declare
  v_password text := extensions.crypt('SmartClinic-dev-2026!', extensions.gen_salt('bf'));
begin
  insert into auth.users (instance_id, id, aud, role, email, phone, encrypted_password,
                          email_confirmed_at, phone_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', p_id, 'authenticated', 'authenticated',
          p_email, p_phone, case when p_email is not null then v_password end,
          case when p_email is not null then now() end,
          case when p_phone is not null then now() end,
          jsonb_build_object('provider', case when p_email is null then 'phone' else 'email' end,
                             'providers', jsonb_build_array(case when p_email is null then 'phone' else 'email' end)),
          jsonb_build_object('full_name', p_full_name, 'locale', 'fr'),
          now(), now());

  -- GoTrue expects empty strings (not NULL) in its token columns.
  if exists (select 1 from information_schema.columns
             where table_schema = 'auth' and table_name = 'users' and column_name = 'confirmation_token') then
    execute 'update auth.users set confirmation_token = '''', recovery_token = '''', email_change_token_new = '''',
             email_change = '''' where id = $1' using p_id;
  end if;

  -- Email identity so the account can sign in through Supabase Auth.
  if p_email is not null and exists (
       select 1 from information_schema.columns
       where table_schema = 'auth' and table_name = 'identities' and column_name = 'provider_id') then
    execute 'insert into auth.identities (id, user_id, provider_id, provider, identity_data, created_at, updated_at, last_sign_in_at)
             values (gen_random_uuid(), $1, $1::text, ''email'',
                     jsonb_build_object(''sub'', $1::text, ''email'', $2::text, ''email_verified'', true), now(), now(), now())'
      using p_id, p_email;
  end if;
end;
$$;

select pg_temp.seed_user('00000000-0000-4000-8000-000000000001', 'admin@example.test',          null, 'Admin Plateforme');
select pg_temp.seed_user('0000000a-0000-4000-8000-000000000001', 'dr.amal@example.test',        null, 'Dr Amal Démo');
select pg_temp.seed_user('0000000a-0000-4000-8000-000000000002', 'reception.amal@example.test', null, 'Nadia Accueil');
select pg_temp.seed_user('0000000a-0000-4000-8000-000000000003', 'compta.amal@example.test',    null, 'Omar Comptable');
select pg_temp.seed_user('0000000a-0000-4000-8000-000000000004', 'dr.karim@example.test',       null, 'Dr Karim Démo');
select pg_temp.seed_user('0000000b-0000-4000-8000-000000000001', 'owner.riad@example.test',     null, 'Hind Gérante');
select pg_temp.seed_user('0000000b-0000-4000-8000-000000000002', 'dr.salma@example.test',       null, 'Dr Salma Démo');
select pg_temp.seed_user('0000000b-0000-4000-8000-000000000003', 'reception.riad@example.test', null, 'Rachid Accueil');
select pg_temp.seed_user('0000000c-0000-4000-8000-000000000001', 'owner.attente@example.test',  null, 'Samir En Attente');
select pg_temp.seed_user('0000000d-0000-4000-8000-000000000001', null, '99900000101', 'Compte Patient Démo');

insert into public.platform_admins (user_id, granted_by)
values ('00000000-0000-4000-8000-000000000001', null);

-- ---------------------------------------------------------------------------
-- Clinics
-- ---------------------------------------------------------------------------
insert into public.clinics (id, slug, display_name, city, phone_e164, status, approved_at, approved_by, created_by) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'cabinet-demo-al-amal', 'Cabinet Démo Al Amal', 'Nador',
   '+99900000001', 'active', now(), '00000000-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000001'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'centre-medical-demo-riad', 'Centre Médical Démo Riad', 'Nador',
   '+99900000002', 'active', now(), '00000000-0000-4000-8000-000000000001', '0000000b-0000-4000-8000-000000000001'),
  ('cccccccc-0000-4000-8000-000000000001', 'clinique-demo-en-attente', 'Clinique Démo en attente', 'Nador',
   null, 'pending_approval', null, null, '0000000c-0000-4000-8000-000000000001');

insert into public.clinic_settings (clinic_id, sms_sender_name) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'CabinetAA'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'CentreRiad'),
  ('cccccccc-0000-4000-8000-000000000001', null);

insert into public.clinic_members (clinic_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000001', 'clinic_owner'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000002', 'receptionist'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000003', 'accountant'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000004', 'doctor'),
  ('bbbbbbbb-0000-4000-8000-000000000001', '0000000b-0000-4000-8000-000000000001', 'clinic_owner'),
  ('bbbbbbbb-0000-4000-8000-000000000001', '0000000b-0000-4000-8000-000000000002', 'doctor'),
  ('bbbbbbbb-0000-4000-8000-000000000001', '0000000b-0000-4000-8000-000000000003', 'receptionist'),
  ('cccccccc-0000-4000-8000-000000000001', '0000000c-0000-4000-8000-000000000001', 'clinic_owner');

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------
insert into public.services (id, clinic_id, specialty_id, name_fr, name_ar, default_duration_minutes, price_mad, online_bookable) values
  ('aaaaaaaa-5e00-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   (select id from public.specialties where code = 'general_medicine'), 'Consultation générale', 'استشارة عامة', 20, 200.00, true),
  ('aaaaaaaa-5e00-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001',
   null, 'Consultation de suivi', 'استشارة متابعة', 15, 150.00, true),
  ('aaaaaaaa-5e00-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001',
   (select id from public.specialties where code = 'cardiology'), 'Électrocardiogramme', 'تخطيط القلب', 30, 300.00, false),
  ('bbbbbbbb-5e00-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001',
   (select id from public.specialties where code = 'pediatrics'), 'Consultation pédiatrique', 'استشارة طب الأطفال', 20, 250.00, true),
  ('bbbbbbbb-5e00-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000001',
   (select id from public.specialties where code = 'pediatrics'), 'Vaccination', 'تلقيح', 10, 100.00, false);

insert into public.doctors (id, clinic_id, user_id, full_name, full_name_ar, specialty_id, online_bookable) values
  ('aaaaaaaa-d000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000001',
   'Dr Amal Démo', 'د. أمل', (select id from public.specialties where code = 'general_medicine'), true),
  ('aaaaaaaa-d000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', '0000000a-0000-4000-8000-000000000004',
   'Dr Karim Démo', 'د. كريم', (select id from public.specialties where code = 'cardiology'), true),
  ('bbbbbbbb-d000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', '0000000b-0000-4000-8000-000000000002',
   'Dr Salma Démo', 'د. سلمى', (select id from public.specialties where code = 'pediatrics'), true);

insert into public.doctor_services (clinic_id, doctor_id, service_id, duration_minutes, price_mad) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-d000-4000-8000-000000000001', 'aaaaaaaa-5e00-4000-8000-000000000001', null, null),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-d000-4000-8000-000000000001', 'aaaaaaaa-5e00-4000-8000-000000000002', null, null),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-d000-4000-8000-000000000002', 'aaaaaaaa-5e00-4000-8000-000000000001', 30, 300.00),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-d000-4000-8000-000000000002', 'aaaaaaaa-5e00-4000-8000-000000000003', null, null),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-d000-4000-8000-000000000001', 'bbbbbbbb-5e00-4000-8000-000000000001', null, null),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-d000-4000-8000-000000000001', 'bbbbbbbb-5e00-4000-8000-000000000002', null, null);

-- Online booking can be enabled now that bookable services exist (BR-T-07 trigger).
update public.clinic_settings set online_booking_enabled = true
where clinic_id in ('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001');

-- ---------------------------------------------------------------------------
-- Schedules: regular week + a Ramadan 2027 override (approximate dates, to confirm)
-- ---------------------------------------------------------------------------
insert into public.doctor_schedules (id, clinic_id, doctor_id, name, kind, valid_from, valid_until) values
  ('aaaaaaaa-5c00-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-d000-4000-8000-000000000001',
   'Horaires normaux', 'regular', current_date - 30, null),
  ('aaaaaaaa-5c00-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-d000-4000-8000-000000000001',
   'Horaires Ramadan 2027 (dates à confirmer)', 'override', date '2027-02-08', date '2027-03-09'),
  ('aaaaaaaa-5c00-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-d000-4000-8000-000000000002',
   'Horaires normaux', 'regular', current_date - 30, null),
  ('bbbbbbbb-5c00-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-d000-4000-8000-000000000001',
   'Horaires normaux', 'regular', current_date - 30, null);

-- Regular: Mon–Fri 09:00–12:30 and 14:30–18:00, Saturday 09:00–13:00.
insert into public.doctor_availability (clinic_id, schedule_id, doctor_id, weekday, start_time, end_time)
select s.clinic_id, s.id, s.doctor_id, w.weekday, w.start_time, w.end_time
from public.doctor_schedules s
cross join (values
  (1, time '09:00', time '12:30'), (1, time '14:30', time '18:00'),
  (2, time '09:00', time '12:30'), (2, time '14:30', time '18:00'),
  (3, time '09:00', time '12:30'), (3, time '14:30', time '18:00'),
  (4, time '09:00', time '12:30'), (4, time '14:30', time '18:00'),
  (5, time '09:00', time '12:30'), (5, time '14:30', time '18:00'),
  (6, time '09:00', time '13:00')) as w(weekday, start_time, end_time)
where s.kind = 'regular';

-- Ramadan override: Monday–Saturday 10:00–15:00.
insert into public.doctor_availability (clinic_id, schedule_id, doctor_id, weekday, start_time, end_time)
select s.clinic_id, s.id, s.doctor_id, w.weekday, time '10:00', time '15:00'
from public.doctor_schedules s
cross join generate_series(1, 6) as w(weekday)
where s.kind = 'override';

-- Public holidays as clinic closures (examples).
insert into public.clinic_closures (clinic_id, dates, reason) values
  ('aaaaaaaa-0000-4000-8000-000000000001', daterange(date '2027-01-11', date '2027-01-11', '[]'), 'Manifeste de l''Indépendance'),
  ('aaaaaaaa-0000-4000-8000-000000000001', daterange(date '2027-01-14', date '2027-01-14', '[]'), 'Nouvel An amazigh'),
  ('bbbbbbbb-0000-4000-8000-000000000001', daterange(date '2027-01-11', date '2027-01-11', '[]'), 'Manifeste de l''Indépendance');

-- Dr Karim on leave three weeks from now (Monday to Wednesday, Casablanca time).
insert into public.doctor_time_off (clinic_id, doctor_id, period, reason_category, note)
select 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-d000-4000-8000-000000000002',
       tstzrange((d + time '00:00') at time zone 'Africa/Casablanca', ((d + 3) + time '00:00') at time zone 'Africa/Casablanca', '[)'),
       'leave', 'Congé (démo)'
from (select current_date + 21 + ((8 - extract(isodow from current_date + 21)::integer) % 7) as d) as monday;

-- ---------------------------------------------------------------------------
-- Patients (synthetic) — file numbers are assigned by the trigger
-- ---------------------------------------------------------------------------
insert into public.patients (id, clinic_id, first_name, last_name, first_name_ar, last_name_ar, sex, date_of_birth,
                             phone_e164, preferred_locale, preferred_channel, created_via) values
  ('aaaaaaaa-9a00-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'Amina',  'Démo-Haddou',  'أمينة', 'حدو',   'female', date '1988-04-12', '+99900000101', 'ar', 'sms',   'import'),
  ('aaaaaaaa-9a00-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'Yassine','Démo-Haddou',  'ياسين', 'حدو',   'male',   date '2016-09-03', '+99900000101', 'ar', 'sms',   'import'),
  ('aaaaaaaa-9a00-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'Fatima', 'Démo-Ouali',   null,    null,     'female', date '1957-01-21', '+99900000102', 'fr', 'sms',   'import'),
  ('aaaaaaaa-9a00-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001', 'Mehdi',  'Démo-Bouzid',  null,    null,     'male',   date '1993-11-30', null,           'fr', 'none',  'import'),
  ('bbbbbbbb-9a00-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'Sara',   'Démo-Amrani',  'سارة',  'العمراني', 'female', date '2021-06-15', '+99900000201', 'fr', 'sms',   'import'),
  ('bbbbbbbb-9a00-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000001', 'Ilyas',  'Démo-Amrani',  null,    null,     'male',   date '2019-02-08', '+99900000201', 'fr', 'sms',   'import');

-- The portal account acts for Amina (self) and her son Yassine (child) at Al Amal only.
insert into public.patient_accounts (user_id, clinic_id, patient_id, relationship, linked_via) values
  ('0000000d-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-9a00-4000-8000-000000000001', 'self',  'staff'),
  ('0000000d-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-9a00-4000-8000-000000000002', 'child', 'staff');

insert into public.patient_consents (clinic_id, patient_id, purpose, granted, document_version, source)
select p.clinic_id, p.id, c.purpose, true, 'v1-demo', 'reception'
from public.patients p
cross join (values ('data_processing'::public.consent_purpose), ('reminders_sms'::public.consent_purpose)) as c(purpose)
where p.phone_e164 is not null;

-- ---------------------------------------------------------------------------
-- Appointments next week (Monday and Tuesday, Casablanca time, inside both schedules)
-- ---------------------------------------------------------------------------
with next_monday as (
  select current_date + 7 + ((8 - extract(isodow from current_date + 7)::integer) % 7) as d
)
insert into public.appointments (clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, source,
                                 price_mad, booked_by_user_id, confirmed_at)
select a.clinic_id, a.patient_id, a.doctor_id, a.service_id,
       (m.d + a.day_offset + a.local_start) at time zone 'Africa/Casablanca',
       (m.d + a.day_offset + a.local_start + make_interval(mins => a.minutes)) at time zone 'Africa/Casablanca',
       a.status::public.appointment_status, 'staff', a.price, a.booked_by,
       case when a.status = 'confirmed' then now() end
from next_monday m
cross join (values
  ('aaaaaaaa-0000-4000-8000-000000000001'::uuid, 'aaaaaaaa-9a00-4000-8000-000000000001'::uuid,
   'aaaaaaaa-d000-4000-8000-000000000001'::uuid, 'aaaaaaaa-5e00-4000-8000-000000000001'::uuid,
   0, time '10:00', 20, 'confirmed', 200.00, '0000000a-0000-4000-8000-000000000002'::uuid),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-9a00-4000-8000-000000000002',
   'aaaaaaaa-d000-4000-8000-000000000001', 'aaaaaaaa-5e00-4000-8000-000000000002',
   0, time '10:20', 15, 'confirmed', 150.00, '0000000a-0000-4000-8000-000000000002'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-9a00-4000-8000-000000000003',
   'aaaaaaaa-d000-4000-8000-000000000002', 'aaaaaaaa-5e00-4000-8000-000000000003',
   0, time '11:00', 30, 'confirmed', 300.00, '0000000a-0000-4000-8000-000000000002'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-9a00-4000-8000-000000000004',
   'aaaaaaaa-d000-4000-8000-000000000002', 'aaaaaaaa-5e00-4000-8000-000000000001',
   1, time '10:00', 30, 'pending', 300.00, '0000000a-0000-4000-8000-000000000002'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-9a00-4000-8000-000000000001',
   'bbbbbbbb-d000-4000-8000-000000000001', 'bbbbbbbb-5e00-4000-8000-000000000001',
   0, time '10:00', 20, 'confirmed', 250.00, '0000000b-0000-4000-8000-000000000003'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-9a00-4000-8000-000000000002',
   'bbbbbbbb-d000-4000-8000-000000000001', 'bbbbbbbb-5e00-4000-8000-000000000002',
   0, time '10:20', 10, 'confirmed', 100.00, '0000000b-0000-4000-8000-000000000003')
) as a(clinic_id, patient_id, doctor_id, service_id, day_offset, local_start, minutes, status, price, booked_by);

-- One cancellation, through a direct update so the history trigger records it.
update public.appointments
   set status = 'cancelled', cancelled_at = now(), cancellation_actor = 'patient', cancellation_reason = 'patient_request'
 where clinic_id = 'aaaaaaaa-0000-4000-8000-000000000001' and status = 'pending';

-- ---------------------------------------------------------------------------
-- Legal documents: placeholders only (real texts come from counsel, BR-D-05)
-- ---------------------------------------------------------------------------
insert into public.legal_documents (kind, locale, version, content_path, is_current)
select k.kind, l.locale, 'draft-0', format('legal/%s/%s/draft-0.md', k.kind, l.locale), true
from (values ('terms_of_service'::public.legal_kind), ('privacy_policy'::public.legal_kind),
             ('clinic_dpa'::public.legal_kind), ('patient_privacy_notice'::public.legal_kind)) as k(kind)
cross join (values ('fr'), ('ar')) as l(locale);
