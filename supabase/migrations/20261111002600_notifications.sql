-- SmartCabin 0026 — Module 9: notifications (BUSINESS_RULES §6, DOMAIN_MODEL BC8).
--
-- Planner (SQL, every minute): domain_events → notifications, each with a unique idempotency key
-- (BR-N-01); reminders at the clinic's offsets outside 21:00–08:00 (BR-N-07, BR-N-09);
-- reschedule/cancel cancel what is still scheduled and plan again (BR-N-03); doctor delays
-- (BR-Q-11); "turn approaching" once per ticket (§3.2-5).
-- Dispatcher (worker endpoint): claims due messages under a lease, re-reads the appointment or
-- queue entry and the consent right before sending (BR-N-02, BR-N-04), renders the patient's
-- locale, records each attempt (append-only, masked recipient) and retries with backoff 1, 5, 15,
-- 60 min, at most 5 attempts (BR-N-06).
--
-- No service-role key: the job functions are callable by `anon` but require the job key, whose
-- SHA-256 is stored in private.job_credentials. The key only allows notification work.
-- Deferred: delivery receipts (provider webhooks), the SMS quota (BR-N-08, plans: module 12),
-- invitation e-mails and opaque patient links (S7).

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.notification_status as enum ('scheduled', 'processing', 'sent', 'delivered', 'failed', 'cancelled', 'skipped');
create type public.notification_event as enum (
  'booking_received', 'appointment_confirmation', 'appointment_reminder', 'appointment_rescheduled',
  'appointment_cancellation', 'doctor_delay', 'turn_approaching', 'staff_invitation', 'clinic_status_changed');
create type public.notification_channel as enum ('email', 'sms', 'whatsapp', 'push');

-- ---------------------------------------------------------------------------
-- notification_templates — versioned text per event, channel and locale (platform defaults: clinic_id null)
-- ---------------------------------------------------------------------------
create table public.notification_templates (
  id         uuid primary key default gen_random_uuid(),
  clinic_id  uuid references public.clinics (id),
  event_type public.notification_event not null,
  channel    public.notification_channel not null,
  locale     text not null,
  version    integer not null default 1,
  subject    text,
  body       text not null,
  is_active  boolean not null default true,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  constraint notification_templates_version_key unique nulls not distinct (clinic_id, event_type, channel, locale, version),
  constraint notification_templates_locale check (locale in ('fr', 'ar')),
  constraint notification_templates_version check (version >= 1),
  constraint notification_templates_body_length check (char_length(body) between 1 and 1000),
  constraint notification_templates_subject check ((channel = 'email') = (subject is not null)),
  constraint notification_templates_sms_length check (channel not in ('sms', 'whatsapp') or char_length(body) <= 320),
  -- BR-N-05: only these placeholders, never a service, specialty, reason or other clinical detail.
  constraint notification_templates_placeholders check (
    regexp_replace(body || coalesce(subject, ''), '\{(clinic|date|time|ticket|delay)\}', '', 'g') !~ '[{}]')
);
create unique index notification_templates_one_active on public.notification_templates
  (coalesce(clinic_id, '00000000-0000-0000-0000-000000000000'::uuid), event_type, channel, locale) where is_active;
alter table public.notification_templates enable row level security;
-- No grant: templates are read by the dispatcher only (definer functions).

-- Platform defaults, French and Arabic. SMS and WhatsApp share the same text.
with texts (event_type, locale, subject, body) as (values
  ('appointment_confirmation', 'fr', 'Rendez-vous confirmé', '{clinic} : votre rendez-vous est confirmé le {date} à {time}.'),
  ('appointment_confirmation', 'ar', 'تأكيد الموعد', '{clinic}: تم تأكيد موعدك يوم {date} على الساعة {time}.'),
  ('appointment_reminder', 'fr', 'Rappel de rendez-vous', '{clinic} : rappel de votre rendez-vous le {date} à {time}.'),
  ('appointment_reminder', 'ar', 'تذكير بالموعد', '{clinic}: تذكير بموعدك يوم {date} على الساعة {time}.'),
  ('appointment_rescheduled', 'fr', 'Rendez-vous déplacé', '{clinic} : votre rendez-vous a été déplacé au {date} à {time}.'),
  ('appointment_rescheduled', 'ar', 'تغيير الموعد', '{clinic}: تم تغيير موعدك إلى يوم {date} على الساعة {time}.'),
  ('appointment_cancellation', 'fr', 'Rendez-vous annulé', '{clinic} : votre rendez-vous du {date} à {time} est annulé. Contactez la clinique pour en reprendre un.'),
  ('appointment_cancellation', 'ar', 'إلغاء الموعد', '{clinic}: تم إلغاء موعدك يوم {date} على الساعة {time}. اتصل بالعيادة لأخذ موعد جديد.'),
  ('doctor_delay', 'fr', 'Retard du médecin', '{clinic} : le médecin a environ {delay} min de retard aujourd''hui. Merci de votre patience.'),
  ('doctor_delay', 'ar', 'تأخر الطبيب', '{clinic}: الطبيب متأخر بحوالي {delay} دقيقة اليوم. شكرًا على صبركم.'),
  ('turn_approaching', 'fr', 'Votre tour approche', '{clinic} : votre tour approche (ticket n° {ticket}). Merci de rester à proximité.'),
  ('turn_approaching', 'ar', 'دورك يقترب', '{clinic}: دورك يقترب (التذكرة رقم {ticket}). المرجو البقاء بالقرب.')
)
insert into public.notification_templates (event_type, channel, locale, subject, body)
select t.event_type::public.notification_event, c.channel::public.notification_channel, t.locale,
       case when c.channel = 'email' then t.subject end, t.body
from texts t cross join (values ('sms'), ('whatsapp'), ('email')) as c(channel);

-- ---------------------------------------------------------------------------
-- notifications — one message to one recipient on one channel (command table)
-- ---------------------------------------------------------------------------
create table public.notifications (
  id                    uuid primary key default gen_random_uuid(),
  clinic_id             uuid not null references public.clinics (id),
  patient_id            uuid,
  user_id               uuid references auth.users (id),
  invitation_id         uuid,
  appointment_id        uuid,
  queue_entry_id        uuid,
  event_type            public.notification_event not null,
  channel               public.notification_channel not null,
  locale                text not null,
  template_id           uuid references public.notification_templates (id),
  scheduled_for         timestamptz not null,
  context_starts_at     timestamptz,
  delay_minutes         integer,
  status                public.notification_status not null default 'scheduled',
  idempotency_key       text not null,
  attempt_count         integer not null default 0,
  next_attempt_at       timestamptz,
  locked_until          timestamptz,
  processing_started_at timestamptz,
  recipient_masked      text,
  provider              text,
  provider_message_id   text,
  sent_at               timestamptz,
  delivered_at          timestamptz,
  failed_at             timestamptz,
  skip_reason           text,
  last_error            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint notifications_idempotency_key unique (idempotency_key),
  constraint notifications_clinic_id_id_key unique (clinic_id, id),
  constraint notifications_one_recipient check (num_nonnulls(patient_id, user_id, invitation_id) = 1),
  constraint notifications_patient_fkey foreign key (clinic_id, patient_id) references public.patients (clinic_id, id),
  constraint notifications_appointment_fkey foreign key (clinic_id, appointment_id) references public.appointments (clinic_id, id),
  constraint notifications_entry_fkey foreign key (clinic_id, queue_entry_id) references public.queue_entries (clinic_id, id),
  constraint notifications_invitation_fkey foreign key (clinic_id, invitation_id) references public.clinic_invitations (clinic_id, id),
  constraint notifications_locale check (locale in ('fr', 'ar')),
  constraint notifications_attempts check (attempt_count between 0 and 5),
  constraint notifications_skip_reason check (skip_reason is null or skip_reason in
    ('stale', 'no_consent', 'no_address', 'quiet_hours', 'no_template', 'quota_exceeded')),
  constraint notifications_skip_coherent check ((status = 'skipped') = (skip_reason is not null)),
  constraint notifications_sent_coherent check (status not in ('sent', 'delivered') or sent_at is not null),
  constraint notifications_failed_coherent check ((status = 'failed') = (failed_at is not null)),
  constraint notifications_error_length check (last_error is null or char_length(last_error) <= 200)
);
create index notifications_due_idx on public.notifications (scheduled_for) where status in ('scheduled', 'processing');
create index notifications_appointment_idx on public.notifications (clinic_id, appointment_id);
create trigger notifications_set_updated_at
  before update on public.notifications
  for each row execute function private.set_updated_at();
create trigger notifications_tenant_immutable
  before update on public.notifications
  for each row execute function private.forbid_clinic_id_change();

-- ---------------------------------------------------------------------------
-- notification_attempts — one row per provider call (append-only)
-- ---------------------------------------------------------------------------
create table public.notification_attempts (
  id               bigint generated always as identity primary key,
  clinic_id        uuid not null,
  notification_id  uuid not null,
  attempt_no       integer not null,
  provider         text,
  recipient_masked text,
  started_at       timestamptz,
  finished_at      timestamptz not null default now(),
  outcome          text not null,
  provider_status  text,
  error_code       text,
  constraint notification_attempts_notification_fkey foreign key (clinic_id, notification_id) references public.notifications (clinic_id, id),
  constraint notification_attempts_no_key unique (notification_id, attempt_no),
  constraint notification_attempts_no check (attempt_no between 1 and 5),
  constraint notification_attempts_outcome check (outcome in ('accepted', 'rejected', 'error', 'timeout')),
  constraint notification_attempts_codes check (
    (provider_status is null or char_length(provider_status) <= 60) and (error_code is null or char_length(error_code) <= 60))
);
create trigger notification_attempts_append_only
  before update or delete on public.notification_attempts
  for each row execute function private.forbid_mutation();

-- RLS: the clinic's staff with notifications.view_log (owner, admin, receptionist).
alter table public.notifications enable row level security;
alter table public.notification_attempts enable row level security;
grant select on public.notifications to authenticated;
grant select on public.notification_attempts to authenticated;
create policy notifications_select on public.notifications for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('notifications.view_log')));
create policy notification_attempts_select on public.notification_attempts for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('notifications.view_log')));

-- ---------------------------------------------------------------------------
-- Job key (least privilege instead of a service-role key)
-- ---------------------------------------------------------------------------
create table private.job_credentials (
  id         smallint primary key default 1,
  key_hash   text not null,
  rotated_at timestamptz not null default now(),
  constraint job_credentials_single check (id = 1),
  constraint job_credentials_hash check (key_hash ~ '^[0-9a-f]{64}$')
);
alter table private.job_credentials enable row level security;

-- Deployment: select private.set_job_key_hash(encode(extensions.digest('<JOBS_SECRET>', 'sha256'), 'hex'));
create function private.set_job_key_hash(p_hash text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into private.job_credentials (id, key_hash) values (1, p_hash)
  on conflict (id) do update set key_hash = excluded.key_hash, rotated_at = now();
$$;

create function private.require_job_key(p_job_key text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_job_key is null or char_length(p_job_key) < 32 or not exists (
      select 1 from private.job_credentials c
      where c.key_hash = encode(extensions.digest(p_job_key, 'sha256'), 'hex')) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
end;
$$;
revoke all on function private.set_job_key_hash(text) from public, anon, authenticated;
revoke all on function private.require_job_key(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Planner
-- ---------------------------------------------------------------------------
-- Plans one message to a patient on their preferred channel (none: nothing). The idempotency key
-- makes planning repeatable; a cancelled identical plan is reactivated when asked (reschedule back).
create function private.plan_patient_message(
  p_clinic_id     uuid,
  p_patient_id    uuid,
  p_event         public.notification_event,
  p_key           text,
  p_scheduled_for timestamptz,
  p_appointment   uuid default null,
  p_entry         uuid default null,
  p_starts_at     timestamptz default null,
  p_delay         integer default null,
  p_skip_reason   text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_channel public.contact_channel;
  v_locale  text;
begin
  select p.preferred_channel, p.preferred_locale into v_channel, v_locale
  from public.patients p where p.clinic_id = p_clinic_id and p.id = p_patient_id and p.status = 'active';
  if not found or v_channel = 'none' then
    return;
  end if;
  insert into public.notifications (clinic_id, patient_id, appointment_id, queue_entry_id, event_type, channel, locale,
                                    scheduled_for, context_starts_at, delay_minutes, status, skip_reason, idempotency_key)
  values (p_clinic_id, p_patient_id, p_appointment, p_entry, p_event, v_channel::text::public.notification_channel, v_locale,
          p_scheduled_for, p_starts_at, p_delay,
          case when p_skip_reason is null then 'scheduled' else 'skipped' end::public.notification_status, p_skip_reason,
          format('%s:%s:%s', p_event, p_key, v_channel))
  on conflict (idempotency_key) do update
    set status = excluded.status, skip_reason = excluded.skip_reason, scheduled_for = excluded.scheduled_for,
        next_attempt_at = null
    where public.notifications.status = 'cancelled';
end;
$$;

-- Reminders at the clinic's offsets (BR-N-09), outside 21:00–08:00 clinic time (BR-N-07).
create function private.plan_reminders(p_appointment_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_appt    public.appointments;
  v_tz      text;
  v_offsets integer[];
  v_offset  integer;
  v_at      timestamptz;
  v_local   timestamp;
  v_moved   timestamptz;
begin
  select * into v_appt from public.appointments a where a.id = p_appointment_id;
  select c.timezone, coalesce(s.reminder_offsets_minutes, '{1440}') into v_tz, v_offsets
  from public.clinics c left join public.clinic_settings s on s.clinic_id = c.id where c.id = v_appt.clinic_id;
  foreach v_offset in array v_offsets loop
    v_at := v_appt.starts_at - make_interval(mins => v_offset);
    if v_at <= now() then
      continue; -- booked too close to the appointment for this reminder
    end if;
    v_local := v_at at time zone v_tz;
    v_moved := case
      when extract(hour from v_local) >= 21 then ((v_local::date + 1) + time '08:00') at time zone v_tz
      when extract(hour from v_local) < 8 then (v_local::date + time '08:00') at time zone v_tz
      else v_at end;
    perform private.plan_patient_message(
      v_appt.clinic_id, v_appt.patient_id, 'appointment_reminder',
      format('%s:%s:%s', v_appt.id, extract(epoch from v_appt.starts_at)::bigint, v_offset),
      v_moved, v_appt.id, null, v_appt.starts_at, null,
      case when v_moved >= v_appt.starts_at then 'quiet_hours' end);
  end loop;
end;
$$;

-- BR-N-03: whatever is still scheduled for an appointment is cancelled before planning again.
create function private.cancel_scheduled_messages(p_appointment_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.notifications set status = 'cancelled'
  where appointment_id = p_appointment_id and status = 'scheduled';
$$;

create function private.plan_for_event(p_event public.domain_events)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_appt    public.appointments;
  v_session public.doctor_sessions;
  v_target  record;
begin
  if p_event.event_type in ('appointment.confirmed', 'appointment.rescheduled', 'appointment.cancelled') then
    select * into v_appt from public.appointments a where a.id = p_event.aggregate_id;
    if not found then
      return;
    end if;
  end if;

  if p_event.event_type = 'appointment.confirmed' then
    if v_appt.status <> 'confirmed' or v_appt.starts_at <= now() then
      return; -- already moved on; later events plan what is needed
    end if;
    perform private.plan_patient_message(v_appt.clinic_id, v_appt.patient_id, 'appointment_confirmation',
      format('%s:%s', v_appt.id, extract(epoch from v_appt.starts_at)::bigint), now(), v_appt.id, null, v_appt.starts_at);
    perform private.plan_reminders(v_appt.id);

  elsif p_event.event_type = 'appointment.rescheduled' then
    perform private.cancel_scheduled_messages(v_appt.id);
    if v_appt.status in ('pending', 'confirmed') and v_appt.starts_at > now() then
      perform private.plan_patient_message(v_appt.clinic_id, v_appt.patient_id, 'appointment_rescheduled',
        format('%s:%s', v_appt.id, extract(epoch from v_appt.starts_at)::bigint), now(), v_appt.id, null, v_appt.starts_at);
      if v_appt.status = 'confirmed' then
        perform private.plan_reminders(v_appt.id);
      end if;
    end if;

  elsif p_event.event_type = 'appointment.cancelled' then
    perform private.cancel_scheduled_messages(v_appt.id);
    -- No message when the patient left the waiting room, for duplicates, or after the time.
    if v_appt.status = 'cancelled' and v_appt.starts_at > now()
       and v_appt.cancellation_reason not in ('left_before_consultation', 'duplicate') then
      perform private.plan_patient_message(v_appt.clinic_id, v_appt.patient_id, 'appointment_cancellation',
        v_appt.id::text, now(), v_appt.id, null, v_appt.starts_at);
    end if;

  elsif p_event.event_type = 'session.delay_reported' then
    select * into v_session from public.doctor_sessions s where s.id = p_event.aggregate_id;
    if not found or v_session.announced_delay_minutes = 0 or v_session.status = 'closed' then
      return;
    end if;
    -- BR-Q-11: patients waiting, and confirmed patients booked within the next 3 hours.
    for v_target in
      select a.id, a.patient_id, a.starts_at
      from public.appointments a
      where a.clinic_id = v_session.clinic_id and a.doctor_id = v_session.doctor_id
        and ((a.status = 'checked_in' and exists (select 1 from public.queue_entries q
                                                   where q.appointment_id = a.id and q.session_id = v_session.id
                                                     and q.state in ('waiting', 'called')))
             or (a.status = 'confirmed' and a.starts_at between now() and now() + interval '3 hours'))
    loop
      perform private.plan_patient_message(v_session.clinic_id, v_target.patient_id, 'doctor_delay',
        format('%s:%s:%s', v_session.id, extract(epoch from v_session.delay_reported_at)::bigint, v_target.id),
        now(), v_target.id, null, v_target.starts_at, v_session.announced_delay_minutes);
    end loop;
  end if;
end;
$$;

-- "Turn approaching" (§3.2-5): once per ticket, when its position reaches the clinic setting.
create function private.plan_turn_messages()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_entry record;
begin
  for v_entry in
    select x.id, x.clinic_id, x.appointment_id, a.patient_id, a.starts_at
    from (
      select q.id, q.clinic_id, q.appointment_id, q.session_id, q.state,
             row_number() over (partition by q.session_id order by q.priority_level desc, q.sort_key, q.ticket_number) as position
      from public.queue_entries q
      join public.doctor_sessions s on s.id = q.session_id and s.status in ('planned', 'open')
      where q.state in ('waiting', 'called')) x
    join public.appointments a on a.clinic_id = x.clinic_id and a.id = x.appointment_id
    left join public.clinic_settings cs on cs.clinic_id = x.clinic_id
    where x.state = 'waiting' and x.position <= coalesce(cs.turn_approaching_positions, 2)
  loop
    perform private.plan_patient_message(v_entry.clinic_id, v_entry.patient_id, 'turn_approaching',
      v_entry.id::text, now(), v_entry.appointment_id, v_entry.id, v_entry.starts_at);
  end loop;
end;
$$;

-- Processes pending domain events (oldest first, at most 5 attempts each), then the queue.
create function private.plan_notifications(p_limit integer default 500)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event public.domain_events;
  v_count integer := 0;
begin
  for v_event in
    select * from public.domain_events e
    where e.processed_at is null and e.attempts < 5
    order by e.id
    limit p_limit
    for update skip locked
  loop
    begin
      perform private.plan_for_event(v_event);
      update public.domain_events set processed_at = now() where id = v_event.id;
      v_count := v_count + 1;
    exception when others then
      update public.domain_events set attempts = attempts + 1, last_error = left(sqlerrm, 200) where id = v_event.id;
    end;
  end loop;
  perform private.plan_turn_messages();
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Dispatcher
-- ---------------------------------------------------------------------------
create function private.has_channel_consent(p_clinic_id uuid, p_patient_id uuid, p_channel public.notification_channel)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select c.granted from public.patient_consents c
    where c.clinic_id = p_clinic_id and c.patient_id = p_patient_id
      and c.purpose = case p_channel when 'sms' then 'reminders_sms' when 'whatsapp' then 'reminders_whatsapp'
                                     when 'email' then 'reminders_email' end::public.consent_purpose
    order by c.recorded_at desc, c.id desc
    limit 1), false);
$$;

create function private.mask_recipient(p_channel public.notification_channel, p_recipient text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_channel = 'email' then left(p_recipient, 1) || '•••@' || split_part(p_recipient, '@', 2)
    else left(p_recipient, 5) || '•••••' || right(p_recipient, 2) end;
$$;

-- BR-N-06 backoff after the n-th failed attempt: 1, 5, 15, 60 minutes.
create function private.retry_delay(p_attempt integer)
returns interval
language sql
immutable
set search_path = ''
as $$
  select make_interval(mins => (array[1, 5, 15, 60])[least(greatest(p_attempt, 1), 4)]);
$$;

create function public.jobs_plan_notifications(p_job_key text, p_limit integer default 500)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_job_key(p_job_key);
  return private.plan_notifications(least(greatest(coalesce(p_limit, 500), 1), 2000));
end;
$$;

-- Claims due messages under a lease, after re-checking state, consent and address (skips are
-- recorded), and returns them rendered in the patient's locale.
create function public.jobs_claim_notifications(p_job_key text, p_limit integer default 50, p_lease_seconds integer default 120)
returns table (notification_id uuid, channel public.notification_channel, recipient text, sender text,
               subject text, body text, attempt_no integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_n         public.notifications;
  v_appt      public.appointments;
  v_patient   public.patients;
  v_clinic    public.clinics;
  v_sender    text;
  v_template  public.notification_templates;
  v_ticket    integer;
  v_entry     public.queue_state;
  v_skip      text;
  v_to        text;
  v_text      text;
  v_subject   text;
begin
  perform private.require_job_key(p_job_key);

  -- A lease that expired means the worker died mid-send: record a timeout, then retry or fail.
  for v_n in
    select * from public.notifications n where n.status = 'processing' and n.locked_until < now()
    for update skip locked
  loop
    insert into public.notification_attempts (clinic_id, notification_id, attempt_no, recipient_masked, started_at, outcome)
    values (v_n.clinic_id, v_n.id, v_n.attempt_count, v_n.recipient_masked, v_n.processing_started_at, 'timeout')
    on conflict (notification_id, attempt_no) do nothing;
    if v_n.attempt_count >= 5 then
      update public.notifications set status = 'failed', failed_at = now(), locked_until = null, last_error = 'timeout' where id = v_n.id;
    else
      update public.notifications set status = 'scheduled', locked_until = null, next_attempt_at = now() + private.retry_delay(v_n.attempt_count)
      where id = v_n.id;
    end if;
  end loop;

  for v_n in
    select * from public.notifications n
    where n.status = 'scheduled' and n.scheduled_for <= now() and (n.next_attempt_at is null or n.next_attempt_at <= now())
    order by n.scheduled_for
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
    for update skip locked
  loop
    v_skip := null;
    v_appt := null;
    if v_n.appointment_id is not null then
      select * into v_appt from public.appointments a where a.id = v_n.appointment_id;
    end if;
    -- BR-N-02: re-read the appointment or queue entry right before sending.
    if v_n.event_type in ('appointment_confirmation', 'appointment_reminder')
       and (v_appt.status is distinct from 'confirmed' or v_appt.starts_at is distinct from v_n.context_starts_at) then
      v_skip := 'stale';
    elsif v_n.event_type = 'appointment_rescheduled'
       and (v_appt.status not in ('pending', 'confirmed') or v_appt.starts_at is distinct from v_n.context_starts_at) then
      v_skip := 'stale';
    elsif v_n.event_type = 'appointment_cancellation' and v_appt.status is distinct from 'cancelled' then
      v_skip := 'stale';
    elsif v_n.event_type = 'doctor_delay' and v_appt.status not in ('confirmed', 'checked_in') then
      v_skip := 'stale';
    elsif v_n.event_type = 'turn_approaching' then
      select q.state, q.ticket_number into v_entry, v_ticket from public.queue_entries q where q.id = v_n.queue_entry_id;
      if v_entry is distinct from 'waiting' then
        v_skip := 'stale';
      end if;
    end if;

    -- BR-N-04: consent for this channel, and the address as it is now.
    select * into v_patient from public.patients p where p.clinic_id = v_n.clinic_id and p.id = v_n.patient_id;
    if v_skip is null and not private.has_channel_consent(v_n.clinic_id, v_n.patient_id, v_n.channel) then
      v_skip := 'no_consent';
    end if;
    v_to := case v_n.channel when 'email' then v_patient.email::text else v_patient.phone_e164 end;
    if v_skip is null and v_to is null then
      v_skip := 'no_address';
    end if;
    if v_skip is not null then
      update public.notifications set status = 'skipped', skip_reason = v_skip where id = v_n.id;
      continue;
    end if;

    select * into v_template from public.notification_templates t
    where t.event_type = v_n.event_type and t.channel = v_n.channel and t.locale = v_n.locale and t.is_active
      and (t.clinic_id = v_n.clinic_id or t.clinic_id is null)
    order by (t.clinic_id is null)
    limit 1;
    if not found then
      update public.notifications set status = 'skipped', skip_reason = 'no_template' where id = v_n.id;
      continue;
    end if;

    select * into v_clinic from public.clinics c where c.id = v_n.clinic_id;
    select s.sms_sender_name into v_sender from public.clinic_settings s where s.clinic_id = v_n.clinic_id;
    v_text := v_template.body;
    v_subject := v_template.subject;
    v_text := replace(v_text, '{clinic}', v_clinic.display_name);
    v_text := replace(v_text, '{date}', coalesce(to_char(v_n.context_starts_at at time zone v_clinic.timezone, 'DD/MM/YYYY'), ''));
    v_text := replace(v_text, '{time}', coalesce(to_char(v_n.context_starts_at at time zone v_clinic.timezone, 'HH24:MI'), ''));
    v_text := replace(v_text, '{ticket}', coalesce(v_ticket::text, ''));
    v_text := replace(v_text, '{delay}', coalesce(v_n.delay_minutes::text, ''));
    if v_subject is not null then
      v_subject := replace(v_subject, '{clinic}', v_clinic.display_name);
    end if;

    update public.notifications
       set status = 'processing', attempt_count = attempt_count + 1, locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 30)),
           processing_started_at = now(), template_id = v_template.id, recipient_masked = private.mask_recipient(v_n.channel, v_to)
     where id = v_n.id;
    return query select v_n.id, v_n.channel, v_to, v_sender, v_subject, v_text, v_n.attempt_count + 1;
  end loop;
end;
$$;

-- Records the provider's answer for a claimed message. Late or repeated reports are ignored.
create function public.jobs_record_attempt(
  p_job_key             text,
  p_notification_id     uuid,
  p_outcome             text,
  p_provider            text,
  p_provider_message_id text default null,
  p_error_code          text default null,
  p_retryable           boolean default false)
returns public.notification_status
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_n public.notifications;
begin
  perform private.require_job_key(p_job_key);
  if p_outcome is null or p_outcome not in ('accepted', 'rejected', 'error', 'timeout') then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'outcome';
  end if;
  select * into v_n from public.notifications n where n.id = p_notification_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if v_n.status <> 'processing' then
    return v_n.status;
  end if;

  insert into public.notification_attempts (clinic_id, notification_id, attempt_no, provider, recipient_masked, started_at, outcome, error_code)
  values (v_n.clinic_id, v_n.id, v_n.attempt_count, left(p_provider, 40), v_n.recipient_masked, v_n.processing_started_at, p_outcome, left(p_error_code, 60));

  if p_outcome = 'accepted' then
    update public.notifications
       set status = 'sent', sent_at = now(), provider = left(p_provider, 40), provider_message_id = left(p_provider_message_id, 120),
           locked_until = null, last_error = null
     where id = v_n.id;
    return 'sent';
  elsif p_outcome = 'rejected' or not coalesce(p_retryable, false) or v_n.attempt_count >= 5 then
    update public.notifications
       set status = 'failed', failed_at = now(), provider = left(p_provider, 40), locked_until = null, last_error = left(p_error_code, 200)
     where id = v_n.id;
    return 'failed';
  else
    update public.notifications
       set status = 'scheduled', locked_until = null, next_attempt_at = now() + private.retry_delay(v_n.attempt_count),
           last_error = left(p_error_code, 200)
     where id = v_n.id;
    return 'scheduled';
  end if;
end;
$$;

revoke all on function private.plan_patient_message(uuid, uuid, public.notification_event, text, timestamptz, uuid, uuid, timestamptz, integer, text) from public, anon, authenticated;
revoke all on function private.plan_reminders(uuid) from public, anon, authenticated;
revoke all on function private.cancel_scheduled_messages(uuid) from public, anon, authenticated;
revoke all on function private.plan_for_event(public.domain_events) from public, anon, authenticated;
revoke all on function private.plan_turn_messages() from public, anon, authenticated;
revoke all on function private.plan_notifications(integer) from public, anon, authenticated;
revoke all on function private.has_channel_consent(uuid, uuid, public.notification_channel) from public, anon, authenticated;
revoke all on function private.mask_recipient(public.notification_channel, text) from public, anon, authenticated;
revoke all on function private.retry_delay(integer) from public, anon, authenticated;
revoke all on function public.jobs_plan_notifications(text, integer) from public;
revoke all on function public.jobs_claim_notifications(text, integer, integer) from public;
revoke all on function public.jobs_record_attempt(text, uuid, text, text, text, text, boolean) from public;
-- Called by the worker endpoint without a session: the job key is the credential.
grant execute on function public.jobs_plan_notifications(text, integer) to anon;
grant execute on function public.jobs_claim_notifications(text, integer, integer) to anon;
grant execute on function public.jobs_record_attempt(text, uuid, text, text, text, text, boolean) to anon;

-- ---------------------------------------------------------------------------
-- Scheduling (where available): plan every minute in SQL; ask the worker endpoint to dispatch
-- every minute through pg_net, signed with HMAC (secret and URL in Supabase Vault).
-- ---------------------------------------------------------------------------
create function private.call_dispatch()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_secret text;
  v_url    text;
  v_ts     text := extract(epoch from now())::bigint::text;
  v_body   text := '{}';
begin
  select s.decrypted_secret into v_secret from vault.decrypted_secrets s where s.name = 'smartcabin_jobs_secret';
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'smartcabin_app_url';
  if v_secret is null or v_url is null then
    return;
  end if;
  perform net.http_post(
    url := v_url || '/api/internal/jobs/dispatch',
    body := v_body::jsonb,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-smartcabin-timestamp', v_ts,
      'x-smartcabin-signature', encode(extensions.hmac(v_ts || '.' || v_body, v_secret, 'sha256'), 'hex')));
end;
$$;
revoke all on function private.call_dispatch() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule('smartcabin-plan-notifications', '* * * * *', 'select private.plan_notifications()');
    if exists (select 1 from pg_namespace where nspname = 'net') and exists (select 1 from pg_namespace where nspname = 'vault') then
      perform cron.schedule('smartcabin-dispatch-notifications', '* * * * *', 'select private.call_dispatch()');
    end if;
  end if;
end;
$$;
