-- =============================================================================
-- 0027 billing (module 10): invoices, invoice items, payments with receipts, revenue summary.
-- BUSINESS_RULES §5 (BR-F-01…09), DOMAIN_MODEL BC9, API_SPECIFICATION BC9, MD-16, MD-17.
--
-- Write tier C: no API role writes these tables. Every change goes through the commands below,
-- which authorize first (private.require_invoice_lock), then lock the invoice row. Lock order:
-- idempotency key (advisory) → invoice row → its payments → counters.
-- Defense in depth: triggers keep an issued invoice immutable (BR-F-02), items editable only in
-- draft, payments never deleted, and the invoice's paid amount and status derived from payments
-- (BR-F-03). A check keeps amount_paid ≤ total even if a command were wrong (BR-F-04).
-- VAT, legal mentions and credit notes wait for an accountant (BR-F-09): not modeled here.
-- =============================================================================

create type public.invoice_status as enum ('draft', 'issued', 'partially_paid', 'paid', 'void');
create type public.payment_method as enum ('cash', 'card', 'bank_transfer', 'cheque', 'other');
create type public.payment_status as enum ('recorded', 'reversed');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.invoices (
  id               uuid primary key default gen_random_uuid(),
  clinic_id        uuid not null references public.clinics (id),
  patient_id       uuid not null,
  appointment_id   uuid,
  status           public.invoice_status not null default 'draft',
  fiscal_year      smallint,
  sequence_no      integer,
  invoice_number   text,
  issued_at        timestamptz,
  issued_by        uuid references auth.users (id),
  currency         text not null default 'MAD',
  subtotal_mad     numeric(12, 2) not null default 0,
  discount_mad     numeric(12, 2) not null default 0,
  total_mad        numeric(12, 2) not null default 0,
  amount_paid_mad  numeric(12, 2) not null default 0,
  bill_to_name     text not null,
  clinic_snapshot  jsonb,
  notes            text,
  void_reason      text,
  voided_at        timestamptz,
  voided_by        uuid references auth.users (id),
  created_by       uuid not null references auth.users (id),
  idempotency_key  text,
  version          integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint invoices_clinic_id_id_key unique (clinic_id, id),
  constraint invoices_number_key unique (clinic_id, fiscal_year, sequence_no),
  constraint invoices_invoice_number_key unique (clinic_id, invoice_number),
  constraint invoices_idempotency_key unique (clinic_id, idempotency_key),
  constraint invoices_patient_fkey foreign key (clinic_id, patient_id) references public.patients (clinic_id, id),
  constraint invoices_appointment_fkey foreign key (clinic_id, appointment_id) references public.appointments (clinic_id, id),
  constraint invoices_currency check (currency = 'MAD'),
  -- BR-F-01: drafts have no number; an issued invoice has all of it.
  constraint invoices_number_coherent check (
    (status = 'draft') = (fiscal_year is null) and (fiscal_year is null) = (sequence_no is null)
    and (sequence_no is null) = (invoice_number is null) and (invoice_number is null) = (issued_at is null)
    and (issued_at is null) = (clinic_snapshot is null)),
  constraint invoices_sequence check (sequence_no is null or sequence_no >= 1),
  constraint invoices_amounts check (subtotal_mad >= 0 and discount_mad >= 0 and total_mad = subtotal_mad - discount_mad and total_mad >= 0),
  constraint invoices_paid_range check (amount_paid_mad >= 0 and amount_paid_mad <= total_mad),
  -- BR-F-03: status and paid amount agree.
  constraint invoices_status_paid_coherent check (case status
    when 'draft' then amount_paid_mad = 0
    when 'issued' then amount_paid_mad = 0
    when 'partially_paid' then amount_paid_mad > 0 and amount_paid_mad < total_mad
    when 'paid' then amount_paid_mad = total_mad and total_mad > 0
    when 'void' then amount_paid_mad = 0 end),
  constraint invoices_void_coherent check (
    (status = 'void') = (voided_at is not null) and (voided_at is null) = (void_reason is null)),
  constraint invoices_bill_to_length check (char_length(btrim(bill_to_name)) between 1 and 200),
  constraint invoices_notes_length check (notes is null or char_length(notes) <= 500),
  constraint invoices_void_reason_length check (void_reason is null or char_length(btrim(void_reason)) between 3 and 300),
  constraint invoices_idempotency_length check (idempotency_key is null or char_length(idempotency_key) between 8 and 100),
  constraint invoices_version check (version >= 1)
);
comment on table public.invoices is 'BC9. Command tier: written only by billing commands. Immutable once issued (BR-F-02).';

-- One open invoice per appointment: a second one needs the first voided.
create unique index invoices_one_open_per_appointment on public.invoices (clinic_id, appointment_id)
  where appointment_id is not null and status <> 'void';
create index invoices_clinic_created_idx on public.invoices (clinic_id, created_at desc);
create index invoices_clinic_issued_idx on public.invoices (clinic_id, issued_at desc) where issued_at is not null;
create index invoices_patient_idx on public.invoices (clinic_id, patient_id);

create table public.invoice_items (
  id              uuid primary key default gen_random_uuid(),
  clinic_id       uuid not null references public.clinics (id),
  invoice_id      uuid not null,
  service_id      uuid,
  description     text not null,
  quantity        numeric(8, 2) not null,
  unit_price_mad  numeric(12, 2) not null,
  -- BR-F-08: rounding half-up at line level (round() on numeric rounds half away from zero).
  line_total_mad  numeric(12, 2) generated always as (round(quantity * unit_price_mad, 2)) stored,
  position        smallint not null,
  created_at      timestamptz not null default now(),
  constraint invoice_items_invoice_fkey foreign key (clinic_id, invoice_id) references public.invoices (clinic_id, id) on delete cascade,
  constraint invoice_items_service_fkey foreign key (clinic_id, service_id) references public.services (clinic_id, id),
  constraint invoice_items_position_key unique (invoice_id, position),
  constraint invoice_items_position check (position between 1 and 50),
  constraint invoice_items_quantity check (quantity > 0 and quantity <= 999),
  constraint invoice_items_price check (unit_price_mad >= 0 and unit_price_mad <= 1000000),
  constraint invoice_items_description_length check (char_length(btrim(description)) between 1 and 200)
);
create index invoice_items_service_idx on public.invoice_items (clinic_id, service_id) where service_id is not null;

create table public.payments (
  id               uuid primary key default gen_random_uuid(),
  clinic_id        uuid not null references public.clinics (id),
  invoice_id       uuid not null,
  amount_mad       numeric(12, 2) not null,
  method           public.payment_method not null,
  paid_at          timestamptz not null default now(),
  reference        text,
  receipt_year     smallint not null,
  receipt_seq      integer not null,
  receipt_number   text not null,
  received_by      uuid not null references auth.users (id),
  status           public.payment_status not null default 'recorded',
  reversed_at      timestamptz,
  reversed_by      uuid references auth.users (id),
  reversal_reason  text,
  idempotency_key  text,
  created_at       timestamptz not null default now(),
  constraint payments_clinic_id_id_key unique (clinic_id, id),
  constraint payments_invoice_fkey foreign key (clinic_id, invoice_id) references public.invoices (clinic_id, id),
  constraint payments_receipt_number_key unique (clinic_id, receipt_number),
  constraint payments_receipt_seq_key unique (clinic_id, receipt_year, receipt_seq),
  constraint payments_idempotency_key unique (clinic_id, idempotency_key),
  constraint payments_amount check (amount_mad > 0),
  constraint payments_receipt_seq check (receipt_seq >= 1),
  constraint payments_reversal_coherent check (
    (status = 'reversed') = (reversed_at is not null) and (reversed_at is null) = (reversed_by is null)
    and (reversed_by is null) = (reversal_reason is null)),
  constraint payments_reference_length check (reference is null or char_length(reference) <= 100),
  constraint payments_reason_length check (reversal_reason is null or char_length(btrim(reversal_reason)) between 3 and 300),
  constraint payments_idempotency_length check (idempotency_key is null or char_length(idempotency_key) between 8 and 100)
);
comment on table public.payments is 'BC9. Never deleted; corrected by reversal (BR-F-05). Each has a gapless receipt number (BR-F-07).';
create index payments_invoice_idx on public.payments (invoice_id, paid_at);
create index payments_clinic_paid_idx on public.payments (clinic_id, paid_at);
create index payments_clinic_reversed_idx on public.payments (clinic_id, reversed_at) where reversed_at is not null;

-- ---------------------------------------------------------------------------
-- Guards (defense in depth: they also apply to postgres and to the commands themselves)
-- ---------------------------------------------------------------------------

-- BR-F-02: an issued invoice changes only through payments (status, paid amount) or voiding.
create function private.invoices_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_mutable constant text[] := array['status', 'amount_paid_mad', 'void_reason', 'voided_at', 'voided_by', 'updated_at', 'version'];
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception using errcode = 'P0001', message = 'INVOICE_IMMUTABLE', detail = 'issued invoices are never deleted';
    end if;
    return old;
  end if;
  if new.id <> old.id or new.created_by <> old.created_by or new.created_at <> old.created_at then
    raise exception using errcode = 'P0001', message = 'INVOICE_IMMUTABLE', detail = 'identity columns';
  end if;
  if old.status = 'void' then
    raise exception using errcode = 'P0001', message = 'INVOICE_IMMUTABLE', detail = 'void invoice';
  end if;
  if old.status = 'draft' then
    if new.status not in ('draft', 'issued') then
      raise exception using errcode = 'P0001', message = 'INVOICE_INVALID_TRANSITION', detail = format('draft -> %s', new.status);
    end if;
    return new;
  end if;
  if new.status = 'draft' then
    raise exception using errcode = 'P0001', message = 'INVOICE_INVALID_TRANSITION', detail = format('%s -> draft', old.status);
  end if;
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    raise exception using errcode = 'P0001', message = 'INVOICE_IMMUTABLE', detail = 'issued invoice';
  end if;
  return new;
end;
$$;
create trigger invoices_guard
  before update or delete on public.invoices
  for each row execute function private.invoices_guard();
create trigger invoices_set_updated_at
  before update on public.invoices
  for each row execute function private.set_updated_at();
create trigger invoices_tenant_immutable
  before update on public.invoices
  for each row execute function private.forbid_clinic_id_change();

-- Items exist only while their invoice is a draft (they are frozen with it at issue).
create function private.invoice_items_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status public.invoice_status;
begin
  select i.status into v_status from public.invoices i where i.id = coalesce(new.invoice_id, old.invoice_id);
  -- Deleting a draft cascades to its items after the invoice row is gone: nothing to protect.
  if tg_op = 'DELETE' and v_status is null then
    return old;
  end if;
  if tg_op = 'UPDATE' and new.invoice_id <> old.invoice_id then
    raise exception using errcode = 'P0001', message = 'INVOICE_IMMUTABLE', detail = 'item moved';
  end if;
  if v_status is distinct from 'draft' then
    raise exception using errcode = 'P0001', message = 'INVOICE_IMMUTABLE', detail = 'items of an issued invoice';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger invoice_items_guard
  before insert or update or delete on public.invoice_items
  for each row execute function private.invoice_items_guard();
create trigger invoice_items_tenant_immutable
  before update on public.invoice_items
  for each row execute function private.forbid_clinic_id_change();

-- BR-F-05: payments are never deleted; the only change is recorded → reversed.
create function private.payments_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status public.invoice_status;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'APPEND_ONLY', detail = 'payments are reversed, never deleted';
  end if;
  if tg_op = 'INSERT' then
    select i.status into v_status from public.invoices i where i.id = new.invoice_id;
    if v_status is null or v_status not in ('issued', 'partially_paid') then
      raise exception using errcode = 'P0001', message = 'INVOICE_INVALID_TRANSITION', detail = 'payment on a non-payable invoice';
    end if;
    if new.status <> 'recorded' then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'a payment starts recorded';
    end if;
    return new;
  end if;
  if old.status <> 'recorded' or new.status <> 'reversed'
     or (to_jsonb(new) - array['status', 'reversed_at', 'reversed_by', 'reversal_reason'])
        is distinct from (to_jsonb(old) - array['status', 'reversed_at', 'reversed_by', 'reversal_reason']) then
    raise exception using errcode = 'P0001', message = 'APPEND_ONLY', detail = 'only recorded -> reversed';
  end if;
  return new;
end;
$$;
create trigger payments_guard
  before insert or update or delete on public.payments
  for each row execute function private.payments_guard();
create trigger payments_tenant_immutable
  before update on public.payments
  for each row execute function private.forbid_clinic_id_change();

-- BR-F-03: the invoice's paid amount and status follow its recorded payments. The commands hold
-- the invoice row lock already; the check constraints reject any sum above the total.
create function private.sync_invoice_payments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_paid numeric(12, 2);
begin
  select coalesce(sum(p.amount_mad) filter (where p.status = 'recorded'), 0) into v_paid
  from public.payments p where p.invoice_id = new.invoice_id;
  update public.invoices i
     set amount_paid_mad = v_paid,
         status = case when v_paid = 0 then 'issued'
                       when v_paid < i.total_mad then 'partially_paid'
                       else 'paid' end::public.invoice_status,
         version = i.version + 1
   where i.id = new.invoice_id;
  return null;
end;
$$;
revoke all on function private.sync_invoice_payments() from public, anon, authenticated;
create trigger payments_sync_invoice
  after insert or update on public.payments
  for each row execute function private.sync_invoice_payments();

-- Q1: every billing change is audited (the audit trigger of migration 0010).
create trigger invoices_audit
  after insert or update or delete on public.invoices
  for each row execute function private.audit_row_change();
create trigger payments_audit
  after insert or update or delete on public.payments
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------------
-- RLS: read with invoices.view (owner, admin, receptionist, accountant). Doctors see nothing.
-- ---------------------------------------------------------------------------
alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;
alter table public.payments enable row level security;

grant select on public.invoices to authenticated;
grant select on public.invoice_items to authenticated;
grant select on public.payments to authenticated;

create policy invoices_select on public.invoices for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('invoices.view')));
create policy invoice_items_select on public.invoice_items for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('invoices.view')));
create policy payments_select on public.payments for select to authenticated
  using (clinic_id in (select private.clinics_with_permission('invoices.view')));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Authorize first (NOT_FOUND across tenants, then the permission), then lock the invoice row.
create function private.require_invoice_lock(p_invoice_id uuid, p_permission text, p_expected_version integer)
returns public.invoices
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid;
  v_invoice   public.invoices;
begin
  select i.clinic_id into v_clinic_id from public.invoices i where i.id = p_invoice_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.require_clinic_access(v_clinic_id);
  perform private.require_permission(v_clinic_id, p_permission);

  select * into v_invoice from public.invoices i where i.id = p_invoice_id for update;
  if p_expected_version is not null and p_expected_version <> v_invoice.version then
    raise exception using errcode = 'P0001', message = 'STALE_STATE',
      detail = format('expected version %s, current %s', p_expected_version, v_invoice.version);
  end if;
  return v_invoice;
end;
$$;
revoke all on function private.require_invoice_lock(uuid, text, integer) from public, anon, authenticated;

-- Money input: positive or zero as asked, at most two decimals (BR-F-08).
create function private.assert_money(p_value numeric, p_field text, p_allow_zero boolean, p_max numeric default 1000000)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value is null or p_value < 0 or (p_value = 0 and not p_allow_zero) or p_value > p_max or p_value <> round(p_value, 2) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = p_field;
  end if;
end;
$$;
revoke all on function private.assert_money(numeric, text, boolean, numeric) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- create_invoice_draft — from an appointment (price snapshot BR-B-11) or for a patient.
-- ---------------------------------------------------------------------------
create function public.create_invoice_draft(
  p_appointment_id  uuid default null,
  p_patient_id      uuid default null,
  p_idempotency_key text default null)
returns table (invoice_id uuid, version integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_clinic_id  uuid;
  v_appt       public.appointments;
  v_patient    public.patients;
  v_existing   public.invoices;
  v_locale     text;
  v_service    text;
  v_invoice_id uuid;
begin
  if p_appointment_id is not null then
    select a.clinic_id into v_clinic_id from public.appointments a where a.id = p_appointment_id;
  elsif p_patient_id is not null then
    select p.clinic_id into v_clinic_id from public.patients p where p.id = p_patient_id;
  else
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'appointment or patient required';
  end if;
  if v_clinic_id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.require_clinic_access(v_clinic_id);
  perform private.require_permission(v_clinic_id, 'invoices.create');

  -- A retried request with the same key returns the first draft (API_SPECIFICATION §4.1).
  if p_idempotency_key is not null then
    if char_length(p_idempotency_key) not between 8 and 100 then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'idempotency key length';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(v_clinic_id::text || ':invoice:' || p_idempotency_key, 0));
    select * into v_existing from public.invoices i where i.clinic_id = v_clinic_id and i.idempotency_key = p_idempotency_key;
    if found then
      if v_existing.appointment_id is distinct from p_appointment_id
         or (p_patient_id is not null and v_existing.patient_id <> p_patient_id) then
        raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
      end if;
      return query select v_existing.id, v_existing.version;
      return;
    end if;
  end if;

  if p_appointment_id is not null then
    -- Serializes "one open invoice per appointment" with other drafts for it.
    select * into v_appt from public.appointments a where a.id = p_appointment_id for update;
    if p_patient_id is not null and p_patient_id <> v_appt.patient_id then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'patient does not match the appointment';
    end if;
    if v_appt.status in ('pending', 'cancelled') then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'appointment not billable';
    end if;
    if exists (select 1 from public.invoices i
               where i.clinic_id = v_clinic_id and i.appointment_id = p_appointment_id and i.status <> 'void') then
      raise exception using errcode = 'P0001', message = 'DUPLICATE', detail = 'open invoice for this appointment';
    end if;
  end if;

  select * into v_patient from public.patients p
  where p.clinic_id = v_clinic_id and p.id = coalesce(v_appt.patient_id, p_patient_id);
  if v_patient.status = 'merged' then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'merged patient';
  end if;

  insert into public.invoices (clinic_id, patient_id, appointment_id, bill_to_name, created_by, idempotency_key,
                               subtotal_mad, total_mad)
  values (v_clinic_id, v_patient.id, p_appointment_id, btrim(v_patient.first_name || ' ' || v_patient.last_name),
          auth.uid(), p_idempotency_key, coalesce(v_appt.price_mad, 0), coalesce(v_appt.price_mad, 0))
  returning id into v_invoice_id;

  if p_appointment_id is not null then
    select c.default_locale into v_locale from public.clinics c where c.id = v_clinic_id;
    select case when v_locale = 'ar' and nullif(btrim(s.name_ar), '') is not null then s.name_ar else s.name_fr end
      into v_service
    from public.services s where s.clinic_id = v_clinic_id and s.id = v_appt.service_id;
    insert into public.invoice_items (clinic_id, invoice_id, service_id, description, quantity, unit_price_mad, position)
    values (v_clinic_id, v_invoice_id, v_appt.service_id, left(coalesce(v_service, '—'), 200), 1, v_appt.price_mad, 1);
  end if;

  return query select v_invoice_id, 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- update_invoice_draft — replaces the lines; totals are computed here, never sent.
-- p_items: [{"service_id": uuid|null, "description": text, "quantity": number, "unit_price_mad": number}]
-- ---------------------------------------------------------------------------
create function public.update_invoice_draft(
  p_invoice_id       uuid,
  p_expected_version integer,
  p_items            jsonb,
  p_discount_mad     numeric default 0,
  p_notes            text default null)
returns table (invoice_id uuid, version integer, total_mad numeric)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_invoice  public.invoices := private.require_invoice_lock(p_invoice_id, 'invoices.create', p_expected_version);
  v_item     jsonb;
  v_pos      integer := 0;
  v_service  uuid;
  v_desc     text;
  v_qty      numeric;
  v_price    numeric;
  v_subtotal numeric;
begin
  if v_invoice.status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'INVOICE_IMMUTABLE';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 50 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'items';
  end if;
  perform private.assert_money(coalesce(p_discount_mad, 0), 'discount_mad', true);
  if p_notes is not null and char_length(p_notes) > 500 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'notes';
  end if;

  delete from public.invoice_items it where it.invoice_id = p_invoice_id;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_pos := v_pos + 1;
    begin
      v_service := nullif(v_item ->> 'service_id', '')::uuid;
      v_desc := btrim(v_item ->> 'description');
      v_qty := (v_item ->> 'quantity')::numeric;
      v_price := (v_item ->> 'unit_price_mad')::numeric;
    exception when others then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = format('item %s', v_pos);
    end;
    if jsonb_typeof(v_item) <> 'object' or v_desc is null or char_length(v_desc) not between 1 and 200
       or v_qty is null or v_qty <= 0 or v_qty > 999 or v_qty <> round(v_qty, 2) then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = format('item %s', v_pos);
    end if;
    perform private.assert_money(v_price, format('item %s price', v_pos), true);
    if v_service is not null and not exists (
        select 1 from public.services s where s.clinic_id = v_invoice.clinic_id and s.id = v_service) then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = format('item %s service', v_pos);
    end if;
    insert into public.invoice_items (clinic_id, invoice_id, service_id, description, quantity, unit_price_mad, position)
    values (v_invoice.clinic_id, p_invoice_id, v_service, v_desc, v_qty, v_price, v_pos);
  end loop;

  select coalesce(sum(it.line_total_mad), 0) into v_subtotal from public.invoice_items it where it.invoice_id = p_invoice_id;
  -- An invoice stays far below numeric(12,2); larger sums are input errors, not overflows.
  if v_subtotal > 10000000 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'total too large';
  end if;
  if coalesce(p_discount_mad, 0) > v_subtotal then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'discount above subtotal';
  end if;
  update public.invoices i
     set subtotal_mad = v_subtotal, discount_mad = coalesce(p_discount_mad, 0),
         total_mad = v_subtotal - coalesce(p_discount_mad, 0),
         notes = nullif(btrim(p_notes), ''), version = i.version + 1
   where i.id = p_invoice_id;
  return query select i.id, i.version, i.total_mad from public.invoices i where i.id = p_invoice_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- discard_invoice_draft — drafts only (no number was taken, so no gap).
-- ---------------------------------------------------------------------------
create function public.discard_invoice_draft(p_invoice_id uuid, p_expected_version integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_invoice public.invoices := private.require_invoice_lock(p_invoice_id, 'invoices.create', p_expected_version);
begin
  if v_invoice.status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'INVOICE_IMMUTABLE';
  end if;
  delete from public.invoices i where i.id = p_invoice_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- issue_invoice — BR-F-01: gapless number from clinic_counters in this transaction.
-- ---------------------------------------------------------------------------
create function public.issue_invoice(p_invoice_id uuid, p_expected_version integer)
returns table (invoice_id uuid, version integer, invoice_number text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_invoice public.invoices := private.require_invoice_lock(p_invoice_id, 'invoices.issue', p_expected_version);
  v_clinic  public.clinics;
  v_patient public.patients;
  v_year    smallint;
  v_seq     bigint;
  v_number  text;
begin
  if v_invoice.status <> 'draft' then
    raise exception using errcode = 'P0001', message = 'INVOICE_INVALID_TRANSITION', detail = 'already issued';
  end if;
  if v_invoice.total_mad <= 0 or not exists (select 1 from public.invoice_items it where it.invoice_id = p_invoice_id) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'empty invoice';
  end if;
  select * into v_clinic from public.clinics c where c.id = v_invoice.clinic_id;
  select * into v_patient from public.patients p where p.clinic_id = v_invoice.clinic_id and p.id = v_invoice.patient_id;

  v_year := extract(year from (now() at time zone v_clinic.timezone))::smallint;
  v_seq := private.next_counter_value(v_invoice.clinic_id, 'invoice:' || v_year);
  v_number := v_year || '-' || lpad(v_seq::text, 6, '0');

  update public.invoices i
     set status = 'issued', fiscal_year = v_year, sequence_no = v_seq, invoice_number = v_number,
         issued_at = now(), issued_by = auth.uid(),
         bill_to_name = btrim(v_patient.first_name || ' ' || v_patient.last_name),
         clinic_snapshot = jsonb_build_object(
           'display_name', v_clinic.display_name, 'legal_name', v_clinic.legal_name, 'ice', v_clinic.ice,
           'address_line', v_clinic.address_line, 'city', v_clinic.city,
           'phone_e164', v_clinic.phone_e164, 'email', v_clinic.email::text),
         version = i.version + 1
   where i.id = p_invoice_id;
  perform private.emit_event(v_invoice.clinic_id, 'invoice', p_invoice_id, 'invoice.issued',
    jsonb_build_object('total_mad', v_invoice.total_mad));
  return query select i.id, i.version, i.invoice_number from public.invoices i where i.id = p_invoice_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- void_invoice — BR-F-06: no recorded payment; the number is kept (no gap).
-- ---------------------------------------------------------------------------
create function public.void_invoice(p_invoice_id uuid, p_expected_version integer, p_reason text)
returns table (invoice_id uuid, version integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_invoice public.invoices := private.require_invoice_lock(p_invoice_id, 'invoices.void', p_expected_version);
begin
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 300 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'reason';
  end if;
  if v_invoice.status <> 'issued' then
    raise exception using errcode = 'P0001', message = 'INVOICE_INVALID_TRANSITION',
      detail = case when v_invoice.status = 'draft' then 'discard a draft instead' else 'has payments or is void' end;
  end if;
  update public.invoices i
     set status = 'void', void_reason = btrim(p_reason), voided_at = now(), voided_by = auth.uid(), version = i.version + 1
   where i.id = p_invoice_id;
  perform private.emit_event(v_invoice.clinic_id, 'invoice', p_invoice_id, 'invoice.voided');
  return query select i.id, i.version from public.invoices i where i.id = p_invoice_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- record_payment — BR-F-04 (0 < amount ≤ balance), BR-F-07 (gapless receipt number).
-- ---------------------------------------------------------------------------
create function public.record_payment(
  p_invoice_id      uuid,
  p_amount_mad      numeric,
  p_method          public.payment_method,
  p_reference       text default null,
  p_idempotency_key text default null)
returns table (payment_id uuid, receipt_number text, invoice_status public.invoice_status, amount_paid_mad numeric, version integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_clinic_id uuid;
  v_invoice   public.invoices;
  v_existing  public.payments;
  v_tz        text;
  v_year      smallint;
  v_seq       bigint;
  v_receipt   text;
  v_payment   uuid;
begin
  select i.clinic_id into v_clinic_id from public.invoices i where i.id = p_invoice_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.require_clinic_access(v_clinic_id);
  perform private.require_permission(v_clinic_id, 'payments.record');

  if p_idempotency_key is not null then
    if char_length(p_idempotency_key) not between 8 and 100 then
      raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'idempotency key length';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(v_clinic_id::text || ':payment:' || p_idempotency_key, 0));
    select * into v_existing from public.payments p where p.clinic_id = v_clinic_id and p.idempotency_key = p_idempotency_key;
    if found then
      if v_existing.invoice_id <> p_invoice_id or v_existing.amount_mad <> p_amount_mad or v_existing.method <> p_method then
        raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_REUSED';
      end if;
      return query select v_existing.id, v_existing.receipt_number, i.status, i.amount_paid_mad, i.version
                   from public.invoices i where i.id = p_invoice_id;
      return;
    end if;
  end if;

  v_invoice := private.require_invoice_lock(p_invoice_id, 'payments.record', null);
  perform private.assert_money(p_amount_mad, 'amount_mad', false, 10000000);
  if p_method is null then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'method';
  end if;
  if p_reference is not null and char_length(p_reference) > 100 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'reference';
  end if;
  if v_invoice.status in ('draft', 'void') then
    raise exception using errcode = 'P0001', message = 'INVOICE_INVALID_TRANSITION', detail = 'invoice not payable';
  end if;
  if p_amount_mad > v_invoice.total_mad - v_invoice.amount_paid_mad then
    raise exception using errcode = 'P0001', message = 'PAYMENT_EXCEEDS_BALANCE',
      detail = format('balance %s', v_invoice.total_mad - v_invoice.amount_paid_mad);
  end if;

  select c.timezone into v_tz from public.clinics c where c.id = v_clinic_id;
  v_year := extract(year from (now() at time zone v_tz))::smallint;
  v_seq := private.next_counter_value(v_clinic_id, 'receipt:' || v_year);
  v_receipt := 'R' || v_year || '-' || lpad(v_seq::text, 6, '0');

  insert into public.payments (clinic_id, invoice_id, amount_mad, method, reference, receipt_year, receipt_seq,
                               receipt_number, received_by, idempotency_key)
  values (v_clinic_id, p_invoice_id, p_amount_mad, p_method, nullif(btrim(p_reference), ''), v_year, v_seq,
          v_receipt, auth.uid(), p_idempotency_key)
  returning id into v_payment;
  perform private.emit_event(v_clinic_id, 'payment', v_payment, 'payment.recorded',
    jsonb_build_object('invoice_id', p_invoice_id, 'amount_mad', p_amount_mad));
  return query select v_payment, v_receipt, i.status, i.amount_paid_mad, i.version from public.invoices i where i.id = p_invoice_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- reverse_payment — BR-F-05: with a reason; the invoice status is recomputed by trigger.
-- ---------------------------------------------------------------------------
create function public.reverse_payment(p_payment_id uuid, p_reason text)
returns table (invoice_id uuid, invoice_status public.invoice_status, amount_paid_mad numeric, version integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_invoice_id uuid;
  v_invoice    public.invoices;
  v_payment    public.payments;
begin
  select p.invoice_id into v_invoice_id from public.payments p where p.id = p_payment_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_invoice := private.require_invoice_lock(v_invoice_id, 'payments.reverse', null);
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 300 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'reason';
  end if;
  select * into v_payment from public.payments p where p.id = p_payment_id for update;
  if v_payment.status <> 'recorded' then
    raise exception using errcode = 'P0001', message = 'INVOICE_INVALID_TRANSITION', detail = 'payment already reversed';
  end if;
  update public.payments p
     set status = 'reversed', reversed_at = now(), reversed_by = auth.uid(), reversal_reason = btrim(p_reason)
   where p.id = p_payment_id;
  perform private.emit_event(v_invoice.clinic_id, 'payment', p_payment_id, 'payment.reversed',
    jsonb_build_object('invoice_id', v_invoice_id, 'amount_mad', v_payment.amount_mad));
  return query select i.id, i.status, i.amount_paid_mad, i.version from public.invoices i where i.id = v_invoice_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- revenue_summary — K7 (BUSINESS_RULES §8), per local day in the clinic's time zone:
-- invoiced = totals of invoices issued that day (a later void is counted on its own day);
-- collected = payments received that day; reversed = reversals made that day;
-- net = collected − reversed. Past days never change when a later correction is made.
-- ---------------------------------------------------------------------------
create function public.revenue_summary(p_clinic_id uuid, p_from date, p_to date)
returns table (
  day date, invoices_issued integer, invoiced_mad numeric, invoices_voided integer, voided_mad numeric,
  payments_count integer, collected_mad numeric, reversed_mad numeric, net_mad numeric, by_method jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tz text;
begin
  perform private.require_clinic_access(p_clinic_id);
  perform private.require_permission(p_clinic_id, 'billing.reports');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception using errcode = 'P0001', message = 'VALIDATION_FAILED', detail = 'period';
  end if;
  select c.timezone into v_tz from public.clinics c where c.id = p_clinic_id;

  return query
  with days as (
    select d::date as day from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as d
  ), issued as (
    select (i.issued_at at time zone v_tz)::date as day, count(*)::integer as n, sum(i.total_mad) as amount
    from public.invoices i
    where i.clinic_id = p_clinic_id and i.issued_at is not null
      and (i.issued_at at time zone v_tz)::date between p_from and p_to
    group by 1
  ), voided as (
    select (i.voided_at at time zone v_tz)::date as day, count(*)::integer as n, sum(i.total_mad) as amount
    from public.invoices i
    where i.clinic_id = p_clinic_id and i.voided_at is not null
      and (i.voided_at at time zone v_tz)::date between p_from and p_to
    group by 1
  ), moves as (
    select (p.paid_at at time zone v_tz)::date as day, p.method, p.amount_mad as collected, 0::numeric as reversed, 1 as n
    from public.payments p
    where p.clinic_id = p_clinic_id and (p.paid_at at time zone v_tz)::date between p_from and p_to
    union all
    select (p.reversed_at at time zone v_tz)::date, p.method, 0, p.amount_mad, 0
    from public.payments p
    where p.clinic_id = p_clinic_id and p.reversed_at is not null
      and (p.reversed_at at time zone v_tz)::date between p_from and p_to
  ), per_method as (
    select m.day, m.method, sum(m.collected) as collected, sum(m.reversed) as reversed, sum(m.n)::integer as n
    from moves m group by 1, 2
  ), paid as (
    select pm.day, sum(pm.n)::integer as n, sum(pm.collected) as collected, sum(pm.reversed) as reversed,
           jsonb_object_agg(pm.method::text, pm.collected - pm.reversed) as by_method
    from per_method pm group by 1
  )
  select d.day,
         coalesce(iss.n, 0), coalesce(iss.amount, 0)::numeric,
         coalesce(v.n, 0), coalesce(v.amount, 0)::numeric,
         coalesce(pd.n, 0), coalesce(pd.collected, 0)::numeric, coalesce(pd.reversed, 0)::numeric,
         (coalesce(pd.collected, 0) - coalesce(pd.reversed, 0))::numeric,
         coalesce(pd.by_method, '{}'::jsonb)
  from days d
  left join issued iss on iss.day = d.day
  left join voided v on v.day = d.day
  left join paid pd on pd.day = d.day
  order by d.day;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function public.create_invoice_draft(uuid, uuid, text) from public, anon;
revoke all on function public.update_invoice_draft(uuid, integer, jsonb, numeric, text) from public, anon;
revoke all on function public.discard_invoice_draft(uuid, integer) from public, anon;
revoke all on function public.issue_invoice(uuid, integer) from public, anon;
revoke all on function public.void_invoice(uuid, integer, text) from public, anon;
revoke all on function public.record_payment(uuid, numeric, public.payment_method, text, text) from public, anon;
revoke all on function public.reverse_payment(uuid, text) from public, anon;
revoke all on function public.revenue_summary(uuid, date, date) from public, anon;
grant execute on function public.create_invoice_draft(uuid, uuid, text) to authenticated;
grant execute on function public.update_invoice_draft(uuid, integer, jsonb, numeric, text) to authenticated;
grant execute on function public.discard_invoice_draft(uuid, integer) to authenticated;
grant execute on function public.issue_invoice(uuid, integer) to authenticated;
grant execute on function public.void_invoice(uuid, integer, text) to authenticated;
grant execute on function public.record_payment(uuid, numeric, public.payment_method, text, text) to authenticated;
grant execute on function public.reverse_payment(uuid, text) to authenticated;
grant execute on function public.revenue_summary(uuid, date, date) to authenticated;
