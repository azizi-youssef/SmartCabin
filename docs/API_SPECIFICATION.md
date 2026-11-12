# SmartCabin — API Domain Boundaries

| | |
| --- | --- |
| Status | **Draft for review** (system modeling phase). This version fixes the boundaries and the names. Detailed parameter and response schemas come with each slice |
| Date | 2026-11-10 |
| Related | [DOMAIN_MODEL.md](DOMAIN_MODEL.md) · [SECURITY_MODEL.md](SECURITY_MODEL.md) · [RBAC_PERMISSION_MATRIX.md](RBAC_PERMISSION_MATRIX.md) |

---

## 1. API surfaces

| Surface | Callers | Authentication | Used for |
| --- | --- | --- | --- |
| **Server Actions** (per module) | The SmartCabin UI only | Session cookie. **Every action authenticates and authorizes itself**, because Server Actions are public POST endpoints | All UI mutations |
| **Server Components** (reads) | The SmartCabin UI | Session cookie → user-scoped client | All UI reads |
| **PostgreSQL functions** (through the Data API) | Server code (user-scoped or privileged client) | User JWT or service role | The domain command and query layer. It is the real boundary |
| **Route Handlers** `/api/...` | Non-UI callers only | Per route (below) | Jobs, webhooks, display screens, files, health |

**Rule:** the browser calls no Supabase API directly except the Realtime subscription for staff and the Auth calls made by the Supabase client libraries. Reads and writes go through Next.js. The Data API stays reachable, so the database still defends itself ([SECURITY_MODEL.md](SECURITY_MODEL.md)).

### 1.1 Route Handlers

| Route | Method | Authentication | Purpose |
| --- | --- | --- | --- |
| `/api/internal/jobs/dispatch` | POST | Headers `x-smartcabin-timestamp` (Unix seconds, less than 5 min from now) and `x-smartcabin-signature` (hex HMAC-SHA256 of `<timestamp>.<raw body>` with `JOBS_SECRET`), sent by `pg_net` | Plan from `domain_events`, then claim, send and record due notifications. Answers `{planned, claimed, sent, failed, retrying}` only, `no-store`; `401` for a bad signature, `413` for a body over 1 KB, `503` when the database is unreachable (implemented in module 9) |
| `/api/webhooks/sms/<provider>` | POST | Provider signature | Delivery receipts |
| `/api/webhooks/email/<provider>` | POST | Provider signature | Delivery and bounce events |
| `/api/display` | GET | Display token in `Authorization: Bearer <token>` (hashed lookup) | Ticket numbers and doctor display names. No-cache. The token is sent in a header, not in the path, so it never appears in access logs (implemented in module 8b). Rate limiting is left to the hosting edge (audit SC-AUD-14) |
| `/api/files/invoices/<invoice_id>` | GET | Session + `invoices.view` | Generate the PDF if needed, redirect to a 60-second signed URL. **Not built yet (module 10):** the page `/print/<clinic>/invoices/<id>` (and `?receipt=<payment>`) prints the invoice and its receipts from the browser, under the same session and RLS |
| `/api/health` | GET | None | Liveness (exposes no version or configuration) |

Public booking pages and the patient portal are pages of the Next.js app (Server Components + Server Actions). A separate public REST API is **not** needed in the MVP. If one is added later (mobile app), it will be versioned under `/api/v1`.

---

## 2. Boundaries per bounded context

Each context:
- **owns** its tables (only its commands write them);
- **exposes** commands, queries and events;
- **consumes** other contexts only through their public interface.

The same names are used for the PostgreSQL function and the TypeScript application service.

### BC1 Identity & Access

| | |
| --- | --- |
| Owns | `user_profiles`, `clinic_members`, `clinic_invitations`, `permissions`, `role_permissions`, `platform_admins` |
| Commands | `invite_member`, `resend_invitation`, `revoke_invitation`, `accept_invitation`, `change_member_role`, `suspend_member`, `reactivate_member`, `remove_member`, `transfer_ownership`, `update_my_profile` |
| Queries | `get_my_memberships`, `list_members`, `list_pending_invitations`, `preview_invitation(token)` |
| Events emitted | `member.invited` |
| Depends on | Supabase Auth (sign-up, sign-in, MFA, OTP) through the Supabase client, wrapped by this module only |

### BC2 Tenancy

| | |
| --- | --- |
| Owns | `clinics`, `clinic_settings`, `clinic_closures`, `clinic_counters` |
| Commands | `create_clinic`, `update_clinic_profile`, `update_clinic_settings`, `add_clinic_closure`, `remove_clinic_closure`, `request_clinic_closure`. Platform: `platform_approve_clinic`, `platform_reject_clinic`, `platform_suspend_clinic`, `platform_reactivate_clinic`, `platform_close_clinic` |
| Queries | `get_clinic_by_slug` (workspace), `public_get_clinic_profile(slug)` (anon, implemented in S7: profile, online flag, policy and online offer only), `platform_list_clinics` |
| Events emitted | `clinic.submitted`, `clinic.approved`, `clinic.suspended` |
| Internal API | `private.next_counter_value(clinic_id, key)`, used by Patients and Billing |

### BC3 Practice Catalog

| | |
| --- | --- |
| Owns | `specialties`, `services`, `doctors`, `doctor_services` |
| Writes | Managed tables (RLS DML), plus commands where an invariant spans rows: `link_doctor_to_member`, `set_doctor_services`, `deactivate_doctor` (returns future appointments) |
| Queries | `list_services`, `list_doctors`, `public_list_bookable_services(slug)`, `public_list_bookable_doctors(slug, service)` |
| Consumed by | Scheduling, Appointments, Billing (effective price) |

### BC4 Scheduling

| | |
| --- | --- |
| Owns | `doctor_schedules`, `doctor_availability`, `doctor_time_off` |
| Writes | Managed tables, plus `save_weekly_schedule` (replaces a schedule's windows atomically, returns conflicting appointments), `add_time_off` (returns conflicts) |
| Queries | `get_available_slots(doctor, service, from, to)` (staff), `public_get_available_slots(slug, doctor, service, from, to)` (anon, implemented in S7: online rules, at most 14 days per call; rate limiting is left to the hosting edge, SC-AUD-14), `private.is_bookable(doctor, service, period)` (internal, used by Appointments) |
| Consumed by | Appointments (validation inside `book_appointment`), Analytics (available minutes) |

### BC5 Patients

| | |
| --- | --- |
| Owns | `patients`, `patient_accounts`, `patient_consents` |
| Writes | Managed table `patients` (create and update under RLS), plus commands `merge_patients`, `archive_patient`, `link_patient_account`, `revoke_patient_account`, `record_consent` |
| Queries | `search_patients(q)` (trigram, scoped), `get_patient` (writes `patient.viewed` to the audit log), `find_possible_duplicates(patient)` |
| Portal | `portal_list_my_people`, `portal_add_person` (self or dependent + consents), `portal_update_preferences` |

### BC6 Appointments

| | |
| --- | --- |
| Owns | `appointments`, `appointment_history` |
| Commands | `book_appointment` (staff and portal variants), `confirm_appointment`, `reschedule_appointment`, `cancel_appointment`, `mark_no_show`, `correct_appointment_status` |
| Queries | `list_day_appointments(date, doctor?)`, `get_appointment`, `list_end_of_day_unresolved(date)` |
| Portal | **Implemented in S7:** `portal_book_appointment(clinic, doctor, service, starts_at, patient?, new_person?, idempotency_key?)`, `portal_list_my_appointments()` (with the clinic slug and the cancellation deadline), `portal_cancel_appointment(appointment)`, `portal_list_my_people(clinic)`. Not built yet: `portal_reschedule_appointment` |
| Events emitted | `appointment.booked`, `.confirmed`, `.rescheduled`, `.cancelled`, `.no_show` |
| Depends on | Scheduling `is_bookable`, Catalog effective duration and price, Patients (ownership check) |

### BC7 Patient Flow (SmartFlow)

| | |
| --- | --- |
| Owns | `doctor_sessions`, `queue_entries`, `queue_events`, `consultation_duration_stats`, `queue_display_screens` |
| Commands | `check_in_appointment`, `register_walk_in`, `call_next`, `recall_entry`, `start_consultation`, `complete_consultation`, `mark_left`, `set_queue_priority`, `move_queue_entry_before`, `open_session`, `pause_session`, `resume_session`, `close_session`, `report_doctor_delay`, `create_display_screen`, `revoke_display_screen` |
| Queries | `get_day_board(date)`, `get_doctor_queue(doctor, date)`, `display_snapshot(token)` (internal) |
| Portal | `portal_get_my_queue_status(appointment)`: position, estimate range, called or not. No other patient's data |
| Events emitted | `consultation.completed`, `queue.turn_approaching`, `session.delay_reported` |
| Partnership | Changes appointment status through Appointments' internal functions **in the same transaction** (DOMAIN_MODEL §3) |

### BC8 Communications

| | |
| --- | --- |
| Owns | `domain_events` (shared outbox, written by every context through `private.emit_event`), `notification_templates`, `notifications`, `notification_attempts` |
| Commands | `resend_notification`. Internal: `plan_notifications(event)`, `claim_due_notifications(batch)`, `record_attempt`, `apply_delivery_receipt` |
| Queries | `list_appointment_notifications(appointment)` |
| Adapters (TypeScript) | `EmailSender`, `SmsSender` (WhatsApp later): one interface, provider-specific implementations, chosen by configuration |

### BC9 Billing

| | |
| --- | --- |
| Owns | `invoices`, `invoice_items`, `payments` |
| Commands | `create_invoice_draft` (optionally from an appointment: price snapshot), `update_invoice_draft`, `discard_invoice_draft`, `issue_invoice`, `void_invoice`, `record_payment`, `reverse_payment` |
| Queries | `list_invoices`, `get_invoice`, `billing_patient_identity(patient)` (narrow function for accountants), `revenue_summary(from, to)` |
| Events emitted | `invoice.issued`, `payment.recorded` |

### BC10 Analytics

| | |
| --- | --- |
| Owns | Nothing (read-only) |
| Queries | **Implemented (module 11):** `kpi_operational(clinic, from, to, group, doctor?)` covering K1–K6 and K8, with `group` = `total`, `day`, `doctor` or `service` (it replaces the planned `kpi_daily`). K7 is billing's `revenue_summary(clinic, from, to)` itself, so there is one definition (I-14) and no `kpi_revenue` wrapper. `platform_kpi_overview()` (aggregates only) belongs to SaaS administration (module 12) |
| Rule | `SECURITY INVOKER`, so RLS and scope apply automatically |

### BC11 Subscriptions

| | |
| --- | --- |
| Owns | `subscription_plans`, `subscription_features`, `subscriptions` |
| Commands | **Implemented (module 12):** `request_plan_change(clinic, plan_code, note?)` (owner). Platform: `platform_set_subscription(clinic, plan_code, status, period_start?, period_end?, trial_ends_on?, notes?)` with local dates, `platform_mark_subscription_paid(clinic, paid_until, notes?)`, `platform_save_plan(...)` (named `platform_manage_plan` in the plan) |
| Queries | `get_my_subscription(clinic)`, `list_available_plans(clinic)`, `get_my_clinic_access(clinic)` (effective permissions and read-only reason, for the interface), `platform_list_plans()`, `platform_kpi_overview()` (counts only). Internal: `private.plan_limit(clinic, key)` (named `feature_limit` in the plan), used by the limit triggers and the dispatcher |

### BC12 Compliance

| | |
| --- | --- |
| Owns | `audit_logs`, `legal_documents`, `legal_acceptances`, `data_subject_requests` |
| Commands | `accept_legal_documents`, `accept_clinic_dpa`, `open_data_subject_request`, `update_data_subject_request`, `export_patient_data` (aal2) |
| Queries | `list_audit_logs(filters)`, `get_current_legal_documents(locale)` |
| Internal API | `private.write_audit(...)`, called by triggers and commands |

---

## 3. Cross-context call rules

1. A context **never writes another context's tables**. It calls that context's command, either as an internal `private.*` function within the same transaction or through events.
2. **Synchronous** calls between contexts are allowed only upstream → downstream as drawn in the context map (DOMAIN_MODEL §2.1), for example Appointments → Scheduling `is_bookable`.
3. **Asynchronous** reactions go through `domain_events`. Consumers are idempotent, and events carry ids only.
4. Shared-kernel functions (`private.has_permission`, `private.emit_event`, `private.write_audit`, `private.next_counter_value`) are changed only with review from every context that uses them.
5. In TypeScript, cross-module imports go through `modules/<name>/index.ts`, enforced by ESLint.

**Known limitation.** All tables live in the `public` schema (simpler for PostgREST and type generation). Table ownership is therefore enforced by convention, by review, and by a test that lists, for each table, the functions allowed to write it. PostgreSQL grants alone do not enforce it.

---

## 4. Shared contract

### 4.1 Command input and output

- Every input is validated twice: by a Zod schema in TypeScript (UX) and inside the SQL function (authority).
- Commands return the updated aggregate (or its id and `version`), never another context's data.
- **Idempotency:** `book_appointment`, `register_walk_in`, `record_payment` and `create_invoice_draft` accept an `idempotency_key` (UUID generated by the client when the form opens). Replaying the same key returns the original result.
- **Optimistic concurrency:** commands on an existing aggregate accept `expected_version`. A mismatch returns `STALE_STATE`.

### 4.2 Error contract

```json
{ "ok": false, "error": { "code": "SLOT_UNAVAILABLE", "messageKey": "errors.slotUnavailable", "details": { "field": "starts_at" } } }
```

| Code | Origin | Typical cause |
| --- | --- | --- |
| `VALIDATION_FAILED` | Zod or SQL check | Invalid input. `details.fields` lists the fields |
| `UNAUTHENTICATED` | Session | No valid session |
| `MFA_REQUIRED` | `aal` check | The role needs an `aal2` session |
| `FORBIDDEN` | `require_permission` | Missing permission (shown only when the resource is visible to the caller) |
| `NOT_FOUND` | RLS empty result | Missing, **or belongs to another clinic** (indistinguishable on purpose) |
| `STALE_STATE` | Version mismatch | Someone else changed it first |
| `SLOT_UNAVAILABLE` | `23P01` or `is_bookable` false | Overlap, outside availability, time off, closure |
| `BOOKING_RULE_VIOLATED` | Booking rules | Lead time, horizon, active booking limit (`details.rule`) |
| `APPT_INVALID_TRANSITION` | Transition check | E.g. completing a cancelled appointment |
| `QUEUE_BUSY` | BR-Q-03 | Another patient is already in consultation with this doctor |
| `LAST_OWNER` | BR-M-04 | Removing or demoting the last owner |
| `INVOICE_IMMUTABLE` | BR-F-02 | Editing an issued invoice |
| `PAYMENT_EXCEEDS_BALANCE` | BR-F-04 | Overpayment |
| `INVOICE_INVALID_TRANSITION` | BR-F-01/05/06 | Issuing twice, paying a draft or a void invoice, voiding with payments, reversing twice |
| `PLAN_LIMIT_REACHED` | BR-T-08 | Plan feature limit (`details.feature`) |
| `SUBSCRIPTION_INVALID_TRANSITION` | BUSINESS_RULES §7 | A subscription status change the lifecycle does not allow |
| `RATE_LIMITED` | Rate limiter | Too many attempts. `details.retryAfterSeconds` |
| `DUPLICATE` | `23505` | A unique constraint, outside idempotency keys |
| `INTERNAL` | Anything else | Logged with a request id, no patient data. A generic message is shown |

Every code has French and Arabic texts. Codes are stable: renaming one is a breaking change.

### 4.3 Conventions

- Function and parameter names in `snake_case` (SQL). TypeScript wrappers in `camelCase`, generated types in the `Database` namespace.
- Times exchanged as ISO 8601 with offset (instants) or as `YYYY-MM-DD` + `HH:MM` with the clinic's time zone (wall-clock values). Never a bare local time without a time zone.
- Money exchanged as decimal **strings** (`"350.00"`) with currency `MAD`, never as floating point.
- Keyset pagination: `(sort value, id)` cursor, at most 100 items.
- Lists of patient data are never cached in shared caches. Responses with patient data send `Cache-Control: private, no-store`.
