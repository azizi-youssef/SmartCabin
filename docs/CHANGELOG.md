# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/). Nothing has been released yet.

## [Unreleased]

### Added — Module 7: reception (2026-11-11)

- **Arrivals (A8):** "Arrivé" on today's confirmed appointments.
  - The database assigns a **gapless ticket per doctor per day** and the queue position (BR-Q-04): on time (within the check-in grace period) means queued at the appointment time; late means queued at arrival time.
  - Refused on another day (`CHECK_IN_NOT_TODAY`), on a closed day (`SESSION_CLOSED`), and on any status other than confirmed.
- **Walk-in patients (A3, MD-10):** "Patient sans rendez-vous" creates the appointment directly checked in, then its ticket. It is queued at arrival time and is idempotent per dialog.
  - Walk-ins **no longer count in the agenda overlap constraint nor in free slots**: a walk-in can always be registered, and booked times stay bookable.
- **Left before the consultation (A11):** "Parti" closes the queue entry and cancels the appointment with the reason "left before consultation", plus an optional note.
- **Waiting room:** for today, per doctor, the patients still waiting, in queue order, with their ticket and how long they have waited.
- **End-of-day list (MD-09):** confirmed appointments whose time and grace period have passed without check-in. Staff mark them absent or cancel them; nothing is automatic.
- **Migration 0023:**
  - the queue foundation of SmartFlow: `doctor_sessions`, created at the first arrival of the day; `queue_entries`; `queue_events`, append-only;
  - RLS on `queue.view`, where a doctor sees their own queue only;
  - composite keys tying entry, session and appointment to the same clinic and doctor;
  - a deferred trigger that rejects any queue state not matching the appointment status;
  - the commands `check_in_appointment`, `register_walk_in` and `mark_left`.
- **Tests:**
  - **9 database tests** (`reception.test.ts`):
    - check-in effects (ticket, entry, history, queue version);
    - late arrivals queued at arrival time;
    - refusals (other day, other status, closed day, permissions, other clinic);
    - walk-ins alongside a booked appointment, idempotent, priced, on the 5-minute grid;
    - 8 simultaneous arrivals receiving tickets 1–8 with no gap;
    - "left" effects;
    - the queue/status mismatch rejected, immutable ticket, append-only trail;
    - queue visibility.
  - **The isolation tests now cover the 3 new tables.**
  - **3 unit tests** for queue order, waiting time and the end-of-day list.
- **Verified:**
  - typecheck and lint clean;
  - 91 unit tests;
  - database 141 passed + 1 expected failure (SC-AUD-03, still open), including every existing booking, concurrency and slot test under the changed overlap rule;
  - production build passes.
- **Not verified:** the reception screen with live data. It needs a running Supabase backend, which is unavailable on this machine.
- **Out of scope** (module 8, SmartFlow):
  - calling patients, starting and finishing the consultation;
  - priorities and reordering;
  - corrections (A13, A14);
  - wait-time estimates;
  - realtime updates, display screens, the doctor console;
  - delays, and opening and closing the day.

### Added — Module 6: staff appointments (2026-11-11)

- **Appointment file** (`/w/[slug]/appointments/[id]`), reached from reception, the doctor's day and the patient file:
  - patient, doctor, service, local date and time, origin, price snapshot;
  - who booked it, overbooking reason, cancellation (reason and by whom);
  - the actions still possible for its status;
  - the **history timeline** (created, status changes, moves with old and new times, reason, and the name of the staff member).
- **Visit reason:** an optional short field when booking. It is shown only to roles with `appointments.view_reason`, and that permission is now **enforced by the database**:
  - the `patient_reason` column is no longer readable from the table;
  - `get_appointment` returns it only with the permission.
  - The hint asks for no medical detail.
- **Book from the patient file:** the "Nouveau rendez-vous" button opens the booking dialog with the patient already selected.
- **Migration 0022:**
  - `get_appointment()` and `list_appointment_history()`, both scoped like the agenda (other clinics and other doctors' appointments answer `NOT_FOUND`);
  - `private.member_display_name()`;
  - the `patient_reason` column grant.
- **Audit fixes:**
  - **SC-AUD-18:** commands now check access before locking the appointment, so a user of another clinic can no longer wait on, or hold, that lock;
  - **SC-AUD-16:** the slot picker follows the WAI-ARIA radio-group pattern (one Tab stop, arrow keys, Home/End, mirrored in Arabic).
- **Translations:** French and Arabic labels for the two system-only cancellation reasons.
- **Tests:**
  - **7 database tests** (`appointments.test.ts`):
    - the full transition matrix: confirm, cancel, reschedule and no-show from each of the 7 statuses. Each succeeds exactly where the transition table allows, and every refusal leaves the appointment unchanged;
    - the visit reason withheld without the permission and unreadable from the table;
    - the appointment scope;
    - a check that every role able to write appointments may also see the reason (command results include the full row);
    - the history order, times and staff names;
    - the lock race. Before the fix it hit `lock timeout`; after, it gets an immediate `NOT_FOUND`.
  - **3 component tests** for the slot picker keyboard, including RTL.
- **Verified:**
  - typecheck and lint clean;
  - 88 unit and component tests;
  - database 132 passed + 1 expected failure (SC-AUD-03, still open), including the application ↔ database contract test for the new calls;
  - production build passes.
- **Not verified:** the appointment file and the patient-file booking with live data. They need a running Supabase backend, which is unavailable on this machine.
- **Out of scope** (later modules):
  - check-in, walk-ins, queue and status corrections (modules 7–8);
  - the end-of-day list (module 7);
  - expiry of pending requests and online booking (S7);
  - notifications (module 9).

### Added — Module 5: services and availability (2026-11-11)

- **Services page** (`/w/[slug]/services`, `services.manage`):
  - bilingual name, default duration (5-minute steps) and price in MAD, online-booking flag;
  - create, edit, archive and restore. Services are never deleted, because appointments reference them;
  - shows how many doctors offer each service.
- **Schedules** (`/w/[slug]/schedules`, `schedules.view`), then one page per doctor:
  - **regular weekly hours:** several ranges per day, "copy Monday to Tuesday–Saturday", hours per week;
  - **dated overrides** (Ramadan, summer…), which replace the regular hours during their dates;
  - **time off** in the clinic's local time (leave, training, sick, personal, other);
  - doctors without broader rights see and edit only their own schedule; receptionists may manage time off.
- **Conflicts, never silent changes (BR-B-12):** after any change, the page lists future appointments that now fall outside the hours, in time off or on a closure, with a link to that day's agenda. Nothing is moved or cancelled.
- **Migration 0021:**
  - `save_doctor_schedule()` saves a schedule and its ranges in one transaction. Overrides must be dated, and overlapping schedules are refused (`SCHEDULE_OVERLAP`, a new error code);
  - `list_doctor_booking_conflicts()` uses the booking rules themselves and returns no patient data.
- **Fixed in `get_available_slots`:**
  - **audit SC-AUD-02:** the overlap search is now bounded by time, so a week of slots with a year of history fits the 1 s budget, against 2–5 s before;
  - **a latent time-change defect (BR-TZ-03), found by the new property tests:** on 2027-02-07 (Ramadan switch), a 20-minute slot in the repeated hour lasted 80 minutes. Slots now end at start + duration, and local times skipped by a switch are no longer offered.
- **Navigation:** "Prestations" and "Horaires" in the Clinique group, by permission.
- **Development gallery:** a demo of the weekly hours editor.
- **Tests:**
  - **7 database tests** (`availability.test.ts`):
    - an atomic save with full rollback on any invalid range;
    - overrides (dated, non-overlapping, kind immutable);
    - permissions and doctor scope;
    - cross-clinic foreign keys;
    - conflicts for reduced hours, time off and closures, with appointments unchanged, no patient data, and scoped access;
    - **property tests around every time change in the next two years:** every slot is exact, distinct, on its grid and inside its window, and every slot offered on the switch day can be booked.
    All 7 failed before the migration.
  - **9 unit tests:** range validation (overlap, order, grid, format), schedule and time-off schemas, editing helpers, current-version choice, time-range parsing.
- **Verified:**
  - typecheck and lint clean;
  - 85 unit tests;
  - database 125 passed + 1 expected failure (SC-AUD-03, still open), including the application ↔ database contract test for the new calls;
  - production build passes;
  - axe found 0 violations on the hours editor in French and Arabic, and the RTL layout was checked at 429 px and 768 px.
- **Not verified:** the three new screens with live data. They need a running Supabase backend, which is unavailable on this machine (Docker).

### Changed — product renamed to SmartCabin (2026-11-11)

- **SmartClinic is now SmartCabin** everywhere, 97 occurrences in 48 files:
  - interface brand and page titles;
  - French and Arabic messages;
  - the authenticator (TOTP) label;
  - documentation and code comments;
  - package name, Supabase `project_id`, dev-server names, test database name.
- **Database settings renamed** from `smartclinic.*` to `smartcabin.*` (`change_reason`, `actor_type`), inside the existing migrations. No database outside throwaway test instances had applied them; future renames go through new migrations.
- **Unchanged:** the project folder name, "SmartFlow" (queue module) and the `SC_LOCALE` cookie.

### Fixed — deadlocks between simultaneous overlapping bookings (2026-11-11, audit SC-AUD-23)

- **The problem:** two bookings or reschedules for the same doctor, sent at the same moment with overlapping times, could deadlock on the overlap constraint (`40P01`). Reception then saw "unexpected error" instead of "slot taken", and `concurrency.test.ts` failed intermittently. No double booking was ever committed.
- **Migration 0020:**
  - `private.lock_doctor_bookings()`, a transaction-scoped advisory lock per doctor, taken just before writing by `book_appointment` and `reschedule_appointment`;
  - lock order is acyclic (key → doctor, row → doctor);
  - nothing else in those functions changed.
- **Error mapping:** `40P01` and `40001` now map to the retry message (`UNAVAILABLE`) instead of "unexpected error".
- **Tests:**
  - 24 rounds of 6 simultaneous overlapping bookings and 9 rounds of 6 overlapping reschedules. Every failure must be `SLOT_UNAVAILABLE` and no overlap may be committed. Both tests failed before the migration (22 deadlocks) and pass after it;
  - 1 unit test for the mapping.
- **Verified before the rename:**
  - full database suite green 3 times in a row (117 passed + 2 expected failures);
  - concurrency file green 5 times alone;
  - typecheck, lint, 76 unit tests and the production build pass.

### Audit — engineering quality and security (2026-11-11)

- **Report:** [QUALITY_SECURITY_AUDIT.md](QUALITY_SECURITY_AUDIT.md).
  - No CRITICAL finding; 3 HIGH, 8 MEDIUM, 12 LOW.
  - One HIGH, SC-AUD-23, concerns deadlocks between simultaneous overlapping bookings. Fixed the same day by migration 0020 (see above).
  - No application code changed.
  - Production readiness not claimed.
- **New database tests:**
  - adversarial checks: invitation revocation, concurrent reschedule into one slot, confirm racing cancel, stale-version edits, UI/database transition parity;
  - a query-plan probe on synthetic volume;
  - an application-to-database contract test: every RPC call, column and grant used by `src/`.
- **Two open findings are recorded as expected-failure tests,** which will turn red when corrected:
  - SC-AUD-02, slow free-slot lookup;
  - SC-AUD-03, suspension lifted through an invitation.

### Verified — database foundation (2026-11-10)

- **Database tests now run without Docker.** They use an embedded PostgreSQL 17 (`embedded-postgres`) with a minimal Supabase shim (`tests/db/harness/`): roles, `auth.users`, `auth.uid()`/`auth.jwt()`, default privileges. Setting `TEST_DATABASE_URL` runs them against the local Supabase stack instead.
- **Migrations 0001–0013 and the seed apply cleanly.**
- **Fixed:**
  - concurrent retries with one idempotency key returned `SLOT_UNAVAILABLE` instead of the original appointment (migration 0014);
  - the suspended-member isolation test was too strict (a user may see their own membership row).

### Added — Module 1: authentication and clinic onboarding

- **Sign-up** for clinic owners: email confirmation, with no account enumeration.
- **Password reset:** request, then a new password; other sessions are signed out.
- **Email-link callback** `/[locale]/auth/callback`: PKCE `code` and `token_hash`, same-site redirect only.
- **Onboarding page** `/onboarding`:
  - clinic name, a booking-address slug with a live availability check, city, phone, language;
  - acceptance of the current terms and privacy policy;
  - next step: MFA.
- **Migration 0015:**
  - `create_clinic` now refuses to run until the caller has accepted the current terms of service and privacy policy (`LEGAL_ACCEPTANCE_REQUIRED`);
  - new `is_slug_available()`.
- **Routing:** a staff account without a clinic lands on onboarding; phone accounts land on the portal.
- **Tests:** 6 database tests (legal acceptance, DPA restricted to MFA owners, append-only acceptances, slug check) and 16 unit tests (password policy, slug rules, open-redirect protection, routing).
- **Not verifiable without Supabase Auth (Docker):** the actual email, OTP and TOTP exchanges with GoTrue.

### Added — Module 2: clinic and membership management

- **Team** (`/w/[slug]/team`):
  - members with name, email, role, status and practitioner badge;
  - role change, suspend, reactivate and remove, all with confirmations;
  - open invitations with revoke;
  - invitation dialog returning a one-time acceptance link (token in the URL fragment, only its hash stored). Email delivery comes with Notifications.
- **Invitation acceptance** (`/invite#token`): the signed-in account's confirmed email must match.
- **Settings** (`/w/[slug]/settings`):
  - clinic data processing agreement, accepted by an MFA-verified owner;
  - clinic profile (column grants keep status, slug and time zone out of reach);
  - booking policy;
  - clinic closures.
- **Migration 0016:** `list_clinic_members()` (members.view) and `get_clinic_dpa_status()`.
- **Navigation:** a "Clinique" group (Équipe, Paramètres), shown by permission.
- **Tests:**
  - 6 database tests: member listing scope, NOT_FOUND across clinics, closures by role, booking-policy RLS, BR-T-07 online-booking guard, DPA status;
  - 6 unit tests: role management rules, settings schemas, date-range parsing.

### Added — Module 3: doctor management

- **Doctors page** (`/w/[slug]/doctors`), for `doctors.manage`:
  - create and edit a practitioner (name in French and Arabic, specialty, professional phone, INPE);
  - optional link to a member account of the same clinic (database composite FK);
  - online-bookable flag;
  - deactivate and reactivate. Deactivation shows how many future appointments remain booked, and does not cancel them.
- **Offered services**: one dialog per doctor, with optional duration and price overrides. It is saved by the new atomic command `set_doctor_services` (migration 0017). Unselected services are deactivated, never deleted, because past appointments still reference them.
- **Migration 0017:** `set_doctor_services()` and `count_future_appointments()`.
- **Catalog actions:** also prepared for services (create, edit, archive), used by Module 5.
- **Tests:**
  - 6 database tests: account link limited to the same clinic, role refusals, atomic replace, full rollback on an invalid item, cross-clinic and permission refusals, future-appointment count;
  - 7 unit tests: doctor and service schemas, 5-minute steps, decimal comma.

### Fixed — concurrent booking retries (2026-11-11)

- **Deadlock under concurrent retries.** Retries of one booking with the same idempotency key could deadlock (`40P01`) through the unique key index and the exclusion constraint. The concurrency suite caught it intermittently. Migration 0019 serializes same-key requests with a transaction-scoped advisory lock. The full database suite then passed three times in a row.

### Added — Module 4: patient management

- **Atomic registration:** `register_patient` creates the record and its consents in one transaction (migration 0018). This closes the two-write gap noted in Phase 4.
- **Patient file** (`/w/[slug]/patients/[id]`):
  - identity and contact;
  - consents, current decision plus history;
  - appointments;
  - possible duplicates.
  - Opening it writes `patient.viewed` to the audit log (BR-D-03, through `get_patient`). Practitioner-only doctors get NOT_FOUND for patients who are not theirs.
- **Edit, archive and restore:** archiving uses a command, because `status` is not a grantable column.
- **Consents:** grant or withdraw a decision (append-only history).
- **Duplicate merge:**
  - the merged record becomes history (`merged_into_id`), and its appointments stay attached to it, since patient ids are immutable on appointments;
  - portal links move to the surviving record;
  - the surviving file shows both histories.
- **Tests:**
  - 8 database tests: atomic rollback, origin and role refusals, audit of views, doctor scope, archive permissions, duplicate detection, merge rules;
  - 2 unit tests: update schema, column mapping.

### Added — Phase 4: design system and workspaces (2026-11-10)

- **Next.js 16 application** (App Router, TypeScript strict, Tailwind CSS 4), with French and Arabic routing (`/fr`, `/ar`) and a proxy for session refresh.
- **Design tokens and typography:**
  - semantic colors (navy structure, muted teal accent, status tones);
  - IBM Plex Sans + Plex Sans Arabic;
  - 6-step type scale.
  - See [UI_UX_GUIDELINES.md](UI_UX_GUIDELINES.md).
- **Components** (`src/shared/ui`): button, form controls, field, badge, data table + skeleton, dialog, confirm dialog, dropdown menu, toasts, empty/error/unavailable states, page header, section, metric strip, application shell (rail + drawer, RTL-aware).
- **Workspaces, backed by the database through RLS:**
  - clinic dashboard (today's figures computed from records);
  - reception (day agenda; book, confirm, move, cancel, mark absent);
  - doctor's day;
  - patients (search, registration with consents);
  - patient portal (linked appointments);
  - platform administration (clinic lifecycle).
- **Sign-in screens:** staff email/password, TOTP MFA enrollment and verification, patient phone OTP.
- **Migration 0013** (read-only): `platform_list_clinics()`, `portal_list_my_appointments()`, `private.require_authenticated()`.
- **Development-only gallery:** `/[locale]/design-system` and `/[locale]/design-system/shell`.
- **Tests:** 43 unit and component tests (formatting, time zones, phone numbers, error mapping, status rules, KPI computation, schema validation, dictionary parity, Field, DataTable, MetricStrip, ConfirmDialog).

### Added — Phase 3: database foundation (2026-11-10)

- Migrations 0001–0012: identity, tenancy, catalog, scheduling, patients, appointments, compliance, RBAC, RLS, audit, commands. See [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md).
- Synthetic development seed and database integration tests (`tests/db/`).

### Not yet verified

- ~~Database migrations and database tests have not run yet.~~ Superseded on 2026-11-10: they run on an embedded PostgreSQL (see "Verified — database foundation").
- The Supabase Auth flows (email links, SMS OTP, TOTP) have not run end to end: the local Supabase stack needs Docker, which is unavailable on the development machine.
- The workspaces were checked visually with no backend ("service unavailable" states, the gallery, RTL), not yet with live data.
