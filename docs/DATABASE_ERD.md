# SmartClinic — Database Entity Relationship Diagrams

| | |
| --- | --- |
| Status | **Draft for review** (system modeling phase). No migration exists yet |
| Date | 2026-11-10 |
| Related | [DOMAIN_MODEL.md](DOMAIN_MODEL.md) §6 (semantics, constraints, lifecycle) · [SECURITY_MODEL.md](SECURITY_MODEL.md) (RLS) |

## How to read these diagrams

- **§1 is the overview:** every entity and relationship, without columns.
- **§2–§9 detail one bounded context each**, with column types and keys. They repeat a few entities from neighboring contexts (with key columns only) so each diagram stands alone.
- Keys: `PK` primary key, `FK` foreign key, `UK` part of a unique constraint.
- **Composite tenant foreign keys** are shown as their individual columns marked `FK`. For example, `appointments.clinic_id` and `appointments.doctor_id` together reference `doctors (clinic_id, id)`. Every tenant-owned table has `unique (clinic_id, id)`.
- **Column types:**
  - `money` here means `numeric(12,2)` amounts in MAD. It is not PostgreSQL's `money` type, which will not be used.
  - `int_array` means `int[]`.
  - `text_array` means `text[]`.
- `auth_users` stands for Supabase's `auth.users`.
- Timestamps `created_at` and `updated_at` are omitted where they add nothing.

---

## 1. Overview

```mermaid
erDiagram
    auth_users ||--|| user_profiles : "has profile"
    auth_users ||--o| platform_admins : "may be"
    auth_users ||--o{ clinic_members : "member through"
    auth_users ||--o{ patient_accounts : "portal access through"
    auth_users ||--o{ legal_acceptances : accepts

    permissions ||--o{ role_permissions : "granted by"

    clinics ||--|| clinic_settings : "configured by"
    clinics ||--o{ clinic_members : has
    clinics ||--o{ clinic_invitations : issues
    clinics ||--o{ clinic_closures : "closed on"
    clinics ||--o{ clinic_counters : numbers
    clinics ||--o{ services : offers
    clinics ||--o{ doctors : "works with"
    clinics ||--o{ patients : registers
    clinics ||--o{ subscriptions : holds
    clinics ||--o{ queue_display_screens : shows
    clinics ||--o{ domain_events : emits
    clinics |o--o{ audit_logs : scopes

    clinic_members ||--o| doctors : "practises as"
    specialties |o--o{ services : categorizes
    specialties |o--o{ doctors : "primary specialty"
    doctors ||--o{ doctor_services : provides
    services ||--o{ doctor_services : "provided as"
    doctors ||--o{ doctor_schedules : has
    doctor_schedules ||--o{ doctor_availability : contains
    doctors ||--o{ doctor_time_off : takes

    patients ||--o{ patient_accounts : "linked to"
    patients ||--o{ patient_consents : gives
    patients |o--o{ patients : "merged into"
    patients ||--o{ appointments : attends
    doctor_services ||--o{ appointments : "booked as"
    appointments ||--|{ appointment_history : records

    doctors ||--o{ doctor_sessions : works
    doctor_sessions ||--o{ queue_entries : orders
    appointments ||--o{ queue_entries : "queued as"
    queue_entries ||--o{ queue_events : logs
    doctor_sessions ||--o{ queue_events : logs
    doctor_services ||--o| consultation_duration_stats : "measured by"

    notification_templates ||--o{ notifications : renders
    patients |o--o{ notifications : receives
    appointments |o--o{ notifications : "about"
    notifications ||--o{ notification_attempts : "attempted by"

    patients ||--o{ invoices : "billed to"
    appointments |o--o{ invoices : "billed by"
    invoices ||--o{ invoice_items : contains
    services |o--o{ invoice_items : "priced from"
    invoices ||--o{ payments : "settled by"

    subscription_plans ||--o{ subscription_features : includes
    subscription_plans ||--o{ subscriptions : "subscribed as"

    legal_documents ||--o{ legal_acceptances : "accepted as"
    patients ||--o{ data_subject_requests : files
```

---

## 2. Identity & Access

```mermaid
erDiagram
    auth_users {
        uuid id PK
        text email UK
        text phone UK
        timestamptz email_confirmed_at
    }
    user_profiles {
        uuid id PK, FK "= auth.users.id"
        text full_name
        text phone_e164 "nullable"
        text locale "fr or ar"
    }
    platform_admins {
        uuid user_id PK, FK
        uuid granted_by FK
        timestamptz granted_at
        timestamptz revoked_at "nullable"
    }
    permissions {
        text key PK "e.g. appointments.cancel"
        text context
        text description
    }
    role_permissions {
        clinic_role role PK
        text permission_key PK, FK
    }
    clinic_members {
        uuid id PK
        uuid clinic_id FK, UK
        uuid user_id FK, UK
        clinic_role role
        member_status status "active, suspended, removed"
        uuid invited_by FK "nullable"
        timestamptz joined_at
        timestamptz status_changed_at
    }
    clinic_invitations {
        uuid id PK
        uuid clinic_id FK
        citext email "partial UK with clinic while pending"
        clinic_role role
        text token_hash UK "sha-256, token never stored"
        uuid invited_by FK
        timestamptz expires_at
        timestamptz accepted_at "nullable"
        uuid accepted_by FK "nullable"
        timestamptz revoked_at "nullable"
    }
    clinics {
        uuid id PK
        citext slug UK
        clinic_status status
    }

    auth_users ||--|| user_profiles : "has profile"
    auth_users ||--o| platform_admins : "may be"
    auth_users ||--o{ clinic_members : "member through"
    clinics ||--o{ clinic_members : has
    clinics ||--o{ clinic_invitations : issues
    permissions ||--o{ role_permissions : "granted by"
```

## 3. Tenancy

```mermaid
erDiagram
    clinics {
        uuid id PK
        citext slug UK
        text display_name
        text legal_name "nullable"
        text city
        text address_line "nullable"
        text phone_e164 "nullable"
        citext email "nullable"
        text timezone "default Africa/Casablanca"
        text default_locale "fr or ar"
        text ice "company id, nullable"
        text logo_path "storage path, nullable"
        clinic_status status "pending_approval, active, suspended, closed"
        timestamptz approved_at "nullable"
        uuid approved_by FK "platform admin, nullable"
        text suspended_reason "nullable"
        timestamptz closed_at "nullable"
        uuid created_by FK
    }
    clinic_settings {
        uuid clinic_id PK, FK
        bool online_booking_enabled
        bool auto_confirm_online
        int min_lead_minutes
        int max_horizon_days
        int patient_cancel_cutoff_hours
        int max_active_online_bookings
        int_array reminder_offsets_minutes "default 1440"
        int checkin_grace_minutes
        int turn_approaching_positions
        text sms_sender_name "neutral sender, nullable"
        uuid updated_by FK
    }
    clinic_closures {
        uuid id PK
        uuid clinic_id FK
        daterange dates "local dates, exclusion: no overlap"
        text reason
        uuid created_by FK
    }
    clinic_counters {
        uuid clinic_id PK, FK
        text counter_key PK "invoice:2027, receipt:2027, patient_file"
        bigint next_value
    }

    clinics ||--|| clinic_settings : "configured by"
    clinics ||--o{ clinic_closures : "closed on"
    clinics ||--o{ clinic_counters : numbers
```

## 4. Practice Catalog and Scheduling

```mermaid
erDiagram
    specialties {
        uuid id PK
        text code UK
        text name_fr
        text name_ar
        bool is_active
    }
    services {
        uuid id PK
        uuid clinic_id FK, UK
        uuid specialty_id FK "nullable"
        text name_fr "nullable, one name required"
        text name_ar "nullable"
        int default_duration_minutes "5-480, step 5"
        money price_mad ">= 0"
        bool online_bookable
        catalog_status status "active, archived"
    }
    doctors {
        uuid id PK
        uuid clinic_id FK, UK
        uuid user_id FK "nullable, composite FK to clinic_members"
        text full_name
        text full_name_ar "nullable"
        uuid specialty_id FK "nullable"
        text inpe "nullable"
        text phone_e164 "nullable"
        bool online_bookable
        doctor_status status "active, inactive"
    }
    doctor_services {
        uuid clinic_id PK, FK
        uuid doctor_id PK, FK
        uuid service_id PK, FK
        int duration_minutes "override, nullable"
        money price_mad "override, nullable"
        bool online_bookable
        bool is_active
    }
    doctor_schedules {
        uuid id PK
        uuid clinic_id FK, UK
        uuid doctor_id FK
        text name "Standard, Ramadan 2027"
        schedule_kind kind "regular, override"
        date valid_from
        date valid_until "nullable, exclusion per doctor and kind"
    }
    doctor_availability {
        uuid id PK
        uuid clinic_id FK
        uuid schedule_id FK
        uuid doctor_id FK
        smallint weekday "ISO 1-7"
        time start_time "local wall clock"
        time end_time "exclusion: no overlap per schedule and weekday"
    }
    doctor_time_off {
        uuid id PK
        uuid clinic_id FK
        uuid doctor_id FK
        tstzrange period "GiST index"
        time_off_reason reason_category
        text note "staff only, no medical detail"
        uuid created_by FK
    }
    clinic_members {
        uuid clinic_id PK
        uuid user_id PK
    }

    specialties |o--o{ services : categorizes
    specialties |o--o{ doctors : "primary specialty"
    clinic_members ||--o| doctors : "practises as"
    doctors ||--o{ doctor_services : provides
    services ||--o{ doctor_services : "provided as"
    doctors ||--o{ doctor_schedules : has
    doctor_schedules ||--o{ doctor_availability : contains
    doctors ||--o{ doctor_time_off : takes
```

## 5. Patients

```mermaid
erDiagram
    patients {
        uuid id PK
        uuid clinic_id FK, UK
        text file_number UK "per clinic, from clinic_counters"
        text first_name
        text last_name
        text first_name_ar "nullable"
        text last_name_ar "nullable"
        sex sex "nullable"
        date date_of_birth "nullable"
        text phone_e164 "nullable, NOT unique"
        citext email "nullable"
        text preferred_locale
        contact_channel preferred_channel "sms, whatsapp, email, none"
        patient_status status "active, archived, merged"
        uuid merged_into_id FK "nullable, same clinic"
        patient_origin created_via "reception, online, walk_in, import"
        uuid created_by FK "nullable"
        timestamptz archived_at "nullable"
    }
    patient_accounts {
        uuid id PK
        uuid user_id FK "auth.users"
        uuid clinic_id FK
        uuid patient_id FK
        patient_relationship relationship "self, child, other_dependent"
        link_origin linked_via "online_booking, staff"
        timestamptz linked_at
        timestamptz revoked_at "nullable"
    }
    patient_consents {
        uuid id PK
        uuid clinic_id FK
        uuid patient_id FK
        consent_purpose purpose
        bool granted
        text document_version
        consent_source source "online, reception, paper"
        uuid recorded_by_user_id FK "nullable"
        timestamptz recorded_at
    }
    auth_users {
        uuid id PK
    }

    patients ||--o{ patient_accounts : "linked to"
    auth_users ||--o{ patient_accounts : "portal access through"
    patients ||--o{ patient_consents : gives
    patients |o--o{ patients : "merged into"
```

## 6. Appointments

```mermaid
erDiagram
    appointments {
        uuid id PK
        uuid clinic_id FK, UK
        uuid patient_id FK
        uuid doctor_id FK "composite FK to doctor_services"
        uuid service_id FK "composite FK to doctor_services"
        timestamptz starts_at
        timestamptz ends_at "exclusion: no overlap per doctor"
        appointment_status status
        appointment_source source "staff, online, walk_in"
        bool is_overbooked "excluded from the constraint"
        text overbook_reason "required if overbooked"
        text patient_reason "max 200 chars, staff only"
        money price_mad "snapshot at booking"
        text idempotency_key "partial UK per clinic"
        uuid booked_by_user_id FK "nullable"
        timestamptz confirmed_at
        timestamptz checked_in_at
        timestamptz started_at
        timestamptz completed_at
        timestamptz cancelled_at
        timestamptz no_show_at
        uuid cancelled_by_user_id FK
        cancellation_actor cancellation_actor "patient, clinic, system"
        cancellation_reason cancellation_reason
        int version "optimistic concurrency"
    }
    appointment_history {
        bigint id PK
        uuid clinic_id FK
        uuid appointment_id FK
        history_event event_type "created, status_changed, rescheduled, details_changed"
        appointment_status from_status "nullable"
        appointment_status to_status "nullable"
        timestamptz previous_starts_at "nullable"
        timestamptz new_starts_at "nullable"
        actor_type actor_type
        uuid actor_user_id "nullable"
        text reason "nullable"
        timestamptz occurred_at
    }
    doctor_services {
        uuid clinic_id PK
        uuid doctor_id PK
        uuid service_id PK
    }
    patients {
        uuid clinic_id UK
        uuid id PK
    }

    doctor_services ||--o{ appointments : "booked as"
    patients ||--o{ appointments : attends
    appointments ||--|{ appointment_history : records
```

## 7. Patient Flow (SmartFlow)

```mermaid
erDiagram
    doctor_sessions {
        uuid id PK
        uuid clinic_id FK, UK
        uuid doctor_id FK, UK
        date service_date UK "local date"
        session_status status "planned, open, paused, closed"
        timestamptz opened_at
        timestamptz closed_at
        int announced_delay_minutes "0-600"
        timestamptz delay_reported_at
        uuid delay_reported_by FK
        int next_ticket_number
        bigint queue_version
    }
    queue_entries {
        uuid id PK
        uuid clinic_id FK
        uuid session_id FK, UK
        uuid appointment_id FK "partial UK while open"
        uuid doctor_id FK
        int ticket_number UK "per session"
        queue_state state "waiting, called, in_consultation, closed"
        queue_outcome outcome "completed, left, cancelled"
        smallint priority_level "0 normal, 1 priority"
        priority_reason priority_reason "nullable"
        uuid priority_set_by FK "nullable"
        numeric sort_key
        timestamptz checked_in_at
        timestamptz called_at
        int call_count
        timestamptz consultation_started_at
        timestamptz closed_at
        timestamptz estimated_start_at
        timestamptz estimate_computed_at
    }
    queue_events {
        bigint id PK
        uuid clinic_id FK
        uuid session_id FK
        uuid queue_entry_id FK "nullable"
        queue_event_type event_type
        uuid actor_user_id "nullable"
        text reason "nullable"
        jsonb details "ids and numbers only"
        timestamptz occurred_at
    }
    consultation_duration_stats {
        uuid clinic_id PK, FK
        uuid doctor_id PK, FK
        uuid service_id PK, FK
        int sample_size
        numeric median_minutes
        numeric p80_minutes
        int window_days
        timestamptz computed_at
    }
    queue_display_screens {
        uuid id PK
        uuid clinic_id FK
        text name
        text token_hash UK
        uuid doctor_id FK "nullable = all doctors"
        timestamptz last_seen_at
        timestamptz revoked_at
    }
    appointments {
        uuid id PK
        uuid clinic_id UK
    }
    doctors {
        uuid id PK
        uuid clinic_id UK
    }

    doctors ||--o{ doctor_sessions : works
    doctor_sessions ||--o{ queue_entries : orders
    appointments ||--o{ queue_entries : "queued as"
    queue_entries ||--o{ queue_events : logs
    doctor_sessions ||--o{ queue_events : logs
    doctors ||--o{ consultation_duration_stats : "measured by"
    doctors |o--o{ queue_display_screens : "filtered by"
```

## 8. Communications

```mermaid
erDiagram
    domain_events {
        bigint id PK
        uuid clinic_id FK "nullable for platform events"
        text aggregate_type
        uuid aggregate_id
        text event_type
        jsonb payload "ids only"
        timestamptz occurred_at
        timestamptz processed_at "nullable"
        int attempts
        text last_error "nullable"
    }
    notification_templates {
        uuid id PK
        uuid clinic_id FK "nullable = platform default"
        notification_event event_type
        channel channel "email, sms, whatsapp, push"
        text locale
        int version
        text subject "email only"
        text body "SMS: restricted placeholders"
        bool is_active
    }
    notifications {
        uuid id PK
        uuid clinic_id FK
        uuid patient_id FK "one recipient ref required"
        uuid user_id FK "staff recipient"
        uuid invitation_id FK "invitee recipient"
        uuid appointment_id FK "nullable"
        uuid queue_entry_id FK "nullable"
        notification_event event_type
        channel channel
        text locale
        uuid template_id FK
        timestamptz scheduled_for
        notification_status status
        text idempotency_key UK
        int attempt_count
        timestamptz next_attempt_at
        timestamptz locked_until "worker lease"
        text provider
        text provider_message_id
        timestamptz sent_at
        timestamptz delivered_at
        timestamptz failed_at
        text skip_reason
    }
    notification_attempts {
        uuid id PK
        uuid clinic_id FK
        uuid notification_id FK
        int attempt_no
        text provider
        text recipient_masked
        timestamptz started_at
        timestamptz finished_at
        attempt_outcome outcome "accepted, rejected, error, timeout"
        text provider_status
        text error_code
    }

    notification_templates ||--o{ notifications : renders
    notifications ||--o{ notification_attempts : "attempted by"
```

## 9. Billing, Subscriptions and Compliance

```mermaid
erDiagram
    invoices {
        uuid id PK
        uuid clinic_id FK, UK
        uuid patient_id FK
        uuid appointment_id FK "nullable"
        invoice_status status
        smallint fiscal_year UK "null while draft"
        int sequence_no UK "gapless, null while draft"
        text invoice_number "e.g. 2027-000123"
        timestamptz issued_at
        uuid issued_by FK
        char currency "MAD"
        money subtotal_mad
        money discount_mad
        money total_mad
        money amount_paid_mad "maintained by trigger"
        text bill_to_name "snapshot at issue"
        jsonb clinic_snapshot "legal name, ICE, address at issue"
        text void_reason
        timestamptz voided_at
        uuid voided_by FK
        uuid created_by FK
    }
    invoice_items {
        uuid id PK
        uuid clinic_id FK
        uuid invoice_id FK
        uuid service_id FK "nullable"
        text description
        numeric quantity "> 0"
        money unit_price_mad
        money line_total_mad "generated"
        smallint position
    }
    payments {
        uuid id PK
        uuid clinic_id FK, UK
        uuid invoice_id FK
        money amount_mad "> 0"
        payment_method method
        timestamptz paid_at
        text reference "nullable"
        text receipt_number UK "gapless per clinic"
        uuid received_by FK
        payment_status status "recorded, reversed"
        timestamptz reversed_at
        uuid reversed_by FK
        text reversal_reason
        text idempotency_key
    }
    subscription_plans {
        uuid id PK
        text code UK
        text name_fr
        text name_ar
        money monthly_price_mad
        bool is_public
        bool is_active
    }
    subscription_features {
        uuid plan_id PK, FK
        text feature_key PK
        bool enabled
        int limit_value "nullable = unlimited"
    }
    subscriptions {
        uuid id PK
        uuid clinic_id FK "partial UK while non-terminal"
        uuid plan_id FK
        subscription_status status
        timestamptz started_at
        date current_period_start
        date current_period_end
        timestamptz trial_ends_at
        timestamptz cancelled_at
        uuid managed_by FK "platform admin"
        text notes
    }
    audit_logs {
        bigint id PK
        timestamptz occurred_at
        actor_type actor_type
        uuid actor_user_id "no FK, survives account deletion"
        uuid clinic_id FK "nullable"
        text action
        text entity_type
        uuid entity_id
        text_array changed_fields
        jsonb metadata "no patient data"
        text request_id
    }
    legal_documents {
        uuid id PK
        legal_kind kind
        text locale
        text version
        timestamptz published_at
        text content_path
        bool is_current
    }
    legal_acceptances {
        uuid id PK
        uuid document_id FK, UK
        uuid user_id FK, UK
        uuid clinic_id FK, UK "nullable"
        acceptance_context context
        timestamptz accepted_at
    }
    data_subject_requests {
        uuid id PK
        uuid clinic_id FK
        uuid patient_id FK
        dsr_type request_type "access, rectification, objection, erasure"
        timestamptz received_at
        date due_at
        dsr_status status
        uuid handled_by FK
        timestamptz completed_at
        text resolution_note
    }

    invoices ||--o{ invoice_items : contains
    invoices ||--o{ payments : "settled by"
    subscription_plans ||--o{ subscription_features : includes
    subscription_plans ||--o{ subscriptions : "subscribed as"
    legal_documents ||--o{ legal_acceptances : "accepted as"
```

---

## 10. Enumerated types

| Type | Values |
| --- | --- |
| `clinic_role` | `clinic_owner`, `clinic_admin`, `doctor`, `receptionist`, `accountant` |
| `member_status` | `active`, `suspended`, `removed` |
| `clinic_status` | `pending_approval`, `active`, `suspended`, `closed` |
| `appointment_status` | `pending`, `confirmed`, `checked_in`, `in_progress`, `completed`, `cancelled`, `no_show` |
| `appointment_source` | `staff`, `online`, `walk_in` |
| `cancellation_actor` | `patient`, `clinic`, `system` |
| `cancellation_reason` | `patient_request`, `clinic_request`, `doctor_unavailable`, `duplicate`, `left_before_consultation`, `not_confirmed_in_time`, `other` |
| `session_status` | `planned`, `open`, `paused`, `closed` |
| `queue_state` | `waiting`, `called`, `in_consultation`, `closed` |
| `queue_outcome` | `completed`, `left`, `cancelled` |
| `priority_reason` | `elderly`, `pregnancy`, `disability`, `young_child`, `staff_judgement`, `other` |
| `notification_status` | `scheduled`, `processing`, `sent`, `delivered`, `failed`, `cancelled`, `skipped` |
| `notification_event` | `booking_received`, `appointment_confirmation`, `appointment_reminder`, `appointment_rescheduled`, `appointment_cancellation`, `doctor_delay`, `turn_approaching`, `staff_invitation`, `clinic_status_changed` |
| `channel` | `email`, `sms`, `whatsapp`, `push` |
| `invoice_status` | `draft`, `issued`, `partially_paid`, `paid`, `void` |
| `payment_method` | `cash`, `card`, `bank_transfer`, `cheque`, `other` |
| `payment_status` | `recorded`, `reversed` |
| `subscription_status` | `trialing`, `active`, `past_due`, `cancelled`, `expired` |
| `consent_purpose` | `data_processing`, `reminders_sms`, `reminders_whatsapp`, `reminders_email` |

New values are added by migration only. PostgreSQL enums can gain values but cannot drop them, so the lists start small.

## 11. Required extensions

| Extension | Used for |
| --- | --- |
| `btree_gist` | Exclusion constraints combining `=` on uuid with `&&` on ranges (appointments, schedules, closures) |
| `citext` | Case-insensitive email and slug |
| `pg_trgm` | Patient name search |
| `pg_cron`, `pg_net` | Scheduled jobs and worker invocation ([SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §5.3) |
