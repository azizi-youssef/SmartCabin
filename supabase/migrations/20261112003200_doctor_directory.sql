-- SmartCabin 0032 — Public doctor directory (/medecins): patients find a doctor by specialty
-- across clinics, see the next free online slot and go to that clinic's booking page.
--
-- BR-P-04: a clinic appears only after its owner or administrator agrees
-- (clinic_settings.listed_in_directory, off by default, clinic.settings.update). Only doctors
-- open to online booking are listed, and only while the clinic takes online bookings.
-- The directory shows what each clinic's booking page already shows (doctor names, specialty,
-- clinic name and address, online prices) plus the next free slot time. Nothing about patients.
-- Additive only: one column with a default, one function.

alter table public.clinic_settings
  add column listed_in_directory boolean not null default false;

comment on column public.clinic_settings.listed_in_directory is
  'BR-P-04: the clinic agreed to list its online-bookable doctors in the public directory.';

grant update (listed_in_directory) on public.clinic_settings to authenticated;

-- ---------------------------------------------------------------------------
-- Public read (anon): listed doctors, with their lowest online price and next free online slot
-- in the next 14 days (same rules as the booking page: lead time, horizon, time off, closures,
-- existing bookings). At most 500 doctors.
-- ---------------------------------------------------------------------------
create function public.public_list_directory_doctors()
returns table (
  doctor_id uuid, doctor_name text, doctor_name_ar text,
  specialty_code text, specialty_name_fr text, specialty_name_ar text,
  clinic_slug text, clinic_name text, clinic_city text, clinic_address text, clinic_timezone text,
  min_price_mad numeric, next_slot_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with listed as (
    select d.id, d.full_name, d.full_name_ar, d.specialty_id, c.id as clinic_id, c.slug, c.display_name,
           c.city, c.address_line, c.timezone, (now() at time zone c.timezone)::date as local_today
    from public.doctors d
    join public.clinics c          on c.id = d.clinic_id
    join public.clinic_settings st on st.clinic_id = c.id
    where st.listed_in_directory
      and c.status = 'active'
      and d.status = 'active'
      and d.online_bookable
      and private.online_booking_open(c.id)
  ),
  offers as (
    select l.id as doctor_id, ds.service_id, coalesce(ds.price_mad, sv.price_mad) as price_mad
    from listed l
    join public.doctor_services ds on ds.clinic_id = l.clinic_id and ds.doctor_id = l.id
    join public.services sv        on sv.clinic_id = ds.clinic_id and sv.id = ds.service_id
    where ds.is_active and ds.online_bookable and sv.status = 'active' and sv.online_bookable
  )
  select l.id, l.full_name, l.full_name_ar,
         sp.code::text, sp.name_fr, sp.name_ar,
         l.slug::text, l.display_name, l.city, l.address_line, l.timezone,
         (select min(o.price_mad) from offers o where o.doctor_id = l.id),
         (select min(fs.slot_starts_at)
            from offers o
            cross join lateral private.free_online_slots(l.clinic_id, l.id, o.service_id, l.local_today, l.local_today + 13) fs
           where o.doctor_id = l.id)
  from listed l
  left join public.specialties sp on sp.id = l.specialty_id
  where exists (select 1 from offers o where o.doctor_id = l.id)
  order by sp.name_fr nulls last, l.full_name
  limit 500;
$$;

revoke all on function public.public_list_directory_doctors() from public;
grant execute on function public.public_list_directory_doctors() to anon, authenticated;
