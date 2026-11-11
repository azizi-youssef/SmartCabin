# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/). Nothing has been released yet.

## [Unreleased]

### Audit — engineering quality and security (2026-11-11)

- **Report:** [QUALITY_SECURITY_AUDIT.md](QUALITY_SECURITY_AUDIT.md).
  - No CRITICAL finding; 3 HIGH, 8 MEDIUM, 12 LOW.
  - One HIGH, SC-AUD-23, concerns deadlocks between simultaneous overlapping bookings. It makes `concurrency.test.ts` fail intermittently, and it must be corrected before the next module.
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
