# SmartCabin — Role and Permission Matrix

| | |
| --- | --- |
| Status | **Draft for review** (system modeling phase) |
| Date | 2026-11-10 |
| Source of truth | After Phase 3, the seeded `permissions` and `role_permissions` tables. A test fails if they differ from this document |
| Related | [SECURITY_MODEL.md](SECURITY_MODEL.md) (how permissions are enforced) · [BUSINESS_RULES.md](BUSINESS_RULES.md) |

---

## 1. Principals

| Principal | How identified | Where defined |
| --- | --- | --- |
| **SUPER_ADMIN** | Row in `platform_admins` + `aal2` session | Platform path only. **Not** a clinic member, no clinic permissions |
| **CLINIC_OWNER**, **CLINIC_ADMIN**, **DOCTOR**, **RECEPTIONIST**, **ACCOUNTANT** | Active `clinic_members` row in the clinic named by the URL | One role per membership. A user can hold different roles in different clinics |
| **Practitioner capability** | A `doctors` row with `user_id = auth.uid()` in that clinic | Added on top of **any** role. It grants the 🔹 *own* permissions below (own schedule, own day, own patients) |
| **PATIENT** | Supabase Auth phone account + active `patient_accounts` links | **Not** a clinic member. Uses portal functions only, never table access |
| **Anonymous** | No session | Public booking pages: clinic profile, services, doctors, slots |
| **System** | Worker or job (privileged client, or SQL inside pg_cron) | Every action is recorded with `actor_type = system` |

**The DOCTOR role** is "practitioner only": it grants no administrative permission. An independent doctor who owns their practice is a **CLINIC_OWNER with a linked `doctors` row**, so they get all owner permissions plus the practitioner scope.

---

## 2. Legend

| Symbol | Meaning |
| --- | --- |
| ✅ | Allowed for the whole clinic |
| 🔹 | Allowed within a scope: **own** = rows of the doctor linked to this user; for PATIENT, records linked to the account; other limits are given in the notes |
| — | Not allowed |
| 🔐 | Requires an `aal2` session. This is in addition to the rule that owner, admin, accountant and platform sessions are always `aal2` (§5) |

Columns: **OWN** clinic owner · **ADM** clinic admin · **DOC** doctor · **REC** receptionist · **ACC** accountant · **PAT** patient · **SA** super admin.

---

## 3. Clinic permission matrix

### 3.1 Clinic, staff and subscription

| Permission | OWN | ADM | DOC | REC | ACC | PAT | SA | Notes |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| `clinic.profile.view` | ✅ | ✅ | ✅ | ✅ | ✅ | 🔹 | 🔹 | PAT and anonymous see the public profile only. SA sees metadata through the platform path |
| `clinic.profile.update` | ✅ | ✅ | — | — | — | — | — | Name, contact, logo, ICE |
| `clinic.settings.update` | ✅ | ✅ | — | — | — | — | — | Booking, reminders, queue policy |
| `clinic.closures.manage` | ✅ | ✅ | — | ✅ | — | — | — | |
| `clinic.close` | ✅🔐 | — | — | — | — | — | — | Starts the export and retention procedure |
| `members.view` | ✅ | ✅ | — | — | — | — | — | Staff names for assignment come from `doctors.view` |
| `members.invite` | ✅ | 🔹 | — | — | — | — | — | ADM cannot invite OWN or ADM |
| `members.change_role` | ✅ | 🔹 | — | — | — | — | — | ADM: only DOC, REC and ACC roles. Nobody changes their own role |
| `members.suspend` / `members.remove` | ✅ | 🔹 | — | — | — | — | — | Last-owner protection (BR-M-04) |
| `ownership.transfer` | ✅🔐 | — | — | — | — | — | — | |
| `subscription.view` | ✅ | ✅ | — | — | ✅ | — | ✅ | |
| `subscription.request_change` | ✅ | — | — | — | — | — | — | Applied by SA during manual billing |
| `audit.view` | ✅ | ✅ | — | — | — | — | — | Clinic-scoped audit log |
| `legal.accept_clinic_dpa` | ✅🔐 | — | — | — | — | — | — | |

### 3.2 Catalog and scheduling

| Permission | OWN | ADM | DOC | REC | ACC | PAT | SA | Notes |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| `services.view` | ✅ | ✅ | ✅ | ✅ | ✅ | 🔹 | — | PAT and anonymous see online-bookable services only |
| `services.manage` | ✅ | ✅ | — | — | — | — | — | Prices included |
| `doctors.view` | ✅ | ✅ | ✅ | ✅ | ✅ | 🔹 | — | Public profile: name, specialty |
| `doctors.manage` | ✅ | ✅ | — | — | — | — | — | Create, link to member, deactivate, assign services |
| `schedules.view` | ✅ | ✅ | ✅ | ✅ | — | — | — | |
| `schedules.manage` | ✅ | ✅ | 🔹 | — | — | — | — | DOC: own schedules (MD-22) |
| `time_off.manage` | ✅ | ✅ | 🔹 | ✅ | — | — | — | DOC: own |
| `slots.view` | ✅ | ✅ | ✅ | ✅ | — | ✅ | — | Anonymous users too, for online-bookable doctors |

### 3.3 Patients

| Permission | OWN | ADM | DOC | REC | ACC | PAT | SA | Notes |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| `patients.view` | ✅ | ✅ | 🔹 | ✅ | — | 🔹 | — | DOC: patients with at least one appointment with them in this clinic (Q7). PAT: linked records, limited fields. ACC gets billing identity only through billing functions |
| `patients.create` | ✅ | ✅ | — | ✅ | — | 🔹 | — | PAT: self or dependent during online booking |
| `patients.update` | ✅ | ✅ | — | ✅ | — | 🔹 | — | PAT: preferred language and channel on linked records only |
| `patients.merge` | ✅ | ✅ | — | — | — | — | — | Moves appointments, invoices and links in one transaction |
| `patients.archive` | ✅ | ✅ | — | — | — | — | — | |
| `patients.link_account` | ✅ | ✅ | — | ✅ | — | — | — | Explicit staff link of a portal account to a record |
| `patients.export` | ✅🔐 | ✅🔐 | — | — | — | — | — | Data-subject access copy |
| `consents.record` | ✅ | ✅ | — | ✅ | — | 🔹 | — | PAT: own and dependents' |
| `dsr.manage` | ✅ | ✅ | — | — | — | — | — | Data-subject requests |
| `dsr.submit` | — | — | — | — | — | 🔹 | — | P1 |

### 3.4 Appointments

| Permission | OWN | ADM | DOC | REC | ACC | PAT | SA | Notes |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| `appointments.view` | ✅ | ✅ | 🔹 | ✅ | — | 🔹 | — | ACC sees billable appointments through billing functions |
| `appointments.view_reason` | ✅ | ✅ | 🔹 | ✅ | — | 🔹 | — | `patient_reason` field |
| `appointments.book` | ✅ | ✅ | 🔹 | ✅ | — | 🔹 | — | DOC: for own agenda. PAT: online rules BR-B-* |
| `appointments.confirm` | ✅ | ✅ | 🔹 | ✅ | — | — | — | |
| `appointments.reschedule` | ✅ | ✅ | 🔹 | ✅ | — | 🔹 | — | PAT: before cutoff |
| `appointments.cancel` | ✅ | ✅ | 🔹 | ✅ | — | 🔹 | — | PAT: before cutoff |
| `appointments.overbook` | ✅ | ✅ | 🔹 | ✅ | — | — | — | Reason required, audited (Q1) |
| `appointments.mark_no_show` | ✅ | ✅ | 🔹 | ✅ | — | — | — | |
| `appointments.correct_status` | ✅ | ✅ | — | — | — | — | — | Transitions A13 and A14 |

### 3.5 Reception and queue (SmartFlow)

| Permission | OWN | ADM | DOC | REC | ACC | PAT | SA | Notes |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| `queue.view` | ✅ | ✅ | 🔹 | ✅ | — | 🔹 | — | PAT: own position and estimate only |
| `queue.check_in` | ✅ | ✅ | — | ✅ | — | — | — | Includes walk-in registration |
| `queue.call` | ✅ | ✅ | 🔹 | ✅ | — | — | — | Call next, recall |
| `queue.start` | ✅ | ✅ | 🔹 | ✅ | — | — | — | Start consultation |
| `queue.complete` | ✅ | ✅ | 🔹 | ✅ | — | — | — | REC can close if the doctor forgot |
| `queue.prioritize` | ✅ | ✅ | 🔹 | ✅ | — | — | — | Reason required. **Human decision only** (BR-Q-05) |
| `queue.reorder` | ✅ | ✅ | 🔹 | ✅ | — | — | — | Reason required |
| `queue.mark_left` | ✅ | ✅ | — | ✅ | — | — | — | |
| `queue.manage_session` | ✅ | ✅ | 🔹 | ✅ | — | — | — | Open, pause, close, report delay |
| `queue.displays.manage` | ✅ | ✅ | — | — | — | — | — | Waiting-room screen tokens |

### 3.6 Communications

| Permission | OWN | ADM | DOC | REC | ACC | PAT | SA | Notes |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| `notifications.view_log` | ✅ | ✅ | — | ✅ | — | — | — | Delivery status per appointment |
| `notifications.resend` | ✅ | ✅ | — | ✅ | — | — | — | Same idempotency rules, a new attempt series |
| `templates.manage` | ✅ | ✅ | — | — | — | — | ✅ | Clinic overrides are P2. SA manages platform defaults |

### 3.7 Billing and analytics

| Permission | OWN | ADM | DOC | REC | ACC | PAT | SA | Notes |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| `invoices.view` | ✅ | ✅ | — | ✅ | ✅ | 🔹 | — | PAT: own receipts and invoices (P1) |
| `invoices.create` | ✅ | ✅ | — | ✅ | ✅ | — | — | Drafts |
| `invoices.issue` | ✅ | ✅ | — | ✅ | ✅ | — | — | Q1 |
| `invoices.void` | ✅🔐 | ✅🔐 | — | — | ✅🔐 | — | — | Only without recorded payments (BR-F-06) |
| `payments.record` | ✅ | ✅ | — | ✅ | ✅ | — | — | |
| `payments.reverse` | ✅🔐 | ✅🔐 | — | — | ✅🔐 | — | — | Reason required |
| `billing.reports` | ✅ | ✅ | — | — | ✅ | — | — | |
| `analytics.operational` | ✅ | ✅ | 🔹 | — | — | — | — | DOC: own K1–K6, K8 |
| `analytics.financial` | ✅ | ✅ | — | — | ✅ | — | — | K7 |

---

## 4. Platform permissions (SUPER_ADMIN only, always `aal2`)

| Permission | Scope |
| --- | --- |
| `platform.clinics.view` | Clinic metadata: name, city, status, plan, counts. **No patient-level data** |
| `platform.clinics.approve` / `.reject` / `.suspend` / `.reactivate` / `.close` | Clinic status lifecycle |
| `platform.plans.manage` | Plans and features |
| `platform.subscriptions.manage` | Assign plans, periods, manual payment status |
| `platform.metrics.view` | Aggregates per clinic (e.g. appointments per day, SMS volume). No row-level operational data |
| `platform.specialties.manage` | Reference list |
| `platform.templates.manage` | Default notification templates |
| `platform.legal_documents.manage` | Terms, privacy policy, DPA versions |
| `platform.admins.manage` | Grant and revoke platform admins. Cannot revoke the last one |

There is **no** permission to read patients, appointments, queue entries, invoices or notifications. A break-glass procedure (time-boxed, approved by the clinic owner, fully audited) is a P2 item.

---

## 5. Authentication-strength rules

| Principal | MFA | Session |
| --- | --- | --- |
| SUPER_ADMIN | **Required** (TOTP; passkeys later) | `aal2` for every request |
| CLINIC_OWNER, CLINIC_ADMIN, ACCOUNTANT | **Required** at the first sign-in after joining | `aal2` for every workspace request |
| DOCTOR, RECEPTIONIST | Optional in the MVP, recommended | `aal1` allowed. A clinic setting can require `aal2` (P1) |
| PATIENT | Phone OTP (possession) | Short session; re-OTP for cancelling or rescheduling after 24 h |

---

## 6. Enforcement points

| Layer | What it does | Authoritative? |
| --- | --- | --- |
| UI | Hides or disables what the user may not do | **No** (convenience only) |
| Server Action / Route Handler | Resolves tenant and role, calls `can()` to return a localized error early | No (fast feedback) |
| Command function (`SECURITY DEFINER`) | Its first statement is `private.require_permission(clinic_id, 'perm', scope)`. Scope checks such as "own doctor" happen there too | **Yes**, for command tables |
| RLS policy | Row visibility (all tables) and DML on managed tables | **Yes** |
| Constraints and triggers | Invariants, whatever the caller | **Yes** |

A pgTAP test asserts that every `SECURITY DEFINER` function in `public` calls `private.require_permission` or `private.require_platform_admin` (it inspects function sources). Another test runs each permission row of this matrix against each role and checks the outcome.

---

## 7. Open points (defaults applied)

| # | Question | Default |
| --- | --- | --- |
| Q1 | May receptionists issue invoices, record payments and overbook? | Yes, all audited. Overbooking needs a reason |
| Q7 | Do doctors see all clinic patients, or only patients with an appointment with them? | Only patients with an appointment with them (owners see everything anyway) |
| Q8 | Per-clinic customizable roles? | Not in the MVP. The matrix is fixed and seeded by migration |
