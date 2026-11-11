# SmartClinic — Phase 0 Repository Audit

| | |
| --- | --- |
| Date | 2026-11-10 |
| Phase | 0 — Repository audit (read-only; no code written) |
| Status | **Awaiting approval** before Phase 1 |
| Companion | [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) — sequence and prioritized backlog |

---

## 1. Executive summary

1. **The SmartClinic folder is empty.** There is no source code, `package.json`, git repository, environment file, Supabase configuration or documentation. Nothing inside it needs preserving or migrating.
2. **A sibling project, `../CLINPILOT`, is the same product on a different stack.** It is a B2B clinic SaaS for independent doctors and clinics in Nador, in French and Arabic. Its stack is FastAPI, SQLAlchemy/Alembic, self-hosted PostgreSQL with RLS, Redis, first-party auth with TOTP MFA, and a Next.js 16 front end. It stands at the end of Sprint 2. Auth, tenancy, invitations, RLS and the fr/ar shell are marked "verified" in its own status file, backed by 163 API tests, 209 web tests and 9 Playwright E2E tests. Those runs were not repeated during this audit.
3. **The master prompt prescribes a Supabase + Next.js stack**, which replaces most of CLINPILOT's backend: Python API, own sessions/MFA/CSRF, Redis/Celery plans and Docker/Caddy infrastructure. **Decision D-0 (§6) is needed before Phase 1.** The choice is between building SmartClinic fresh on Supabase (recommended) and continuing CLINPILOT. The recommended path reuses CLINPILOT's non-code assets: decisions, regulatory checklist, translations, design tokens and test scenarios.
4. **Workstation:** Node 22.15, pnpm 12.16.1, git 2.47 and Docker 28.5 are installed. The **Supabase CLI is not installed** and the **Docker daemon was not running**. Only **1.5 GB of 15.8 GB RAM was free**, and a full local Supabase stack will strain this machine (risk R9).
5. **Top risks:**
   - cross-tenant leakage through RLS that browsers can query directly;
   - double booking under concurrent requests;
   - Morocco's Ramadan UTC+0 switch breaking slot generation;
   - health data hosted outside Morocco (neither Supabase nor Vercel has a Moroccan region), which needs CNDP clearance;
   - duplicated or stale notifications;
   - free-tier platform limits that block a commercial pilot.
6. **Recommended next phase:** Phase 1, product and domain modeling, written as documentation only. It starts after D-0 is decided and the ambiguities in §12 are answered or their defaults accepted.

---

## 2. Audit method

**Inspected (read-only)**

- SmartClinic folder: full listing including hidden files; git status of the folder and its parent.
- Toolchain: Node, npm, pnpm, yarn, git, Docker (client and daemon), Supabase CLI, psql, GitHub CLI, Vercel CLI.
- Machine resources: RAM, disk, CPU.
- `../CLINPILOT`, chosen because its name and content match the product:
  - directory tree (depth 3), README, `docs/IMPLEMENTATION_STATUS.md`, documentation headings;
  - accepted decisions, security gaps, regulatory checklist and roadmap;
  - the web app's `package.json` and git log;
  - whether `.env` is git-ignored. It is: only `.env.example` is tracked.

**Deliberately not done**

- CLINPILOT's `.env` was **not opened**.
- Other sibling folders (AVELOR, CarDrive, INTELPROD, NEXORA, StudRoom, web_site_club, winter-fashion) are unrelated by name and were not inspected.
- No code was modified, no packages were installed, no `git init` was run and no tests were run.

---

## 3. Repository structure analysis

| Item | Finding |
| --- | --- |
| Folder contents | Empty: no files, no hidden files |
| Git | Not a repository. The parent folder is not one either |
| `package.json` / lockfile | None |
| Environment configuration | None (no `.env`, `.env.example` or environment schema) |
| Supabase configuration | None (no `supabase/` directory, no linked project) |
| Documentation | None before this audit |
| CI/CD | None |

**Consequence:** inside SmartClinic, "preserve existing work" applies to nothing. The only existing work at risk is CLINPILOT. This audit did not modify it, and no later phase should modify it unless D-0 says so.

---

## 4. Technology stack and environment

### 4.1 Workstation

| Tool | Found | Assessment |
| --- | --- | --- |
| Node.js | v22.15.0 | OK; supported by current Next.js |
| npm | 10.9.2 | OK |
| pnpm | 12.16.1 | **Recommended package manager** (already used in CLINPILOT) |
| yarn | Not installed | Not needed |
| git | 2.47.0 (Windows) | OK |
| Docker | 28.5.1 client; **daemon not running** | Needed for the local Supabase stack. Start Docker Desktop |
| Supabase CLI | **Not installed** | Required for migrations, local stack, type generation and `supabase test db` |
| psql | Not installed | Optional; the Supabase CLI covers most needs |
| GitHub CLI (`gh`) | Not installed | Optional; useful to check CI results |
| Vercel CLI | Not installed | Optional; Git-based deploys work without it |
| RAM | 15.8 GB total, **1.5 GB free** at audit time | Tight for Docker + local Supabase + Next.js dev + tests (R9) |
| Disk (C:) | 90.5 GB free | OK |
| CPU | 8 logical cores | OK |

### 4.2 Prescribed stack: status

None of the prescribed stack is present yet. Exact versions will be pinned when the project is scaffolded (Phase 4 foundation). CLINPILOT pins the following, which is a known-working baseline on this machine:

> Next.js 16.4.5 · React 19.3.1 · Tailwind CSS 4.3.4 · Zod 4.6.7 · TypeScript 6.0.3 · Vitest 5.1.0 · next-intl 4.14.9 · React Hook Form 7.91.0 · ESLint 9.39.5

---

## 5. Current implementation status

### 5.1 SmartClinic

Nothing is implemented. All 16 modules are **not started**.

### 5.2 Related prior work: CLINPILOT

Statuses below are quoted from CLINPILOT's own `IMPLEMENTATION_STATUS.md` (last updated 2026-11-05) and were not re-verified.

| Area | CLINPILOT status | Reusable in SmartClinic (Supabase stack)? |
| --- | --- | --- |
| Product requirements and accepted decisions D1–D10 | Documented | **Yes.** Port after review: overbooking flag (D10), no marketplace (D6), manual MAD invoicing (D7), hosting decision pending (D1) |
| Law 09-08 / CNDP checklist; notification content rules | Documented | **Yes**, almost unchanged |
| French and Arabic message dictionaries (237 lines each) | In use | **Partly.** Auth, team and settings strings; keys need restructuring |
| Design tokens (navy `#10283B`, turquoise `#55D6C2`), UX guidelines, RTL rules | Documented and implemented | **Yes.** Reconcile with this prompt's palette (navy, teal/green, amber, red) |
| Moroccan phone normalization; `Africa/Casablanca` handling; Western digits in Arabic | Implemented in TypeScript | **Yes**; the logic is portable |
| Test scenarios: cross-clinic isolation, last-owner protection, invitations, E2E flows | Tested | **As scenario lists**; the code must be rewritten for Supabase |
| FastAPI modules, SQLAlchemy models, Alembic migrations, sessions/MFA/CSRF, OpenAPI client | Verified | **No.** Replaced by Supabase Auth, SQL migrations, RLS and supabase-js |
| Docker Compose, Caddy, Postgres role scripts | Verified | **No.** Replaced by the Supabase CLI local stack and Vercel |
| Lessons: bidi-control ("Trojan Source") scan in CI, low-memory build failures, IPv6 `localhost` stalls on Windows | Recorded | **Yes** |

---

## 6. Decision D-0 — SmartClinic and CLINPILOT

| Option | For | Against |
| --- | --- | --- |
| **A. Fresh build on the prescribed Supabase stack** (CLINPILOT frozen as reference) | Matches the master prompt. One language (TypeScript). Managed Auth/MFA, Realtime, Storage, backups and queues mean far less to operate: no Redis, Celery, Caddy or Python runtime. Short path to Vercel. | Discards about two sprints of verified backend work. RLS becomes the only barrier for direct browser queries, so policy quality is critical. Hosting is limited to Supabase regions, none of them in Morocco. |
| **B. Continue CLINPILOT under the SmartClinic name** | Keeps verified work. Full hosting control, including hosting in Morocco if the law requires it. | Contradicts the prompt's stack. More infrastructure for a small team to run. Two languages to maintain. |
| C. Hybrid: Supabase Postgres + keep FastAPI | — | Pays the cost of both stacks and loses the Supabase Auth ↔ RLS integration. **Not recommended.** |

**Recommendation: Option A**, provided the Supabase stack in the master prompt is a deliberate choice. Port the reusable assets listed in §5.2.

**Reversal condition:** if counsel concludes that patient data must be hosted in Morocco (R4), Option B becomes the better choice. Get counsel's view before real patient data is processed. Before Phase 8 (deployment) is the latest point.

---

## 7. Missing components

Everything is missing. The table groups it by layer.

| Layer | Missing |
| --- | --- |
| Repository | `git init`, private remote, `.gitignore`, `.editorconfig`, `.gitattributes` (line endings on Windows) |
| Tooling | Next.js app, strict `tsconfig`, ESLint (with module-boundary rules), Prettier, Vitest, React Testing Library, Playwright, fast-check for property tests |
| Configuration | Zod-validated environment schema (server and public variables kept apart); `.env.example` |
| Supabase | Supabase CLI, `supabase/config.toml`, migrations, seed, pgTAP tests, generated types, dev/staging/prod projects |
| CI/CD | GitHub Actions (lint, typecheck, unit, DB tests, E2E, build), gitleaks, dependency audit, Vercel project |
| Modules 1–16 | All not started. The MVP cut is in the roadmap |
| Documentation | Of the 15 required documents, only the roadmap exists (plus this audit). The rest are produced by their phases (§13.2) |

---

## 8. Proposed architecture

### 8.1 System context

```
 Patients (mobile web) ───┐                          ┌── Email provider (transactional)
 Clinic staff (desktop) ──┼──► Next.js on Vercel ────┼── SMS provider (WhatsApp later)
 Platform admins ─────────┘     (one app, five        └── no other third parties in MVP
                                 workspaces)
                                  │        ▲
                    queries / RPC │        │ Realtime broadcast (private channels)
                                  ▼        │
            Supabase: PostgreSQL (RLS) · Auth · Realtime · Storage · Queues / pg_cron
```

- **One Next.js App Router application** (modular monolith), deployed to Vercel. The five workspaces (patient, clinic administration, reception, doctor, platform) are route groups in this one app, not separate deployments.
- **Supabase** provides PostgreSQL, Auth (email and password for staff, phone OTP for patients, TOTP MFA), Realtime, Storage and scheduled/queued jobs.
- **Region:** an EU region close to Morocco (for example Paris), with Vercel functions in the same region. This is pending the legal review (R4).

### 8.2 Module layout and boundaries

```
src/
  app/[locale]/
    (public)/          landing page, clinic booking page  /c/[clinicSlug]
    (auth)/            staff sign-in, MFA, patient OTP
    (patient)/me/      patient portal
    (workspace)/w/[clinicSlug]/   admin · reception · doctor views (role-gated on the server)
    (platform)/platform/          SUPER_ADMIN, separate authorization path
  app/api/             route handlers: cron/worker, provider webhooks, public booking endpoints
  modules/<module>/
    domain/            pure TypeScript: types, state machines, rules, wait estimator (no I/O)
    schemas.ts         Zod input schemas, shared by forms and the server
    application/       use cases: authorize → validate → call infrastructure → map errors
    infrastructure/    Supabase queries and RPC wrappers (typed by generated DB types)
    ui/                module-specific presentational components
    index.ts           the module's public interface; other modules import only this
  shared/ui/           design system (shadcn/ui based), tokens, layout shell
  shared/lib/          Supabase clients, i18n, errors, formatting
  server/privileged/   service-role client; importable only from workers, webhooks and platform code
supabase/
  migrations/ · tests/ (pgTAP) · seed.sql · functions/ (Edge Functions, if used)
messages/fr.json · messages/ar.json
e2e/                   Playwright
```

ESLint `no-restricted-imports` enforces the boundaries (built in; no extra dependency):

- No deep imports from one module into another.
- No use of `server/privileged` outside its allowed callers.
- No Supabase client imports in `domain/`.

### 8.3 Where business rules live

| Kind of rule | Location | Why |
| --- | --- | --- |
| Invariants that must survive concurrency or a direct API call: tenant consistency, no double booking, legal state transitions, gapless invoice numbers, append-only history | **PostgreSQL**: constraints, exclusion constraints, triggers, RLS, RPC functions in transactions | Browsers can call the Supabase API directly, so only the database is a real boundary |
| Orchestration, permission checks that produce user-facing messages, i18n errors, provider calls | **Application services** (Server Actions and Route Handlers) | Testable and typed; keeps React components thin |
| Pure computation: wait-time estimator, slot display, state-machine metadata for the UI | **Domain layer** (TypeScript) | Fast unit and property tests |
| Visibility of buttons and navigation | **UI** | Convenience only; the server enforces permissions |

**No duplicated rules.** The appointment transition table lives in SQL. The TypeScript copy, used to show the right buttons, is checked against it by a database test, so the two cannot drift. Role permissions follow the same pattern (§9.3).

### 8.4 Request path and tenant resolution

1. The URL carries the clinic: `/[locale]/w/[clinicSlug]/…`.
2. For each request, the server resolves slug → clinic and loads the caller's membership and role for `auth.uid()`, cached per request. A `clinic_id` sent by the client is never trusted.
3. Data access uses the **user-scoped** Supabase client: publishable/anon key plus the user's session cookie through `@supabase/ssr`. RLS therefore applies to every query, on the server and in the browser.
4. Authorization on the server uses verified identity (`auth.getUser()` or `auth.getClaims()`), never an unverified `getSession()` result.
5. The **service-role key** is used only by background workers, provider webhooks and SUPER_ADMIN operations. It lives in `server-only` modules, and each use records the acting principal in `audit_logs`.

### 8.5 Real-time (SmartFlow)

- Supabase Realtime **Broadcast on private channels**, authorized by RLS policies on `realtime.messages`, for example a channel per clinic, doctor and day.
- Database triggers emit **invalidation hints** (entity id and version), never patient details. Clients refetch through RLS-protected queries.
- Postgres Changes is avoided for queue updates: Supabase checks every change against every subscriber, which limits throughput and multiplies RLS work.
- Waiting-room screens use a **display token** scoped to one clinic and day. They show ticket numbers only, never names.

### 8.6 Background work (notifications, reminders, retention)

- **Transactional outbox:** the business transaction (for example "appointment confirmed") inserts `notifications` rows in the same transaction, each with a **unique idempotency key** (appointment, event, channel, scheduled time).
- **Worker:** pg_cron triggers a worker every minute; Supabase Queues (pgmq) or `FOR UPDATE SKIP LOCKED` are the candidates. The worker is a Supabase Edge Function or a Vercel route on a paid plan (R7). It claims due rows, **re-reads the appointment's current status** and skips stale reminders. It then sends, records the provider message id and status, retries with backoff and dead-letters after N attempts.
- Reminder times are computed in `Africa/Casablanca`, then stored as UTC instants.

### 8.7 Internationalization

- `next-intl`; locale in the URL (`/fr/…`, `/ar/…`) and persisted in the user's profile and a cookie.
- `<html lang dir>` per locale. Direction-aware styling uses Tailwind logical utilities (`ms-*`, `pe-*`, `start-*`), and shadcn/ui gets a Radix `DirectionProvider`. There is no duplicated Arabic app.
- Dates and times through `Intl` in `Africa/Casablanca`.
- Arabic uses **Western digits** (`ar-MA` with the `latn` numbering system), as CLINPILOT decided; to be confirmed (A16). Currency is MAD.
- A CI check fails when a key exists in one dictionary but not the other, or when JSX contains hard-coded UI strings.

### 8.8 Error-handling strategy

- Application services return a typed result (`ok` / `error` with a stable code). Exceptions are reserved for genuinely unexpected failures.
- PostgreSQL errors map to domain codes:

  | PostgreSQL | Domain code |
  | --- | --- |
  | `23P01` (exclusion) | `SLOT_UNAVAILABLE` |
  | `23505` (unique) | `DUPLICATE` |
  | `23503` (foreign key) | `INVALID_REFERENCE` |
  | `42501` or an empty result under RLS | `NOT_FOUND`, so the response never confirms that another clinic's record exists |
  | RPC `RAISE … USING ERRCODE = 'P0001'` with codes such as `APPT_INVALID_TRANSITION` | That code |

- Every code has French and Arabic text.
- Unexpected errors are logged with a request id and **no patient data**.

---

## 9. Database design recommendations

### 9.1 Conventions

- `uuid` primary keys (`gen_random_uuid()`); `created_at` and `updated_at` as `timestamptz` (trigger-maintained).
- **All instants are `timestamptz`.** Recurring schedules are stored as local wall-clock `time` values plus the clinic `timezone` (default `Africa/Casablanca`). They are converted to UTC per date with the time-zone database, never with a fixed offset.
- **Tenant consistency in the schema:**
  - every tenant-owned table has `clinic_id uuid not null` and `unique (clinic_id, id)`;
  - child tables reference parents through **composite foreign keys**, for example `(clinic_id, doctor_id) references doctors (clinic_id, id)`.
  - This guarantees at the database level that an appointment's doctor, patient and service all belong to the same clinic. RLS alone cannot guarantee that.
- Indexes start with `clinic_id`. RLS helper functions are called as `(select …)` so PostgreSQL evaluates them once per statement.
- Records near clinical care are **never hard-deleted** by users: appointments are cancelled and patients are archived. Hard deletion happens only through documented retention jobs.
- **Migrations:** small, one concern each, grouped per module, each with pgTAP tests. The Supabase CLI applies migrations forward only, so "reversible" means a written compensating migration that is tested in CI where feasible.

### 9.2 Identity

- Use Supabase **`auth.users`** as the identity table, with **`public.user_profiles`** 1:1 (`id = auth.users.id`; display name, phone, preferred locale).
- The prompt lists both `users` and `user_profiles`. Recommend **no separate `public.users` table**: duplicating `auth.users` invites drift (A2).

### 9.3 Membership and RBAC

- `clinic_members (clinic_id, user_id, role, status)` with `unique (clinic_id, user_id)` and one administrative role per membership.
- **Independent doctors:** a doctor who owns their practice is `CLINIC_OWNER` with a linked `doctors` row (`doctors.user_id`). Practitioner capability comes from that link, not from the role. This avoids multi-role memberships (A3).
- **SUPER_ADMIN** is not a clinic role. It lives in a separate `platform_admins` table, requires MFA (`aal2`) and has **no access to patient tables by default** (A11).
- **Permissions:**
  - a seeded `role_permissions` table is the single source of truth;
  - SQL helpers such as `private.has_permission(clinic_id, 'appointments.write')` read it, as `STABLE SECURITY DEFINER` with `search_path = ''`, in a schema the Data API does not expose;
  - TypeScript permission types are generated from it.
  - This also avoids recursive RLS policies on `clinic_members`.

### 9.4 Medical organization and scheduling

- `specialties` (platform reference data); `services` (clinic-scoped; duration and price); `doctors` (clinic-scoped; **one row per doctor per clinic**, optional `user_id`; A4); `doctor_services` (composite FKs; optional duration or price override).
- `doctor_availability`: weekday, local start and end time, and a validity window. The window allows date-bounded overrides such as **Ramadan hours** without editing the normal week.
- `doctor_time_off`: `tstzrange`, with a GiST index.
- `clinic_branches`: deferred until a pilot clinic needs it (A12).

### 9.5 Appointments

- Columns:
  - `starts_at` and `ends_at` (`timestamptz`), with `check (ends_at > starts_at)`;
  - status enum: `pending, confirmed, checked_in, in_progress, completed, cancelled, no_show`;
  - `source`: `staff | patient_portal | walk_in`;
  - `is_overbooked`;
  - `idempotency_key`, unique per clinic;
  - cancellation fields: who, when, reason.
- **Double booking** is prevented by an exclusion constraint (needs `btree_gist`):

  ```sql
  EXCLUDE USING gist (
    clinic_id WITH =, doctor_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('pending','confirmed','checked_in','in_progress') AND NOT is_overbooked)
  ```

- **`book_appointment()` RPC**, one transaction, in this order:
  1. Check that the service is offered by the doctor.
  2. Derive the duration from the service on the server.
  3. Check that the slot falls inside availability.
  4. Check that it falls outside time off.
  5. Apply the clinic's booking rules: minimum lead time, booking horizon, patient limits.
  6. Insert. The exclusion constraint is the final concurrency guard.
- **State transitions** go only through an RPC that checks the transition table. A trigger writes `appointment_status_history` (actor, from, to, reason, time), which is append-only.
- **Overbooking (A8):** only roles with explicit permission may set `is_overbooked`. It is audited and visible in the UI.

### 9.6 Patients

- `patients`: clinic-scoped. **The phone number is not unique**, because families share numbers. The record holds minimal data: name, date of birth, sex if needed, phone, preferred language and communication preferences. Avoid national ID (CIN) numbers unless a concrete need appears.
- `patient_accounts (user_id, clinic_id, patient_id)` links a portal user (phone OTP) to one or more clinic-scoped patient records, including dependents such as children (A5). Each link is verified.
- `patient_consents (patient_id, purpose, version, granted_at, revoked_at)`.

### 9.7 Reception and queue

- `queue_entries`:
  - one per appointment (`unique (appointment_id)`);
  - `(clinic_id, doctor_id, service_date, ticket_number)` unique; ticket numbers come from a per-day counter row locked in the same transaction;
  - status, priority, plus `priority_reason` and `priority_set_by` (a human decision, never automatic triage);
  - check-in, call, start and end times, and `estimated_start_at`.
- `queue_events`: append-only.
- Walk-ins create an appointment with `source = walk_in`, directly in `checked_in` (A9). Queue, billing and analytics then share one record.

### 9.8 Billing

- `invoices` with **gapless sequential numbers per clinic and year**, from a counter table locked in the same transaction. A database sequence would leave gaps after rollbacks.
- Amounts as `numeric(12,2)` with `currency = 'MAD'` (check constraint).
- Status: `draft → issued → partially_paid → paid`, or `void`. **Issued invoices are immutable** (trigger); corrections are made by voiding or with a credit note.
- `payments`: method, amount (`> 0`), date, and who recorded it. The sum of payments may not exceed the invoice total; this is checked in the RPC.
- Moroccan invoice requirements (ICE and IF mentions, VAT treatment of medical services, numbering) must be **validated with a qualified accountant**.

### 9.9 Notifications, subscriptions, audit, storage

- `notification_templates`: per event, channel and locale (fr/ar), versioned. `notifications` is the outbox (§8.6).
- `subscription_plans`, `subscription_features` (limits), `subscriptions` (per clinic). Limits are enforced inside the RPCs, for example the maximum number of doctors.
- `audit_logs`:
  - **append-only**: `UPDATE` and `DELETE` are revoked from every application role, and inserts happen only through triggers or definer functions;
  - each row records actor, clinic, action, entity, entity id, changed field names and a request id;
  - **no full patient payloads**.
- Storage: private buckets; object paths prefixed with `clinic_id`; storage RLS through the same helpers; short-lived signed URLs. The MVP stores only clinic logos and invoice/receipt PDFs, with **no patient documents**.

---

## 10. Security gaps and required controls

No code exists yet, so each "gap" below is a control that must be built in from the first migration.

| # | Control | Why | When |
| --- | --- | --- | --- |
| S1 | RLS enabled in the same migration that creates each table; a CI meta-test fails if any table in an exposed schema lacks RLS | Browsers can query the Data API directly | Phase 3, every migration |
| S2 | Cross-tenant pgTAP tests for every tenant table: read, insert, update, delete as a member of another clinic, as a patient and as `anon` | Proves isolation instead of assuming it | Phase 3 onwards |
| S3 | Revoke default table privileges from `anon`. Public booking goes through narrow RPCs, not table grants | Least privilege | Phase 3 |
| S4 | Helper functions in a non-exposed `private` schema; every `SECURITY DEFINER` function sets `search_path = ''` | Prevents search-path hijacking and API exposure of helpers | Phase 3 |
| S5 | Service-role key server-only: `server-only` package, ESLint import rule, environment schema that rejects `NEXT_PUBLIC_` secrets | A leaked key bypasses all RLS | Phase 4 |
| S6 | TOTP MFA for CLINIC_OWNER, CLINIC_ADMIN and SUPER_ADMIN, enforced **in RLS/RPCs** through `auth.jwt()->>'aal' = 'aal2'`, not only in the UI | Privileged accounts are the most valuable target | Slice S1 |
| S7 | Patient OTP abuse controls: CAPTCHA (Supabase Auth supports Turnstile and hCaptcha), Auth rate limits, per-number limits, +212 numbers only at first | SMS pumping / toll fraud | Slice S7 |
| S8 | Application rate limiting without Redis: a PostgreSQL-backed limiter for booking and other sensitive endpoints, plus Vercel firewall rules | The prompt asks for rate limiting and forbids unjustified Redis | Slice S4 / S7 |
| S9 | No patient data in logs, error reports or analytics. No third-party analytics in clinic workspaces | Law 09-08 data minimization | Phase 4 onwards |
| S10 | Notification content: no specialty, reason or clinical detail in SMS or WhatsApp; neutral sender name; links carry opaque, expiring tokens only | A specialist's name can itself be sensitive | Slice S6 |
| S11 | Security headers and a nonce-based CSP through the Next.js proxy; `frame-ancestors 'none'` | XSS and clickjacking | Phase 4, tightened in Phase 7 |
| S12 | Supply chain: exact version pins, lockfile, `pnpm audit`, automated dependency updates, gitleaks and a bidi-control scan in CI | Dependency and secret risk | Phase 4 |
| S13 | Backups: Supabase point-in-time recovery (paid add-on) and a **rehearsed restore** before any real data | Recovery | Phase 8 |
| S14 | Separate Supabase projects for dev, staging and prod. Synthetic data only outside prod. No real patient data anywhere until CNDP clearance | Legal and blast radius | Phase 4 / 8 |
| S15 | Retention schedule and patient-rights procedures (access, rectification, objection); breach-notification procedure | Law 09-08 | Legal track; implemented in Phase 8 |

---

## 11. Technical risks

| ID | Risk | Impact | Mitigation |
| --- | --- | --- | --- |
| R1 | A missing or wrong RLS policy exposes another clinic's data | **Critical** | Composite FKs; shared helper functions; S1/S2 tests per table; review checklist for every migration |
| R2 | Double booking from concurrent requests | High | Exclusion constraint, `book_appointment()` RPC, idempotency keys; an automated concurrent-booking test |
| R3 | Time-zone errors. Morocco is UTC+1 but switches to UTC+0 during Ramadan, on dates set by government decree each year | High | Wall-clock schedules converted per date with tzdata; property tests across the switch dates. Keep Node/ICU current (Supabase controls PostgreSQL's tzdata). A maintenance procedure re-anchors future appointments if an announced date differs from tzdata's prediction |
| R4 | Data residency: neither Supabase nor Vercel has a Moroccan region. Health data is likely "sensitive" under Law 09-08, so prior CNDP authorization and a transfer assessment are likely needed | **Critical (legal)** | Synthetic data only until counsel signs off. Choose an EU region and co-locate Vercel functions. Keep the schema portable (plain PostgreSQL) so hosting can move if required |
| R5 | Duplicate, late or stale notifications | High | Outbox, unique idempotency keys, re-check of status at send time, retry and dead-letter, duplicate-send tests |
| R6 | SMS cost: Arabic text is sent as UCS-2, 70 characters per segment instead of 160, roughly doubling cost | Medium | Short templates, segment counting in tests, channel and language preference per patient |
| R7 | Platform-tier limits. Vercel Hobby is for non-commercial use and limits cron frequency. Supabase Free pauses inactive projects and has no point-in-time recovery. Verify current terms at deployment time | Medium | Budget paid tiers (Vercel Pro, Supabase Pro + PITR) before the pilot; drive jobs from pg_cron, which removes the dependency on Vercel cron |
| R8 | Realtime load or leaks | Medium | Broadcast on private channels, hint-only payloads, token-scoped waiting-room displays |
| R9 | Workstation resources: 1.5 GB free RAM at audit time; the full local Supabase stack runs about 10 containers | Medium | `supabase start -x` to skip unused services (Studio, imgproxy, analytics, vector, edge runtime when not needed). Cap Docker Desktop's memory. Run Vitest with few workers. Fallback: a hosted dev project with synthetic data |
| R10 | Scope: 16 modules for a small team | High | Vertical slices with exit criteria, a strict MVP cut (roadmap), no phase skipped |
| R11 | Supabase lock-in | Low–Medium | Business rules in plain PostgreSQL and TypeScript modules. Auth is the main coupling, isolated behind the identity module |
| R12 | Rules duplicated between SQL and TypeScript drift apart | Medium | The database is the source of truth; parity tests (§8.3) |
| R13 | Arabic copy quality and RTL defects | Medium | Native review of copy and templates; Playwright screenshots in both directions |
| R14 | Reception workflows in Nador differ from assumptions (phone booking, paper ledgers, shared phones) | High (product) | Observe 2–3 real front desks before finalizing the reception and SmartFlow designs (Phase 1) |

---

## 12. Ambiguities in the master prompt — decisions needed for Phase 1

Each row has a recommended default. Phase 1 proceeds with these defaults unless you choose otherwise.

| # | Question | Recommended default |
| --- | --- | --- |
| D-0 | SmartClinic vs CLINPILOT (§6) | **Option A**: fresh Supabase build; CLINPILOT as reference |
| A1 | Product name and domains | "SmartClinic". Domains to be confirmed |
| A2 | `users` table vs Supabase `auth.users` | `auth.users` + `public.user_profiles`; no `public.users` |
| A3 | An owner who is also the clinic's doctor | Role `CLINIC_OWNER` + linked `doctors` row; one role per membership |
| A4 | A doctor working in several clinics | One `doctors` row per clinic, owned by that clinic, joined by the optional `user_id` |
| A5 | Patient portal identity | Phone OTP. One account links to several clinic-scoped patient records and dependents; each link verified |
| A6 | Booking channel | Clinic-specific booking link and QR code only; **no public marketplace** in the MVP (medical-advertising rules to be checked with counsel) |
| A7 | Status of a patient-booked appointment | Configurable per clinic; default `pending` until staff confirm |
| A8 | "Conflicts must be prevented" vs real-world overbooking | Allowed only by permitted staff, with an explicit flag, audited, and excluded from the constraint |
| A9 | Are walk-ins appointments? | Yes: `source = walk_in`, created directly in `checked_in` |
| A10 | Queue granularity | Per doctor per day |
| A11 | SUPER_ADMIN access to patient data | None by default; a time-boxed, audited break-glass process can come later |
| A12 | Clinic branches | Deferred until a pilot clinic needs them |
| A13 | Clinic onboarding | Self-signup creates the clinic as `pending_approval`; SUPER_ADMIN approval enables public booking |
| A14 | How clinics pay the subscription | Manual invoicing / bank transfer during the pilot; no payment gateway |
| A15 | Clinical data in the MVP | No consultation notes, diagnoses, prescriptions or documents. An optional short visit reason visible to staff only |
| A16 | Digits in the Arabic UI | Western digits (0–9) |
| A17 | Hosting region | EU (for example Paris), pending counsel; synthetic data only until CNDP clearance |
| A18 | Notification providers | Email first (provider to choose); SMS provider to choose, with a custom provider allowed through Supabase's Send SMS hook; WhatsApp after Meta Business verification |

---

## 13. Proposed implementation sequence

### 13.1 Sequence

The full sequence, exit criteria and prioritized backlog are in [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md). In short:

1. **Phase 1** — Product and domain modeling (documents only).
2. **Phase 2** — System architecture (diagrams, ERD, API contracts, security model).
3. **Phase 3** — Database foundation: identity, tenancy, RBAC, audit, RLS helpers, the test harness.
4. **Phase 4** — Project scaffold, design system, fr/ar shell, CI.
5. **Phase 5** — Vertical slices, in order:
   1. identity and tenancy;
   2. practice setup;
   3. patients;
   4. appointments;
   5. reception and SmartFlow;
   6. notifications;
   7. patient portal;
   8. billing;
   9. analytics;
   10. platform admin and subscriptions.

   Each slice adds its own migrations on top of the Phase 3 foundation.
6. **Phases 6–9** — Integration, QA, deployment, pilot.

### 13.2 Which phase produces each required document

| Document | Phase |
| --- | --- |
| PRODUCT_REQUIREMENTS, DOMAIN_MODEL, BUSINESS_RULES, RBAC_PERMISSION_MATRIX, USER_WORKFLOWS | 1 |
| SYSTEM_ARCHITECTURE, DATABASE_ERD, API_SPECIFICATION, SECURITY_MODEL | 2 |
| DATABASE_SCHEMA | 3, updated by every slice |
| UI_UX_GUIDELINES, TESTING_STRATEGY | 4 |
| DEPLOYMENT_GUIDE | 8 |
| DEVELOPMENT_ROADMAP | 0 (this audit), then maintained |
| CHANGELOG | Starts with the first code commit (Phase 3/4) |

---

## 14. Recommended next phase

**Phase 1: product and domain modeling.** This phase is documentation only. It produces the five Phase 1 documents in §13.2: functional and non-functional requirements, user stories and use cases, entities and relationships, state machines (appointment, queue entry, invoice, notification, clinic), the permission matrix and acceptance criteria.

**Before starting**

1. Decide **D-0**.
2. Confirm or change the defaults for **A1–A18**.

**In parallel (no code, no risk)**

- Install the Supabase CLI.
- Start Docker Desktop and set a memory cap in its settings.
- Free some RAM.
- Approve `git init` of this folder with a **private** remote.
- Start the long-lead tracks in the roadmap: legal counsel (CNDP), SMS provider, pilot clinic recruitment.
