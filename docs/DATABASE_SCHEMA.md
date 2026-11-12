# SmartCabin — Database Schema (Phase 3 foundation)

| | |
| --- | --- |
| Status | `supabase/migrations/` holds 29 migrations, verified by the database suite on an embedded PostgreSQL 17 with a Supabase shim (`tests/db/`). A live Supabase stack has not run them yet (Docker unavailable). See §8 |
| Date | 2026-11-10 |
| Scope | BC1 Identity & Access, BC2 Tenancy, BC3 Catalog, BC4 Scheduling, BC5 Patients, BC6 Appointments, BC12 Compliance, outbox |
| Since added | Queue and SmartFlow (0023–0025), notifications (0026), billing (0027). See the migration catalog below |
| Not yet | Patient rescheduling from the portal, and adding a person outside a booking (S7 remainder). Each slice adds its own migrations |
| Related | [DOMAIN_MODEL.md](DOMAIN_MODEL.md) · [DATABASE_ERD.md](DATABASE_ERD.md) · [SECURITY_MODEL.md](SECURITY_MODEL.md) · [RBAC_PERMISSION_MATRIX.md](RBAC_PERMISSION_MATRIX.md) |

## 1. How to run

```bash
pnpm install
pnpm db:start          # local Postgres only (Docker required); full stack: pnpm exec supabase start
pnpm db:reset          # applies every migration + supabase/seed.sql to the LOCAL database
pnpm test:db           # database integration tests (Vitest + pg)
pnpm db:types          # regenerates src/shared/lib/supabase/database.types.ts
```

**Migration rules:**
- Migrations are forward-only and additive. No `DROP`, no destructive `ALTER`.
- A correction is a new migration.
- Shared and production databases receive migrations only through CI, after review.
- `supabase db reset` targets the **local** stack only.

## 2. Migration catalog

| # | File | Contents |
| --- | --- | --- |
| 0001 | `20261110000100_extensions_and_conventions.sql` | Extensions `btree_gist`, `citext`, `pg_trgm`, `pgcrypto` (schema `extensions`); `private` schema; **default privileges revoked** for `anon`/`authenticated` (secure by default); 22 enum types; shared triggers (`set_updated_at`, `forbid_clinic_id_change`, `forbid_mutation`) |
| 0002 | `…000200_identity_and_tenancy.sql` | `clinics`, `clinic_settings`, `user_profiles` (+ trigger on `auth.users`), `platform_admins`, `permissions`, `role_permissions`, `clinic_members` (+ deferred last-owner trigger), `clinic_invitations`, `clinic_closures`, `private.clinic_counters` + `private.next_counter_value()` |
| 0003 | `…000300_practice_catalog.sql` | `specialties` (14 reference rows), `services`, `doctors`, `doctor_services`; BR-T-07 online-booking guard |
| 0004 | `…000400_scheduling.sql` | `doctor_schedules` (regular/override), `doctor_availability`, `doctor_time_off` |
| 0005 | `…000500_patients.sql` | `patients` (gapless file number trigger), `patient_accounts`, `patient_consents` (append-only) |
| 0006 | `…000600_appointments.sql` | `appointment_status_transitions` (11 rows), `appointments` (exclusion constraint, coherence checks, lifecycle guard), `appointment_history` (append-only) |
| 0007 | `…000700_compliance_and_outbox.sql` | `audit_logs` (append-only), `legal_documents`, `legal_acceptances`, `domain_events` + `private.emit_event()` |
| 0008 | `…000800_authorization.sql` | 62 permissions, role grants (matrix), RLS helpers and guards |
| 0009 | `…000900_row_level_security.sql` | RLS on every table, explicit table and column grants, 47 policies |
| 0010 | `…001000_audit_and_history_triggers.sql` | Generic audit trigger on 15 tables; appointment history writer |
| 0011 | `…001100_tenancy_commands.sql` | `create_clinic`, `get_my_memberships`, `invite_member`, `accept_invitation`, `revoke_invitation`, `change_member_role`, `set_member_status`, `platform_set_clinic_status` |
| 0012 | `…001200_scheduling_and_booking_commands.sql` | `get_available_slots`, `book_appointment`, `confirm_appointment`, `cancel_appointment`, `reschedule_appointment`, `mark_no_show` |
| 0013 | `…001300_workspace_read_functions.sql` | Read-only: `platform_list_clinics()` (metadata + counts, platform admin aal2), `portal_list_my_appointments()` (records explicitly linked to the portal account), `private.require_authenticated()` |
| 0014 | `…001400_book_appointment_concurrent_idempotency.sql` | Concurrent retries with one idempotency key return the original appointment (`private.find_idempotent_booking`) |
| 0015 | `…001500_onboarding.sql` | `create_clinic` requires the current terms and privacy policy to be accepted (`LEGAL_ACCEPTANCE_REQUIRED`); `is_slug_available()` |
| 0016 | `…001600_membership_management.sql` | `list_clinic_members()`, `get_clinic_dpa_status()` |
| 0017 | `…001700_doctor_management.sql` | `set_doctor_services()` (atomic), `count_future_appointments()` |
| 0018 | `…001800_patient_management.sql` | `register_patient()` (record + consents, atomic), `get_patient()` (audited view), `set_patient_archived()`, `list_patient_duplicates()`, `merge_patients()` |
| 0019 | `…001900_book_appointment_serialize_idempotent_retries.sql` | Advisory lock per (clinic, idempotency key): same-key retries no longer deadlock |
| 0020 | `20261111002000_serialize_bookings_per_doctor.sql` | `private.lock_doctor_bookings()`: advisory lock per doctor in `book_appointment` and `reschedule_appointment`, so overlapping simultaneous writes answer `SLOT_UNAVAILABLE` instead of deadlocking (audit SC-AUD-23) |
| 0021 | `20261111002100_availability_management.sql` | Module 5: `save_doctor_schedule()` (a schedule and its weekly windows in one transaction; overrides must be dated; `SCHEDULE_OVERLAP`), `list_doctor_booking_conflicts()` (future appointments that no longer fit, using the booking rules, with no patient data). `get_available_slots` corrected: bounded overlap search (audit SC-AUD-02) and time-change days (BR-TZ-03) |
| 0022 | `20261111002200_staff_appointments.sql` | Module 6: `get_appointment()` (the appointment file; visit reason only with `appointments.view_reason`), `list_appointment_history()` (timeline with the names of clinic staff), `private.member_display_name()`. The `patient_reason` column is no longer granted to `authenticated`. `private.lock_appointment_for_command` now authorizes before locking (audit SC-AUD-18) |
| 0023 | `20261111002300_reception_check_in.sql` | Module 7: `doctor_sessions` (one doctor's day, gapless ticket counter, queue version), `queue_entries`, `queue_events` (append-only), with RLS on `queue.view` (a doctor sees their own queue). A deferred trigger keeps queue state and appointment status matching. Commands `check_in_appointment()` (A8), `register_walk_in()` (A3), `mark_left()` (A11). Walk-ins no longer count in `appointments_no_overlap` nor in free slots (MD-10) |
| 0024 | `20261111002400_smartflow_queue.sql` | Module 8a: `call_next`, `recall_entry`, `start_consultation`, `complete_consultation`, `set_queue_priority`, `move_queue_entry_before`, `correct_appointment_status` (A13, A14), `open_doctor_day`, `pause/resume/close_doctor_session`, `report_doctor_delay`; wait-time estimates recomputed at commit (deferred trigger on `queue_version`); `consultation_duration_stats` with `private.rebuild_consultation_duration_stats()` (to schedule nightly); `mark_left` replaced to follow the global lock order (appointment → doctor bookings → session → entries) |
| 0025 | `20261111002500_smartflow_live.sql` | Module 8b: realtime hints after every queue change on `clinic:<id>:board:<date>` and `clinic:<id>:doctor:<doctor>:<date>` (ids and versions only), authorized by a policy on `realtime.messages` via `private.can_receive_queue_topic()`; `queue_display_screens` with `create_display_screen()` (token shown once, SHA-256 stored), `revoke_display_screen()` and `display_snapshot()` (the only function `anon` may execute); `portal_get_my_queue_status()`; `private.close_stale_sessions()`; pg_cron schedules where pg_cron exists |
| 0030 | `20261112003000_patient_portal.sql` | Slice S7: `public.before_user_created` (Supabase Auth hook: phone sign-ups for Moroccan mobile numbers only); `public_get_clinic_profile()` and `public_get_available_slots()` (anon: clinic profile and slot times only); `portal_list_my_people()`, `portal_book_appointment()` (A1/A2 online, new person created and linked), `portal_cancel_appointment()` (A6 before the cutoff); `portal_list_my_appointments()` recreated with the clinic slug and the cancellation deadline; `private.expire_pending_appointments()` (A7) with a guarded pg_cron schedule |
| 0029 | `20261112002900_saas_administration.sql` | Module 12: `subscription_plans` (seeded neutral `pilot` plan), `subscription_features` (BR-T-08 limits), `subscriptions` (one live per clinic; trial at clinic creation, backfilled), `subscription_change_requests`; `private.clinics_with_permission` replaced so an expired subscription removes write permissions (BR-P-01); limit triggers on doctors, members and invitations; SMS quota check in `jobs_claim_notifications` (replaced, same signature); `get_my_subscription()`, `list_available_plans()`, `request_plan_change()`, `get_my_clinic_access()`, platform functions; `private.refresh_subscription_states()` with a guarded pg_cron schedule |
| 0028 | `20261112002800_analytics.sql` | Module 11: `kpi_operational()` (K1–K6 and K8 per period, local day, doctor or service), `SECURITY INVOKER` so RLS scopes every row; owns no table |
| 0027 | `20261112002700_billing.sql` | Module 10: `invoices`, `invoice_items`, `payments` (command tier, RLS on `invoices.view`, audit triggers); guards: issued invoices immutable, lines only in draft, payments never deleted (recorded → reversed only), paid amount and status derived from payments; `create_invoice_draft()`, `update_invoice_draft()`, `discard_invoice_draft()`, `issue_invoice()` (gapless `invoice:<year>` counter), `void_invoice()`, `record_payment()` (gapless `receipt:<year>` counter), `reverse_payment()`, `revenue_summary()` (K7) |
| 0026 | `20261111002600_notifications.sql` | Module 9: `notification_templates` (fr/ar platform defaults, clinic versions, allowed placeholders only), `notifications` (one row per planned message, unique idempotency key, masked recipient, no content), `notification_attempts` (append-only); planner `private.plan_notifications()` consuming `domain_events`; worker functions `jobs_plan_notifications()`, `jobs_claim_notifications()`, `jobs_record_attempt()` executable by `anon` and guarded by the job key (`private.job_credentials`); `private.call_dispatch()` (signed pg_net call); pg_cron schedules where pg_cron exists |

**Deployment notes (module 8b):**
- **Realtime:** enable Realtime Authorization (private channels) in the Supabase project. The migration creates the `realtime.messages` policy when that table exists.
- **pg_cron:** enable the pg_cron extension, then re-run the scheduling block of migration 0025, or schedule the three jobs by hand:
  - `private.rebuild_consultation_duration_stats()` nightly;
  - `private.refresh_overdue_estimates()` every minute;
  - `private.close_stale_sessions()` after midnight.

**Deployment notes (S7):**
- **Auth hook:** in the hosted project, set Authentication → Hooks → Before User Created to the Postgres function `public.before_user_created`, then enable phone sign-ups (SECURITY_MODEL §7).
- **pg_cron:** re-run the scheduling block of migration 0030, or schedule `private.expire_pending_appointments()` every 10 minutes by hand.

**Deployment notes (module 12):**
- **Plans:** create the real plans in the platform's "Formules" page; the seeded `pilot` plan (0 MAD, no limit) keeps every existing clinic on a trial until then.
- **pg_cron:** re-run the scheduling block of migration 0029, or schedule `private.refresh_subscription_states()` daily by hand.

**Deployment notes (module 9):**
- **Job secret:** generate `JOBS_SECRET` (at least 32 random characters, e.g. `openssl rand -hex 32`) and set it in the app's server environment. Store only its SHA-256: compute it locally (`printf %s "$JOBS_SECRET" | openssl dgst -sha256`), then run `select private.set_job_key_hash('<hex digest>');` as `postgres`. Rotating the secret is the same two steps.
- **Vault:** create the secrets `smartcabin_jobs_secret` (the same value as `JOBS_SECRET`) and `smartcabin_app_url` (the app's public origin, without a trailing slash). Without them, `private.call_dispatch()` does nothing.
- **pg_net and pg_cron:** enable both, then re-run the scheduling block of migration 0026, or schedule by hand `private.plan_notifications()` and `private.call_dispatch()` every minute.
- **Provider:** `NOTIFICATIONS_PROVIDER=disabled` (default) keeps every message planned and sends nothing; `simulator` accepts every message without sending it. A real provider needs an adapter and a commercial decision.

## 3. Tables

**Write tiers:**
- **M = managed:** DML allowed under RLS, with column grants.
- **C = command:** SELECT only; writes go through `SECURITY DEFINER` commands.
- **A = append-only.**
- **R = reference:** read-only for API roles.
- **I = internal:** no API access.

| Table | Tier | Tenant key | Key constraints |
| --- | --- | --- | --- |
| `clinics` | C (profile columns M) | `id` | `slug` unique + format + reserved list; phone E.164; ICE 15 digits; status/approval/closure coherence; valid IANA time zone (trigger) |
| `clinic_settings` | M | `clinic_id` (PK) | Value ranges; neutral SMS sender name; online booking only when active and bookable (trigger) |
| `clinic_closures` | M | `clinic_id` | Bounded `daterange`; **exclusion: no overlap per clinic** |
| `private.clinic_counters` | I | `clinic_id` | PK (`clinic_id`, `counter_key`); increment locks the row until commit (gapless) |
| `user_profiles` | M (own row) | — | Locale `fr`/`ar`; phone E.164 |
| `platform_admins` | R | — | Revocation ≥ grant |
| `permissions`, `role_permissions` | R | — | Key format; access `read`/`write` |
| `clinic_members` | C | `clinic_id` | Unique (`clinic_id`, `user_id`); **deferred trigger: ≥ 1 active owner** |
| `clinic_invitations` | C | `clinic_id` | Token hash unique (SHA-256, never selectable); one open invitation per email; acceptance coherence |
| `specialties` | R | — | Code unique |
| `services` | M | `clinic_id` | Duration 5–480 step 5; price ≥ 0; one name required; unique active name |
| `doctors` | M | `clinic_id` | **FK (`clinic_id`, `user_id`) → `clinic_members`**; one doctor row per user per clinic |
| `doctor_services` | M | `clinic_id` | PK (`clinic_id`, `doctor_id`, `service_id`); **composite FKs to doctors and services** |
| `doctor_schedules` | M | `clinic_id` | **Exclusion: same doctor + kind, overlapping date ranges** |
| `doctor_availability` | M | `clinic_id` | FK (`clinic_id`, `schedule_id`, `doctor_id`) → schedule; 5-minute grid; **exclusion: overlapping windows per schedule + weekday** |
| `doctor_time_off` | M | `clinic_id` | Bounded `tstzrange`; GiST index |
| `patients` | M | `clinic_id` | File number unique per clinic (server-assigned); phone **not** unique; merge and archive coherence; trigram name index |
| `patient_accounts` | C | `clinic_id` | One active link per (user, patient); composite FK to patients |
| `patient_consents` | A (insert M) | `clinic_id` | Composite FK; `recorded_by` stamped |
| `appointment_status_transitions` | R | — | 11 allowed transitions |
| `appointments` | C | `clinic_id` | **Exclusion `appointments_no_overlap`** (see §4); composite FKs to patients and to **doctor_services**; duration and grid checks; status ↔ timestamp coherence; overbook reason; unique idempotency key per clinic; lifecycle guard trigger |
| `appointment_history` | A | `clinic_id` | Composite FK to appointments |
| `audit_logs` | A | `clinic_id` (nullable) | Action format; no FK on actor (survives account deletion) |
| `legal_documents` | R | — | One current version per kind and locale |
| `legal_acceptances` | A (insert own) | `clinic_id` (nullable) | Unique NULLS NOT DISTINCT (document, user, clinic) |
| `domain_events` | I | `clinic_id` | Event type format; partial index on unprocessed rows |

**Tenant consistency everywhere:**
- Every tenant table has `unique (clinic_id, id)`.
- Every child references its parent through `(clinic_id, parent_id)`.
- A trigger forbids changing `clinic_id`.
- The database therefore cannot store a cross-tenant relationship, even through privileged code. This is tested.

## 4. Scheduling conflict prevention

```sql
constraint appointments_no_overlap exclude using gist (
  doctor_id with =, tstzrange(starts_at, ends_at, '[)') with &&)
  where (status in ('pending', 'confirmed', 'checked_in', 'in_progress') and not is_overbooked)
```

- **Concurrent requests:** the constraint alone guarantees that no overlapping pair is ever committed. But two transactions that insert overlapping rows *at the same moment* can each wait for the other's in-progress index entry. PostgreSQL then aborts one with `40P01` (deadlock detected), not `exclusion_violation`. Two layers prevent this:
  - since migration 0020, `book_appointment` and `reschedule_appointment` take a transaction-scoped advisory lock per doctor (`private.lock_doctor_bookings`) just before writing. The second writer waits for the first to commit, then gets `exclusion_violation`, mapped to `SLOT_UNAVAILABLE`;
  - lock order is acyclic: idempotency key → doctor for bookings, appointment row → doctor for reschedules.

  Any future command that moves an appointment, or puts it back into an active status, must take the same lock. The concurrency suite checks:
  - 10 simultaneous bookings of one slot;
  - 24 rounds of 6 simultaneous overlapping bookings;
  - 9 rounds of 6 simultaneous overlapping reschedules.

  Every failure must be `SLOT_UNAVAILABLE`, and no overlap may be committed.
- **Idempotency:** a replay with the same key (`appointments_idempotency_key`, unique per clinic) returns the original appointment, including when the retries arrive concurrently.
- **Free time:** cancelled, completed and no-show appointments free their time automatically (partial predicate).
- **Slot generation and time changes (BR-TZ-02/03, migration 0021):**
  - candidate slots are local wall-clock times converted per date;
  - a local time that does not exist on a time-change date (Morocco's Ramadan switch) is not offered;
  - a slot ends at start + duration in real minutes, and must end inside its window.
  - Property tests around every time change in the next two years check that every slot is exact, distinct and inside its window, and that each slot offered on the switch day can be booked.
- **Walk-ins (MD-10, migration 0023):** a walk-in appointment (`source = walk_in`) queues behind the agenda. It is excluded from the constraint and from free-slot computation, so a walk-in can always be registered, and booked slots stay bookable.
- **Overbooking (MD-08):** an overbooked appointment is excluded from the constraint. It requires the `appointments.overbook` permission and a reason.
- **Availability, time off and closures** are checked by `private.assert_slot_bookable()` in local wall-clock time per date (BR-TZ-02).

## 5. Row-Level Security

**Helpers (schema `private`, `SECURITY DEFINER`, `search_path = ''`):**

| Helper | Use |
| --- | --- |
| `clinics_with_permission(perm)` | Set of clinics where the caller holds `perm`. Checks: active membership, clinic usable (suspended = read only), and `aal2` for owner/admin/accountant. Used as `clinic_id in (select …)`, evaluated once per statement |
| `practitioner_only_clinics()`, `my_doctor_ids()`, `my_doctor_patient_ids()` | Doctor scope (MD-03, Q7) |
| `has_permission`, `member_role`, `is_practitioner_only` | Used by commands |
| `require_clinic_access` | `NOT_FOUND` for non-members, so ids from other tenants reveal nothing |
| `require_permission` | `UNAUTHENTICATED` / `MFA_REQUIRED` / `FORBIDDEN` |
| `require_doctor_scope` | Practitioner-only callers can act on their own doctor records only |
| `require_platform_admin` | Active platform admin with `aal2` |

**Policies (47).** Every policy targets `authenticated`, except the two reference tables, which also allow `anon`.

| Table | SELECT | INSERT | UPDATE | DELETE |
| --- | --- | --- | --- | --- |
| `clinics` | `clinic.profile.view` | — | `clinic.profile.update` (profile columns only) | — |
| `clinic_settings` | `clinic.profile.view` | — | `clinic.settings.update` | — |
| `clinic_closures` | `schedules.view` | `clinic.closures.manage` | idem | idem |
| `user_profiles` | own row | — | own row | — |
| `platform_admins` | own row | — | — | — |
| `permissions`, `role_permissions`, `appointment_status_transitions` | all authenticated | — | — | — |
| `specialties`, `legal_documents` | anon + authenticated | — | — | — |
| `clinic_members` | own rows or `members.view` | — | — | — |
| `clinic_invitations` | `members.view` (no `token_hash` column) | — | — | — |
| `services` | `services.view` | `services.manage` | idem | idem |
| `doctors`, `doctor_services` | `doctors.view` | `doctors.manage` | idem | idem |
| `doctor_schedules`, `doctor_availability` | `schedules.view` | `schedules.manage` + doctor scope | idem | idem |
| `doctor_time_off` | `schedules.view` | `time_off.manage` + doctor scope | idem | idem |
| `patients` | `patients.view` + doctor scope (own patients) | `patients.create` (origin ≠ online) | `patients.update` (editable columns only) | — |
| `patient_accounts` | `patients.view` + scope | — | — | — |
| `patient_consents` | `patients.view` + scope | `consents.record` | — | — |
| `appointments` | `appointments.view` + doctor scope | — | — | — |
| `appointment_history` | `appointments.view` + visible appointment | — | — | — |
| `audit_logs` | `audit.view` | — | — | — |
| `legal_acceptances` | own rows | own rows (+ `legal.accept_clinic_dpa` for a clinic DPA) | — | — |
| `domain_events`, `private.clinic_counters` | RLS on, no policy, no grant | — | — | — |

**Grants:**
- Every grant is explicit (migration 0009).
- `anon` can read `specialties` and `legal_documents` only.
- Command tables have SELECT only.
- Server-controlled columns are excluded from the grants, so `authenticated` can never update them: `clinics.status`, `slug`, `timezone`, `patients.file_number`, `status`, and others.

## 6. Command functions

All of them are `SECURITY DEFINER` with `search_path = ''`. EXECUTE is granted to `authenticated` only (never `anon`). The tenant is derived from the target row.

| Function | Guard | Notes |
| --- | --- | --- |
| `create_clinic` | Signed in + confirmed email | Clinic `pending_approval` + settings + owner; at most 3 pending clinics per user; `SLUG_TAKEN` |
| `get_my_memberships` | Own rows | Works before MFA, so the app can prompt for it |
| `invite_member` | `members.invite` (admins: non-admin roles) | Returns the token **once**; stores only SHA-256; re-invite revokes the previous one |
| `accept_invitation` | Signed in, confirmed email = invited email | One error for unknown, used, revoked and expired tokens |
| `revoke_invitation` | `members.invite` | |
| `change_member_role`, `set_member_status` | `members.change_role` / `members.suspend` | Clinic row locked; no self-change; admins limited; last-owner check |
| `platform_set_clinic_status` | Platform admin + `aal2` | Transition table; suspension reason; disables online booking; audited as `platform_admin` |
| `get_available_slots` | `slots.view` | Intervals only; at most 63 days; local time per date |
| `book_appointment` | `appointments.book` (+ `appointments.overbook`), doctor scope | Idempotent; duration and price computed on the server; BR-B-01…11 |
| `confirm_appointment`, `cancel_appointment`, `reschedule_appointment`, `mark_no_show` | Respective permission + doctor scope | Optimistic `expected_version`; history and outbox event |

## 7. Decisions taken during implementation

| # | Decision | Why |
| --- | --- | --- |
| IMP-01 | Database tests use **Vitest + `pg`**, impersonating API roles exactly like PostgREST (`SET LOCAL ROLE` + `request.jwt.claims`), instead of pgTAP | Only way to test real concurrency (N connections that commit); one test runner for the whole project. Meta-tests query the catalog |
| IMP-02 | `invite_member` returns the plain token to the caller, which sends the email | Payloads of `domain_events` contain ids only, and the token is never stored. Resending = inviting again |
| IMP-03 | Clinic profile edits through **column grants + RLS** rather than a command | No invariant spans rows; status, slug and time zone are not grantable |
| IMP-04 | `doctor_schedules.kind` is `text` + check, not an enum | Usable directly in the exclusion constraint (`btree_gist` on text) |
| IMP-05 | Overlapping windows compared as `int4range` of minutes | Avoids a custom range type (and its EXECUTE grants) |
| IMP-06 | `clinic_counters` lives in `private` | Internal; never reachable through the Data API |
| IMP-07 | Staff bookings allowed in `pending_approval` clinics | Setup and historical entries before approval. Online booking stays off (BR-P-02) |
| IMP-08 | Rescheduling clears the overbooking flag | A rescheduled appointment must take a free slot |
| IMP-09 | The development seed writes appointments directly (as `postgres`) | Demo data; production writes go through commands |

## 8. Test results

**Status on 2026-11-11, migrations 0001–0020:** `pnpm test:db` runs on an embedded PostgreSQL 17 with a minimal Supabase shim (`tests/db/harness/`), because Docker is unavailable on the development machine.

- **Coverage:** 13 test files, 119 tests:
  - security meta-tests, tenant isolation, RBAC;
  - scheduling and booking, concurrency;
  - workspace read functions;
  - onboarding, membership, doctors, patients;
  - audit adversarial checks, query plans, and the application ↔ database contract.
- **Result:** 117 pass. The other 2 are *expected failures* that document open audit findings:
  - SC-AUD-02, slow free-slot lookup;
  - SC-AUD-03, suspension lifted through an invitation.
- **Not covered by the shim:** GoTrue, PostgREST and Realtime themselves. Running the same suite with `TEST_DATABASE_URL` against the local Supabase stack remains to be done once Docker works.
