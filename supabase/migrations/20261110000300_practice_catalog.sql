-- SmartCabin 0003 — Practice Catalog (BC3): specialties, services, doctors, doctor_services.

-- ---------------------------------------------------------------------------
-- specialties — platform reference data
-- ---------------------------------------------------------------------------
create table public.specialties (
  id         uuid primary key default gen_random_uuid(),
  code       text not null,
  name_fr    text not null,
  name_ar    text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint specialties_code_key unique (code),
  constraint specialties_code_format check (code ~ '^[a-z_]{2,40}$'),
  constraint specialties_names check (char_length(name_fr) between 2 and 80 and char_length(name_ar) between 2 and 80)
);

create trigger specialties_set_updated_at
  before update on public.specialties
  for each row execute function private.set_updated_at();

-- Reference list. Arabic labels need a native review before launch (audit R13).
insert into public.specialties (code, name_fr, name_ar) values
  ('general_medicine',      'Médecine générale',        'الطب العام'),
  ('pediatrics',            'Pédiatrie',                'طب الأطفال'),
  ('gynecology_obstetrics', 'Gynécologie-obstétrique',  'طب النساء والتوليد'),
  ('cardiology',            'Cardiologie',              'أمراض القلب'),
  ('dermatology',           'Dermatologie',             'الأمراض الجلدية'),
  ('ophthalmology',         'Ophtalmologie',            'طب العيون'),
  ('ent',                   'Oto-rhino-laryngologie',   'طب الأنف والأذن والحنجرة'),
  ('dentistry',             'Médecine dentaire',        'طب الأسنان'),
  ('internal_medicine',     'Médecine interne',         'الطب الباطني'),
  ('endocrinology',         'Endocrinologie',           'الغدد الصماء'),
  ('gastroenterology',      'Gastro-entérologie',       'أمراض الجهاز الهضمي'),
  ('psychiatry',            'Psychiatrie',              'الطب النفسي'),
  ('rheumatology',          'Rhumatologie',             'أمراض الروماتيزم'),
  ('radiology',             'Radiologie',               'الأشعة');

-- ---------------------------------------------------------------------------
-- services — what a clinic offers (managed table)
-- ---------------------------------------------------------------------------
create table public.services (
  id                       uuid primary key default gen_random_uuid(),
  clinic_id                uuid not null references public.clinics (id),
  specialty_id             uuid references public.specialties (id),
  name_fr                  text,
  name_ar                  text,
  default_duration_minutes integer not null,
  price_mad                numeric(12, 2) not null,
  online_bookable          boolean not null default false,
  status                   public.catalog_status not null default 'active',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint services_clinic_id_id_key unique (clinic_id, id),
  constraint services_has_name check (coalesce(btrim(name_fr), '') <> '' or coalesce(btrim(name_ar), '') <> ''),
  constraint services_name_length check (
    (name_fr is null or char_length(name_fr) <= 120) and (name_ar is null or char_length(name_ar) <= 120)),
  constraint services_duration check (default_duration_minutes between 5 and 480 and default_duration_minutes % 5 = 0),
  constraint services_price check (price_mad >= 0)
);

create unique index services_unique_active_name_fr
  on public.services (clinic_id, lower(name_fr)) where status = 'active' and name_fr is not null;
create unique index services_unique_active_name_ar
  on public.services (clinic_id, name_ar) where status = 'active' and name_ar is not null;
create index services_specialty_idx on public.services (specialty_id) where specialty_id is not null;

create trigger services_set_updated_at
  before update on public.services
  for each row execute function private.set_updated_at();
create trigger services_tenant_immutable
  before update on public.services
  for each row execute function private.forbid_clinic_id_change();

-- ---------------------------------------------------------------------------
-- doctors — practitioner, one row per doctor per clinic (managed table, MD-03)
-- ---------------------------------------------------------------------------
create table public.doctors (
  id              uuid primary key default gen_random_uuid(),
  clinic_id       uuid not null references public.clinics (id),
  user_id         uuid,
  full_name       text not null,
  full_name_ar    text,
  specialty_id    uuid references public.specialties (id),
  inpe            text,
  phone_e164      text,
  online_bookable boolean not null default false,
  status          public.doctor_status not null default 'active',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint doctors_clinic_id_id_key unique (clinic_id, id),
  -- A linked login must be a member of the same clinic (no cross-tenant link).
  constraint doctors_member_fkey foreign key (clinic_id, user_id)
    references public.clinic_members (clinic_id, user_id),
  constraint doctors_name_length check (
    char_length(btrim(full_name)) between 2 and 120 and (full_name_ar is null or char_length(full_name_ar) <= 120)),
  constraint doctors_inpe_format check (inpe is null or inpe ~ '^[A-Za-z0-9]{3,20}$'),
  constraint doctors_phone_format check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$')
);

create unique index doctors_one_per_user_per_clinic on public.doctors (clinic_id, user_id) where user_id is not null;
create index doctors_user_idx on public.doctors (user_id) where user_id is not null;
create index doctors_specialty_idx on public.doctors (specialty_id) where specialty_id is not null;

create trigger doctors_set_updated_at
  before update on public.doctors
  for each row execute function private.set_updated_at();
create trigger doctors_tenant_immutable
  before update on public.doctors
  for each row execute function private.forbid_clinic_id_change();

-- ---------------------------------------------------------------------------
-- doctor_services — which doctor provides which service (managed table)
-- ---------------------------------------------------------------------------
create table public.doctor_services (
  clinic_id        uuid not null,
  doctor_id        uuid not null,
  service_id       uuid not null,
  duration_minutes integer,
  price_mad        numeric(12, 2),
  online_bookable  boolean not null default true,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (clinic_id, doctor_id, service_id),
  constraint doctor_services_doctor_fkey foreign key (clinic_id, doctor_id) references public.doctors (clinic_id, id),
  constraint doctor_services_service_fkey foreign key (clinic_id, service_id) references public.services (clinic_id, id),
  constraint doctor_services_duration check (
    duration_minutes is null or (duration_minutes between 5 and 480 and duration_minutes % 5 = 0)),
  constraint doctor_services_price check (price_mad is null or price_mad >= 0)
);

create index doctor_services_service_idx on public.doctor_services (clinic_id, service_id);

create trigger doctor_services_set_updated_at
  before update on public.doctor_services
  for each row execute function private.set_updated_at();
create trigger doctor_services_tenant_immutable
  before update on public.doctor_services
  for each row execute function private.forbid_clinic_id_change();

-- ---------------------------------------------------------------------------
-- BR-T-07: online booking only for an active clinic with something bookable online.
-- ---------------------------------------------------------------------------
create function private.check_online_booking_allowed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.online_booking_enabled and (tg_op = 'INSERT' or not old.online_booking_enabled) then
    if not exists (select 1 from public.clinics c where c.id = new.clinic_id and c.status = 'active') then
      raise exception using errcode = 'P0001', message = 'ONLINE_BOOKING_NOT_ALLOWED',
        detail = 'clinic is not active';
    end if;
    if not exists (
      select 1
      from public.doctor_services ds
      join public.doctors d  on d.clinic_id = ds.clinic_id and d.id = ds.doctor_id
      join public.services s on s.clinic_id = ds.clinic_id and s.id = ds.service_id
      where ds.clinic_id = new.clinic_id
        and ds.is_active and ds.online_bookable
        and d.status = 'active' and d.online_bookable
        and s.status = 'active' and s.online_bookable) then
      raise exception using errcode = 'P0001', message = 'ONLINE_BOOKING_NOT_ALLOWED',
        detail = 'no active doctor offers an online-bookable service';
    end if;
  end if;
  return new;
end;
$$;

create trigger clinic_settings_online_booking_guard
  before insert or update of online_booking_enabled on public.clinic_settings
  for each row execute function private.check_online_booking_allowed();
