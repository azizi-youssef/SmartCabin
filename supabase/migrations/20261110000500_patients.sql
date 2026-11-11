-- SmartCabin 0005 — Patients (BC5): clinic-scoped records, portal links, consents.
-- Administrative data only: no clinical content in the MVP (BR-D-01).

-- ---------------------------------------------------------------------------
-- patients — the clinic's administrative file for one person (managed table)
-- ---------------------------------------------------------------------------
create table public.patients (
  id                uuid primary key default gen_random_uuid(),
  clinic_id         uuid not null references public.clinics (id),
  file_number       text not null,
  first_name        text not null,
  last_name         text not null,
  first_name_ar     text,
  last_name_ar      text,
  sex               public.sex,
  date_of_birth     date,
  phone_e164        text,
  email             extensions.citext,
  preferred_locale  text not null default 'fr',
  preferred_channel public.contact_channel not null default 'sms',
  status            public.patient_status not null default 'active',
  merged_into_id    uuid,
  created_via       public.patient_origin not null default 'reception',
  created_by        uuid references auth.users (id),
  archived_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint patients_clinic_id_id_key unique (clinic_id, id),
  constraint patients_file_number_key unique (clinic_id, file_number),
  constraint patients_merged_into_fkey foreign key (clinic_id, merged_into_id) references public.patients (clinic_id, id),
  constraint patients_names check (
    char_length(btrim(first_name)) between 1 and 80 and char_length(btrim(last_name)) between 1 and 80
    and (first_name_ar is null or char_length(first_name_ar) <= 80)
    and (last_name_ar is null or char_length(last_name_ar) <= 80)),
  constraint patients_dob_range check (date_of_birth is null or date_of_birth >= date '1900-01-01'),
  -- Phone is deliberately NOT unique: families share numbers.
  constraint patients_phone_format check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  constraint patients_email_format check (email is null or email::text ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  constraint patients_locale check (preferred_locale in ('fr', 'ar')),
  constraint patients_merge_coherent check ((status = 'merged') = (merged_into_id is not null)),
  constraint patients_not_merged_into_self check (merged_into_id is null or merged_into_id <> id),
  constraint patients_archive_coherent check ((status = 'archived') = (archived_at is not null))
);

create index patients_phone_idx on public.patients (clinic_id, phone_e164) where phone_e164 is not null;
create index patients_name_trgm_idx on public.patients using gin (
  lower(first_name || ' ' || last_name || ' ' || coalesce(first_name_ar, '') || ' ' || coalesce(last_name_ar, ''))
  extensions.gin_trgm_ops);

-- Server-controlled columns on insert: gapless file number, creator, initial status.
create function private.patients_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.file_number    := 'P' || lpad(private.next_counter_value(new.clinic_id, 'patient_file')::text, 6, '0');
  new.created_by     := coalesce(auth.uid(), new.created_by);
  new.status         := 'active';
  new.merged_into_id := null;
  new.archived_at    := null;
  if new.date_of_birth > current_date then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'date_of_birth is in the future';
  end if;
  return new;
end;
$$;

create function private.patients_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.file_number is distinct from old.file_number then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'file_number cannot change';
  end if;
  if new.date_of_birth is distinct from old.date_of_birth and new.date_of_birth > current_date then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'date_of_birth is in the future';
  end if;
  return new;
end;
$$;

create trigger patients_before_insert
  before insert on public.patients
  for each row execute function private.patients_before_insert();
create trigger patients_before_update
  before update on public.patients
  for each row execute function private.patients_before_update();
create trigger patients_set_updated_at
  before update on public.patients
  for each row execute function private.set_updated_at();
create trigger patients_tenant_immutable
  before update on public.patients
  for each row execute function private.forbid_clinic_id_change();

-- ---------------------------------------------------------------------------
-- patient_accounts — portal account ↔ patient record links (command table)
-- Never created by phone matching (BR-D-02); written by portal/staff commands (slice S7).
-- ---------------------------------------------------------------------------
create table public.patient_accounts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  clinic_id    uuid not null,
  patient_id   uuid not null,
  relationship public.patient_relationship not null,
  linked_via   public.link_origin not null,
  linked_at    timestamptz not null default now(),
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint patient_accounts_clinic_id_id_key unique (clinic_id, id),
  constraint patient_accounts_patient_fkey foreign key (clinic_id, patient_id) references public.patients (clinic_id, id),
  constraint patient_accounts_revocation check (revoked_at is null or revoked_at >= linked_at)
);

create unique index patient_accounts_active_link on public.patient_accounts (user_id, patient_id) where revoked_at is null;
create index patient_accounts_patient_idx on public.patient_accounts (clinic_id, patient_id);

create trigger patient_accounts_set_updated_at
  before update on public.patient_accounts
  for each row execute function private.set_updated_at();
create trigger patient_accounts_tenant_immutable
  before update on public.patient_accounts
  for each row execute function private.forbid_clinic_id_change();

-- ---------------------------------------------------------------------------
-- patient_consents — append-only evidence; the latest row per purpose is current
-- ---------------------------------------------------------------------------
create table public.patient_consents (
  id                  uuid primary key default gen_random_uuid(),
  clinic_id           uuid not null,
  patient_id          uuid not null,
  purpose             public.consent_purpose not null,
  granted             boolean not null,
  document_version    text not null,
  source              public.consent_source not null,
  recorded_by_user_id uuid references auth.users (id),
  recorded_at         timestamptz not null default now(),
  constraint patient_consents_patient_fkey foreign key (clinic_id, patient_id) references public.patients (clinic_id, id),
  constraint patient_consents_version_length check (char_length(document_version) between 1 and 40)
);

create index patient_consents_latest_idx on public.patient_consents (patient_id, purpose, recorded_at desc);

create function private.patient_consents_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.recorded_by_user_id := coalesce(auth.uid(), new.recorded_by_user_id);
  new.recorded_at := now();
  return new;
end;
$$;

create trigger patient_consents_before_insert
  before insert on public.patient_consents
  for each row execute function private.patient_consents_before_insert();
create trigger patient_consents_append_only
  before update or delete on public.patient_consents
  for each row execute function private.forbid_mutation();
