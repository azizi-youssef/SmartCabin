# SmartCabin — Development Roadmap

Last updated: 2026-11-11 (modules 1–7 done; audit fixes SC-AUD-23, -02, -16, -18 applied). Basis: [PHASE_0_REPOSITORY_AUDIT.md](PHASE_0_REPOSITORY_AUDIT.md), [MODELING_REVIEW.md](MODELING_REVIEW.md).

> **Current state (2026-11-11):**
> - **Phases 1–2 (models):** delivered. PRODUCT_REQUIREMENTS (user stories and acceptance criteria) is still missing.
> - **Phase 3 (database):** verified on an embedded PostgreSQL 17 with a Supabase shim (Docker is still unavailable). Migrations 0001–0023.
> - **Phase 4 (design system and workspace shells):** implemented. Visual review done without a backend.
> - **Phase 5, business modules 1–7** (auth and onboarding, clinic and membership, doctors, patients, services and availability, staff appointments, reception): done. See [CHANGELOG.md](CHANGELOG.md).
> - **Quality and security audit:** [QUALITY_SECURITY_AUDIT.md](QUALITY_SECURITY_AUDIT.md). SC-AUD-23 is fixed by migration 0020 and SC-AUD-02 by migration 0021. SC-AUD-01 (SMS sign-up abuse) is the remaining HIGH.
>
> **Next step:** module 8, SmartFlow (call, consultation start and end, priorities, corrections, estimates, realtime, displays, doctor console). The Supabase Auth flows and the screens still need an end-to-end run on a real stack (SC-AUD-10).

Phases are scope increments, not calendar commitments. A phase closes only when its exit criteria are **verified by executed tests**, and it is reviewed before the next phase starts.

> This roadmap assumes decision **D-0 = Option A**: a fresh build on Next.js + Supabase. If Option B is chosen, it will be rewritten.

---

## Phases

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| **0. Repository audit** ✅ | Audit report, this roadmap | Audit reviewed; D-0 and A1–A18 answered |
| **1. Product and domain modeling** | PRODUCT_REQUIREMENTS, DOMAIN_MODEL, BUSINESS_RULES (state machines), RBAC_PERMISSION_MATRIX, USER_WORKFLOWS; acceptance criteria per story; MVP cut confirmed; observations from 2–3 real front desks folded in | Documents approved; every MVP story has acceptance criteria; no open ambiguity blocks Phase 2 |
| **2. System architecture** | SYSTEM_ARCHITECTURE (context, components, data flows), DATABASE_ERD, API_SPECIFICATION (Server Actions, Route Handlers, RPCs), SECURITY_MODEL, error-code catalog | Approved; every MVP use case maps to a component, an RPC or table, and a permission |
| **3. Database foundation** | `git init`; Supabase CLI project; migrations for identity, tenancy, RBAC, audit and the RLS helpers; pgTAP harness; generated types; seed; RLS meta-test | `supabase db reset` from scratch succeeds; cross-tenant pgTAP tests pass; RLS meta-test green |
| **4. Scaffold, design system and UX** | Next.js app, strict TypeScript, ESLint boundaries, Vitest, Playwright, CI, environment schema; tokens, typography, shell, tables, forms, dialogs, status badges, empty/loading/error states; fr/ar with RTL | CI green (lint, typecheck, unit, DB tests, build); the shell renders in fr and ar; accessibility scan without serious violations |
| **5. Business modules** | Vertical slices S1–S10 (below), one at a time | Each slice's exit criteria |
| **6. Integration** | End-to-end flows across modules: auth, isolation, booking → check-in → queue → consultation → invoice → analytics; notifications in staging | Playwright suites pass against staging |
| **7. Quality assurance** | Full test pass, RLS security review, load tests on booking and queue, CSP hardening, dependency audit, external penetration test before real data | Documented results; no open critical or high findings |
| **8. Deployment** | Supabase prod (paid tier + PITR), Vercel Pro, region co-location, secrets, monitoring and alerting, backup-restore drill, rollback procedure, DEPLOYMENT_GUIDE | Restore drill timed and documented; go/no-go review passed; CNDP status cleared for real data |
| **9. Pilot** | 2–3 clinics in Nador; measure scheduling reliability, waiting times, reception workload, patient satisfaction and notification delivery | Pilot metrics reviewed; backlog re-prioritized |

---

## Phase 5 — vertical slices (in order)

Each slice follows the 12-step module workflow from the master prompt. Dependencies determine the order.

| Slice | Modules | Depends on | Key exit criteria |
| --- | --- | --- | --- |
| **S1** Identity and tenancy | 1, 2, 3, 15, 16 (staff auth + MFA, clinics, membership, roles, invitations, clinic settings, audit, locale preference) | Phase 3–4 | Owner signs up, enables MFA, invites staff, in fr and ar; last-owner protection; isolation tests through the API and in SQL |
| **S2** Practice setup | 5, 6, 7 (specialties, services, doctors, doctor services, weekly availability, Ramadan overrides, time off) | S1 | Slot generator property tests pass across the Ramadan UTC+0 switch; composite-FK tenant tests |
| **S3** Patients | 4 (clinic-scoped records, search, duplicate hints, consents) | S1 | Shared phone numbers supported; RLS limits doctors to authorized patients |
| **S4** Appointments (staff) | 8 (booking RPC, state machine, history, overbooking flag, idempotency) | S2, S3 | **Concurrent booking test proves no double booking**; every transition tested; history is append-only |
| **S5** Reception and SmartFlow | 9, 10 (today board, check-in, walk-ins, queue, priority overrides, wait estimator v1, realtime broadcast, delay reporting, doctor console) | S4 | E2E: walk-in → check-in → call → consult → complete; estimator unit tests; realtime payloads contain no patient details |
| **S6** Notifications | 11 (outbox, worker, email + SMS adapters, fr/ar templates, preferences, reminders, retries, dedupe) | S4 | Duplicate-send and provider-failure tests; a reminder is not sent after cancellation; delivered in staging |
| **S7** Patient portal | 4, 8 (phone OTP, clinic booking link/QR, booking, manage and cancel, live queue status) | S4, S5, S6 | E2E booking on a small Android viewport; OTP abuse controls in place |
| **S8** Billing | 12 (prices, invoices, items, payments, partial payments, receipts, revenue summary) | S4 | Gapless numbering under concurrency; issued invoices immutable; overpayment rejected |
| **S9** Analytics | 13 (the 8 KPIs from the prompt) | S4, S5, S8 | Every KPI computed from records and matched to fixtures in tests; tenant and permission scoped |
| **S10** Platform admin and subscriptions | 14 (plans, features/limits, subscriptions, clinic approval, platform monitoring) | S1 | DB-level test that platform admins cannot read patient tables; plan limits enforced server-side |

---

## Prioritized backlog

**P0** = required for the pilot · **P1** = desirable for the pilot · **P2** = after the pilot.

| Priority | Item | Slice |
| --- | --- | --- |
| P0 | Staff email/password sign-in, TOTP MFA for owners and admins, password reset | S1 |
| P0 | Clinic creation, `pending_approval` → SUPER_ADMIN approval | S1 / S10 |
| P0 | Membership, roles, invitations, server-side permission checks, audit log | S1 |
| P0 | fr/ar UI with RTL, `Africa/Casablanca` dates, MAD currency | Phase 4 |
| P0 | Services, doctors, availability, time off, Ramadan overrides | S2 |
| P0 | Patient records (minimal data), consents | S3 |
| P0 | Staff booking, state machine, cancellation, no-show, history, double-booking prevention | S4 |
| P0 | Check-in, walk-ins, per-doctor queue, wait estimate (from service durations), realtime board | S5 |
| P0 | Email + SMS confirmation, reminder and cancellation (fr/ar), idempotent, status-checked | S6 |
| P0 | Patient booking through the clinic link/QR with phone OTP; patients can view and cancel their own appointments | S7 |
| P0 | Invoices, payments (including partial), receipts | S8 |
| P0 | Daily KPIs: appointments, completed, cancelled, no-show rate, average wait, revenue | S9 |
| P0 | Backups with PITR, restore drill, monitoring, legal clearance for real data | Phase 8 |
| P1 | Rescheduling by patients; doctor-delay and "your turn is approaching" notifications | S6 / S7 |
| P1 | Estimator using historical consultation durations | S5 |
| P1 | Doctor utilization and per-service distribution KPIs | S9 |
| P1 | Waiting-room display screen (token-scoped, ticket numbers only) | S5 |
| P1 | Subscription plans with feature limits; manual subscription invoicing | S10 |
| P1 | Clinic switcher for multi-clinic users | S1 |
| P2 | WhatsApp channel (after Meta Business verification) | S6 |
| P2 | Browser push notifications | S6 |
| P2 | Clinic branches | S2 |
| P2 | Passkeys/WebAuthn for privileged users | S1 |
| P2 | Break-glass support access for platform admins | S10 |
| P2 | Online payment gateway for subscriptions | S10 |

---

## Long-lead, non-engineering tracks (start now)

| Track | Why it is long-lead |
| --- | --- |
| Legal counsel: Law 09-08 / CNDP authorization, processor agreements with clinics, retention, patient-rights procedures, medical-advertising rules for booking pages | Blocks any real patient data (R4) |
| Hosting region decision (EU vs Morocco) | May reverse D-0 (audit §6) |
| SMS provider and sender ID; email provider; WhatsApp Business verification | Provider onboarding takes weeks |
| Accountant review of invoice requirements | Blocks commercial use of billing |
| Recruit 2–3 pilot clinics in Nador; observe their front desks | Shapes the reception and SmartFlow design (R14) |
| Native Arabic copy reviewer | Quality of the Arabic UI and templates (R13) |
