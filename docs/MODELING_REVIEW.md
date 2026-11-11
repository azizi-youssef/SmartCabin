# SmartClinic — Modeling Review

| | |
| --- | --- |
| Status | **Awaiting review.** No migration or code will be written before approval |
| Date | 2026-11-10 |
| Scope | The system modeling phase (the 12 requested deliverables) |

This document is the entry point for the review. It lists the decisions taken, the inconsistencies found in the master specification, the entities added, the architectural risks, and the questions still open.

---

## 1. Deliverables

| # | Deliverable | Location |
| --- | --- | --- |
| 1 | System context diagram | [SYSTEM_ARCHITECTURE.md §1](SYSTEM_ARCHITECTURE.md#1-system-context) |
| 2 | Container and component diagrams | [SYSTEM_ARCHITECTURE.md §2–§4](SYSTEM_ARCHITECTURE.md#2-containers) |
| 3 | DDD bounded contexts + context map | [DOMAIN_MODEL.md §2–§4](DOMAIN_MODEL.md#2-subdomains-and-bounded-contexts) |
| 4 | Complete ERD (overview + 8 per-context diagrams) | [DATABASE_ERD.md](DATABASE_ERD.md) |
| 5 | UML class diagrams (3) | [DOMAIN_MODEL.md §5](DOMAIN_MODEL.md#5-uml-class-diagrams) |
| 6 | Appointment state machine (+ queue, session, invitation, membership, invoice, notification, clinic, subscription) | [BUSINESS_RULES.md](BUSINESS_RULES.md) |
| 7 | Patient journey activity diagram | [USER_WORKFLOWS.md §1](USER_WORKFLOWS.md#1-patient-journey--activity-diagram) |
| 8 | Clinic onboarding sequence diagram | [USER_WORKFLOWS.md §2](USER_WORKFLOWS.md#2-clinic-onboarding--sequence-diagram) |
| 9 | Queue management sequence diagram (+ notification dispatch) | [USER_WORKFLOWS.md §3–§4](USER_WORKFLOWS.md#3-queue-management--sequence-diagram) |
| 10 | Role and permission matrix | [RBAC_PERMISSION_MATRIX.md](RBAC_PERMISSION_MATRIX.md) |
| 11 | Tenant isolation model | [SECURITY_MODEL.md](SECURITY_MODEL.md) |
| 12 | API domain boundaries | [API_SPECIFICATION.md](API_SPECIFICATION.md) |
| — | Attributes, relationships, constraints, ownership and lifecycle for each entity (42 domain entities + 2 infrastructure tables) | [DOMAIN_MODEL.md §6](DOMAIN_MODEL.md#6-entity-catalog) |

---

## 2. Modeling decisions for review

**Assumption carried over from the audit:** D-0 = Option A (Next.js + Supabase), and defaults A1–A18 accepted. Every decision below can still be changed until the first migration (Phase 3).

| ID | Decision | Rationale | Alternative rejected |
| --- | --- | --- | --- |
| MD-01 | Build on Supabase (D-0 = A), CLINPILOT as read-only reference | Matches the master specification | Continue CLINPILOT |
| MD-02 | **PATIENT is a separate principal, not a clinic membership.** The portal goes through `portal_*` functions only, with no access to table rows | A patient is not staff. It removes the most complex RLS policies and keeps the portal fields minimal | A `patient` role in `clinic_members` |
| MD-03 | **One `doctors` row per clinic.** The practitioner capability comes from `doctors.user_id`, on top of the role. One role per membership | Each clinic owns its data. An independent doctor = owner + doctor link, without multiple roles | A global doctor profile shared between clinics |
| MD-04 | **Two write tiers.** Command tables (appointments, queue, billing, memberships…) only through `SECURITY DEFINER` commands; managed tables (catalog, schedules, patients) through DML under RLS | State machines and money need atomic rules. Simple CRUD does not need the boilerplate | Everything through RLS (rules bypassable), or everything through RPC (heavy) |
| MD-05 | **Composite tenant foreign keys everywhere**, including `appointments (clinic_id, doctor_id, service_id) → doctor_services` | Makes cross-clinic references impossible and enforces "the doctor offers the service" in the database | RLS checks only |
| MD-06 | **Schedules = periods** (`regular` / `override`) containing weekly windows | Ramadan or summer hours without editing the normal week. Clean precedence rule | A single `doctor_availability` table with dated exceptions |
| MD-07 | `clinic_closures` entity | Holidays and Eid apply to every doctor | Time off entered for each doctor |
| MD-08 | **Reschedule in place** + `appointment_history` (renamed from `appointment_status_history`), which records status changes **and** time changes | A reschedule keeps the same appointment, its reminders are re-planned, and history is kept | Cancel + new appointment (distorts the cancellation KPIs) |
| MD-09 | Three initial states (`pending`, `confirmed`, `checked_in`). Two audited correction transitions. Pending appointments expire automatically at their start time. **No automatic no-show** in the MVP | Real front-desk operations: late arrivals, start mistakes. Marking a no-show is a human decision | Fully automatic no-show |
| MD-10 | **A walk-in creates an appointment** (`source = walk_in`, directly `checked_in`) | Queue, billing and analytics share one record | Queue entries without an appointment |
| MD-11 | **`doctor_sessions` aggregate** (doctor's day): owns the queue, the ticket counter, the delay and `queue_version` | A natural consistency boundary. Required for doctor delays and estimates | A queue per clinic |
| MD-12 | **Queue order v1**: anchor = scheduled time if on time, otherwise arrival time. Priority and reordering by a human with a reason only | Deterministic and explainable. No automated triage | Strict FIFO (unfair to scheduled patients) |
| MD-13 | **Estimator in PostgreSQL**, recomputed in each queue command + every minute while a consultation overruns. Historical stats rebuilt nightly (threshold 20 samples) | Estimates always consistent with the state committed by the same transaction. **Supersedes audit §8.3** | TypeScript estimator after commit (race conditions) |
| MD-14 | Realtime: **private broadcast for staff only**, payloads with no data. The portal and display screens **poll** | Smaller attack surface, simple to secure | Realtime for patients |
| MD-15 | **`domain_events` outbox → planner → `notifications`.** The worker is a Next.js route called by pg_cron/pg_net with an HMAC signature. No pgmq | One TypeScript codebase. No dependency on Vercel cron. Delivery state queryable with SQL | Supabase Queues (pgmq), Edge Functions (Deno) |
| MD-16 | **Gapless counters** in `clinic_counters` (invoices, receipts, file numbers) | Sequences leave gaps after rollbacks | PostgreSQL sequences |
| MD-17 | Payments belong to the Invoice aggregate. **Correction by voiding** (no payment recorded) or by payment reversal. No credit note in the MVP | Simple. Credit notes pending accountant validation | Full accounting |
| MD-18 | **SUPER_ADMIN separate** (`platform_admins`), aal2, **no access to patient data**, aggregates only | Privacy by design, Law 09-08 | A super role with total access |
| MD-19 | Column-level restriction through narrow definer functions, not through views over rows allowed by RLS | RLS is per row. Views can bypass RLS | Per-column grants (impossible per application role) |
| MD-20 | `legal_documents` + `legal_acceptances` in P0 | Proof of acceptance before real data | Checkbox without a version |
| MD-21 | Tables in `public`, helpers in `private`. Context boundaries enforced by convention + tests | Simple with PostgREST and type generation | One schema per context |
| MD-22 | Doctors manage **their own** schedules and time off | "DOCTOR: own schedules" in the specification | Admin only |
| MD-23 | MFA required for OWNER, ADMIN, ACCOUNTANT, SUPER_ADMIN. Optional for DOCTOR and RECEPTIONIST | Privileged and financial access. Shared front-desk PCs | MFA for everyone right away |
| MD-24 | Bilingual names `name_fr` / `name_ar` (at least one required) for clinic-entered data | Clinics may fill in a single language | JSONB of translations |

---

## 3. Inconsistencies found in the master specification

| # | Specification says | Problem | Resolution |
| --- | --- | --- | --- |
| I-01 | PATIENT listed among the roles, next to staff roles | A patient is not a clinic member, and their records are per clinic | Separate principal (MD-02) |
| I-02 | `users` and `user_profiles` tables | Supabase already provides `auth.users`. A copy would drift | `auth.users` + `user_profiles` only |
| I-03 | "Conflicting appointments must be prevented" | Overbooking and walk-ins are everyday reality | Explicit flag, permission, reason, audit (BR-B-08) |
| I-04 | "Doctors may work in multiple clinics" + tenant-scoped data | A global doctor would break per-clinic data ownership | One row per clinic (MD-03); cross-clinic conflicts not detected (risk M-04) |
| I-05 | `appointment_status_history` | Does not capture reschedules (time changes) | `appointment_history` (MD-08) |
| I-06 | "Generate queue entries after check-in" + walk-ins | A walk-in has no appointment to check in | Walk-in = appointment (MD-10) |
| I-07 | "Doctor delay" notification | No entity to hold the doctor's day or delay | `doctor_sessions` (MD-11) |
| I-08 | "Receipts" in billing | No table or numbering rule | Gapless receipt number on `payments` (BR-F-07) |
| I-09 | Appointment states | No state for "left before consultation" or "rescheduled" | Cancellation reason and history event, without new states (keeps the 7 states requested) |
| I-10 | "Supabase Queues or a scheduled worker" | Two options with different consequences | Outbox + pg_cron worker (MD-15) |
| I-11 | SUPER_ADMIN "platform monitoring" vs privacy by design | Monitoring must not mean reading patient files | Aggregates only (MD-18) |
| I-12 | Rate limiting required, Redis discouraged | No mechanism identified | PostgreSQL buckets (`private.rate_limit_buckets`) + Vercel firewall |
| I-13 | CLINIC_OWNER "subscription management" vs manual billing | The owner cannot pay online | The owner views and requests changes; the platform applies them (BR-P-*) |
| I-14 | "Daily revenue" (Analytics) and "revenue summaries" (Billing) | Two possible definitions | One definition owned by Billing (K7: collected and invoiced) |
| I-15 | `clinic_branches` among the core tables, "when required" | Adding it everywhere has a cost for an unconfirmed need | Deferred (P2). Known migration cost (risk M-10) |
| I-16 | "DOCTOR: patient information explicitly authorized" | The authorization rule is not defined | Patients with at least one appointment with the doctor in the clinic (Q7) |

---

## 4. Entities added (missing from the original list)

| Entity | Why | Priority |
| --- | --- | --- |
| `clinic_invitations` | Staff invitation with a role, single use | P0 |
| `permissions`, `role_permissions` | Single source of truth for the matrix | P0 |
| `platform_admins` | SUPER_ADMIN outside clinic roles | P0 |
| `clinic_closures` | Closures common to the whole clinic | P0 |
| `clinic_counters` | Gapless numbering | P0 |
| `doctor_schedules` | Validity periods (Ramadan) | P0 |
| `patient_accounts` | Portal account ↔ patient records link | P0 |
| `appointment_history` | Replaces `appointment_status_history` | P0 |
| `doctor_sessions` | Doctor's day, queue, delay | P0 |
| `domain_events` | Transactional outbox | P0 |
| `notification_attempts` | Delivery diagnostics | P0 |
| `legal_documents`, `legal_acceptances` | Proof of legal acceptance | P0 |
| `consultation_duration_stats` | Historical estimator (derived) | P1 |
| `queue_display_screens` | Waiting-room screen | P1 |
| `data_subject_requests` | Patients' rights (Law 09-08) | P1 |
| `private.rate_limit_buckets`, `private.job_runs` | Infrastructure | P0 |

**Considered and not added:**
- `idempotency_keys`, because a unique column per aggregate is enough;
- `doctor_specialties` M:N, because a single primary specialty is enough for the MVP;
- `usage_counters`, because SMS usage is computed from `notifications`;
- a platform `platform_invoices` table, because subscription billing is manual during the pilot.

**Deferred domain gaps:**
- insurance claim forms (*feuilles de soins* for AMO/CNSS/CNOPS/mutual insurers);
- credit notes;
- clinical documents.

---

## 5. Architectural risks (modeling-specific)

Each M-risk refines an audit risk (R1–R14) at the model level.

| ID | Risk | Impact | Mitigation |
| --- | --- | --- | --- |
| M-01 | `SECURITY DEFINER` commands are the boundary for command tables. A single forgotten check exposes data | Critical | `require_permission` as the first statement, verified by a meta-test. Command review checklist. Isolation test matrix (SECURITY_MODEL §8) |
| M-02 | Appointment and queue entry state duplicated | High | One command changes both. A constraint trigger rejects mismatches (BUSINESS_RULES §3) |
| M-03 | Estimator in SQL: harder to iterate on than TypeScript | Medium | Deterministic v1, pgTAP tests + scenarios driven from Vitest. A statistical v2 can move to a worker that writes estimates guarded by `queue_version` |
| M-04 | One doctor row per clinic: a doctor booked at the same time in two clinics is not detected | Medium | Out of MVP scope. Later option: a cross-clinic "busy" indicator for linked users only, without revealing details |
| M-05 | Portal duplicates (each first booking creates a record) | Medium (reception workload) | Duplicate hints (phone + name + date of birth), merge command (P0 for hints, merge in S3) |
| M-06 | Locks on `clinic_counters` and `doctor_sessions` | Low | Low volume per clinic. Short locks, taken first in each transaction to avoid deadlocks |
| M-07 | Partial exclusion constraint + status changes: confirming or correcting can conflict | Medium | Every command maps `23P01` → `SLOT_UNAVAILABLE`. Concurrency tests |
| M-08 | `realtime.messages` policies parse the topic | Medium | Strict topic format validated by regex; dedicated tests; hint-only payloads limit the impact |
| M-09 | Analytics on the operational tables | Low at pilot scale | Indexes `(clinic_id, starts_at)`. Daily snapshot only if measurements require it |
| M-10 | Branches deferred: adding `branch_id` later means migrations on doctors, schedules, appointments and sessions | Medium | Accepted. Nullable column + backfill, prepared when a pilot clinic needs it |
| M-11 | Boundaries enforced by convention in a shared schema | Medium | Test "table → functions allowed to write it" + review |
| M-12 | PostgreSQL enums cannot drop values | Low | Minimal enums from the start; reference tables for lists that change often (reasons) if needed |
| M-13 | Shared family phone: whoever holds the phone sees the linked records | Medium (privacy) | Explicit links only, minimal portal fields, staff revocation, re-OTP for sensitive actions |
| M-14 | Clinic closure: export and purge not specified | Medium (legal) | `closed` lifecycle defined; procedure to write with counsel (BR-P-03) |

---

## 6. Open questions (defaults applied, to confirm)

| # | Question | Default used in the model |
| --- | --- | --- |
| Q1 | Receptionists: issue invoices, record payments, overbook? | Yes, audited, overbooking with a reason |
| Q2 | A patient reschedule goes back to `pending` if the clinic requires confirmation? | Yes |
| Q3 | Late arrival: after how many minutes does the patient lose their scheduled place? | 15 min (`checkin_grace_minutes`), configurable |
| Q4 | Default reminders | One SMS 24 h before (+ "turn approaching") |
| Q5 | Retention periods (patients, appointments, audit, notifications) | Nothing purged until counsel decides. Proposals in DOMAIN_MODEL |
| Q6 | Are INPE (doctor) and ICE (clinic) needed? | Optional fields, to confirm with the accountant |
| Q7 | Doctor visibility over patients | Patients with at least one appointment with them |
| Q8 | Customizable permissions per clinic | No (fixed matrix in the MVP) |
| Q9 | Booking window defaults | Lead time 60 min, horizon 60 days, patient cancellation cutoff 2 h, max 3 active online bookings |
| Q10 | Quiet hours for SMS | 21:00–08:00 clinic time |

---

## 7. Not done in this phase (and why)

| Item | Status |
| --- | --- |
| PRODUCT_REQUIREMENTS.md (functional and non-functional requirements, user stories, acceptance criteria) | Not requested in this deliverable. To be produced before Phase 3, from these models |
| Detailed command schemas (parameters, responses) | Defined per slice, in API_SPECIFICATION.md |
| Data-flow diagrams beyond the sequences | The sequence diagrams cover the critical flows. More will be added if review requires |
| UI/UX guidelines, design tokens | Phase 4 |
| SQL migrations, code | **Not started**, waiting for approval |
