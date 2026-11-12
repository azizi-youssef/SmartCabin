# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/). Nothing has been released yet.

## [Unreleased]

### Added — Slice S7: Patient portal, online booking (2026-11-12)

- **Public booking page `/c/<clinic>`**, reached through the clinic's link, with no account needed to look:
  - the clinic's details and its online offer (online-bookable doctors and services, durations, prices);
  - free slots week by week, computed by the server with the online rules: lead time, horizon (BR-B-07), online flags (BR-B-02/03), time off, closures, other appointments.
  - **Booking:**
    1. choose a slot;
    2. phone number and SMS code, behind CAPTCHA (the account is created if needed);
    3. choose who it is for (a person already linked, or a new person with the data-processing consent and an optional SMS-reminder consent);
    4. confirm.
  - The booking is **pending until the clinic confirms** it, or confirmed at once if the clinic auto-confirms (A1/A2). A slot taken in the meantime sends the patient back to the slots.
  - Only clinic profile data and slot times are public. Nothing about patients.
- **Patient portal (`/me`):**
  - cancellation online until the clinic's cutoff (A6); after it, "call the clinic";
  - a "Prendre un rendez-vous" link per clinic.
- **Settings:** the clinic's booking link, with copy and open buttons. A QR code can be made from it; the app does not draw one yet.
- **Unconfirmed bookings** whose start has passed are cancelled by the system (A7, `not_confirmed_in_time`), every 10 minutes where pg_cron exists. This is the "pending expiry" part of SC-AUD-08.
- **Accounts (your choice: open booking):**
  - phone sign-ups are enabled again in Supabase Auth, **only through the new before-user-created hook** (`public.before_user_created`), which accepts Moroccan mobile numbers only;
  - with CAPTCHA and the SMS limits (one per number per minute, 30 per hour), abuse is capped and never reaches premium or foreign ranges;
  - the portal's own sign-in still never creates an account.
- **Migration 0030:**
  - `public.before_user_created` (executable by `supabase_auth_admin` only);
  - `public_get_clinic_profile`, `public_get_available_slots` (callable without an account);
  - `portal_list_my_people`, `portal_book_appointment`, `portal_cancel_appointment`; `portal_list_my_appointments` recreated with the clinic's slug and the cancellation deadline;
  - `private.expire_pending_appointments`.
  - **Online bookings follow BR-D-02:** a new person is a new record linked to the account, never matched by phone; reception merges duplicates.
- **New error code:** `BOOKING_RULE_VIOLATED` (already in the API specification).
- **Tests:**
  - **6 database tests** (`portal.test.ts`):
    - the hook (Moroccan mobiles in, foreign, landline, premium and synthetic numbers out; only Supabase Auth may call it);
    - the public page: the offer, 23 free slots computed by hand, the horizon, booking off, a suspended clinic, no patient field;
    - booking: a new person with record, link, consents, event and patient actor; idempotency; auto-confirm; the one "self" per account; a child added;
    - the online rules: slot taken, lead time, horizon, active booking limit, linked people only, staff and anonymous callers refused, booking off;
    - cancellation: own booking, other accounts, cutoff;
    - expiry.
  - **Security metadata tests:**
    - the two public reads are the only new functions anonymous callers may execute;
    - their source must not touch any patient-level or financial table;
    - the configuration test now requires the hook whenever phone sign-ups are on.
  - **3 unit tests:** the booking choices, slots grouped by local day across midnight UTC, the new-person checks.
- **Verified:**
  - typecheck and lint clean;
  - 141 unit and component tests;
  - database 196 passed + 1 expected failure (SC-AUD-03, still open);
  - production build passes.
- **Not verified:**
  - the booking page and the portal with live data;
  - Supabase Auth calling the hook (no Docker here; the hosted project needs it set: SECURITY_MODEL §7).
- **Not built yet in S7:**
  - patient rescheduling (A5 for patients: cancel and book again meanwhile);
  - adding a person outside a booking;
  - a drawn QR code;
  - the "booking received" message.

### Security — SC-AUD-01 fixed: SMS sign-up abuse (2026-11-12)

- **Patient SMS sign-in:**
  - it no longer creates an account (`shouldCreateUser: false`), so an unknown number receives no SMS;
  - the answer is the same for known and unknown numbers ("if this number is registered with a clinic, a code was sent");
  - only Moroccan mobile numbers (06, 07) are accepted; synthetic `+999` test numbers are accepted outside production only.
- **CAPTCHA (Cloudflare Turnstile)** on staff sign-in, sign-up, forgot password and the patient SMS form, shown when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set. The token goes to Supabase Auth, which verifies it; the server refuses a missing token early.
- **Supabase Auth settings (`config.toml`):**
  - CAPTCHA enabled, secret from `SUPABASE_AUTH_CAPTCHA_SECRET`;
  - phone sign-ups stay disabled;
  - one SMS per number per minute (was 5 s), 30 per hour kept.
  - The hosted project must mirror these: see the checklist in SECURITY_MODEL §7.
- **`.env.example`:** Cloudflare's documented Turnstile test keys (always pass), for development only.
- **New error codes:** `CAPTCHA_REQUIRED`, `PHONE_NOT_ALLOWED`.
- **Tests:** 11 unit tests (the number rule and the actions with a mocked Supabase client, the configuration guard, the widget).
- **Verified:** typecheck and lint clean; 138 unit and component tests; database 190 passed + 1 expected failure (SC-AUD-03, still open); production build passes.
- **Not verified:** Supabase Auth's own behaviour on a live stack, and the hosted dashboard settings.

### Added — Module 12: SaaS administration (2026-11-12)

- **Plans and limits** (BR-T-08):
  - `max_doctors`, `max_staff` and `monthly_sms_quota`; an empty limit means unlimited;
  - **"Formules" page** (platform): create, edit and retire plans with their price, limits, grace days and visibility to clinics;
  - one neutral **"Pilote" plan** is seeded (0 MAD, internal, no limit). **Real plans and prices are a commercial decision**, made in this page.
- **Subscriptions** (BUSINESS_RULES §7):
  - every clinic starts on a trial of the Pilote plan; **existing clinics get one by the migration**;
  - the platform assigns plan, status and period, and records payments ("active until …"), on a new **platform clinic page** with activity counts;
  - a daily job (`private.refresh_subscription_states()`, pg_cron where available): trial ended → expired; period ended → past due; past due beyond the plan's grace days → expired; cancelled at period end → expired.
- **Read-only clinics** (BR-P-01): with an expired subscription, the central permission helper (`private.clinics_with_permission`) keeps read permissions and drops write ones, so every RLS policy and command agrees. Data stays readable and exportable; **the owner can still ask for a plan**. The workspace shows a banner and hides write actions: it now loads its **effective permissions** from `get_my_clinic_access()`, which reflects MFA, clinic status and subscription.
- **Limits enforced in the database**, for every role and `postgres` too:
  - a doctor added or reactivated beyond `max_doctors`;
  - a member joining or reactivated, or an invitation sent, beyond `max_staff` (open invitations reserve a seat);
  - each check holds a per-clinic lock, so two concurrent additions cannot both take the last seat;
  - **SMS beyond `monthly_sms_quota`** are not sent and are recorded as `quota_exceeded`. The dispatcher function is replaced forward-only, with its body unchanged except this check. The e-mail fallback of BR-N-08 is not built yet.
- **Clinic "Abonnement" page** (owner, admin, accountant): plan, status, period or trial end, each limit with its current use, and for the owner a **plan change request** (one open request; the platform's decision answers it).
- **Platform clinic list:** plan and subscription status, open requests, appointments over 30 days. **Platform functions return clinic metadata and counts only** (`platform_kpi_overview`), never patient-level rows (RBAC §4). The platform pages share a new layout.
- **Migration 0029:**
  - `subscription_plans`, `subscription_features`, `subscriptions`, `subscription_change_requests`;
  - `get_my_subscription`, `list_available_plans`, `request_plan_change`, `get_my_clinic_access`;
  - `platform_list_plans`, `platform_save_plan`, `platform_set_subscription`, `platform_mark_subscription_paid`, `platform_kpi_overview`;
  - limit triggers, the lifecycle job, and the quota check in `jobs_claim_notifications`.
- **New error codes:** `PLAN_LIMIT_REACHED` (already in the API specification) and `SUBSCRIPTION_INVALID_TRANSITION`.
- **Tests:**
  - **7 database tests** (`subscriptions.test.ts`):
    - the trial at creation, visible to owner, admin and accountant only;
    - the lifecycle with grace days, invalid transitions, payments;
    - **read-only on expiry**: reads still work, booking and adding a doctor are refused, the request still works, writes come back once reactivated;
    - limits on doctors (including reactivation), invitations and members, for `postgres` too;
    - **two concurrent additions for the last seat: exactly one succeeds**;
    - an SMS over quota skipped as `quota_exceeded`;
    - **every platform function refused to owners, outsiders and platform admins without MFA; the overview has exactly the expected count columns; the platform admin reads no patient, appointment, invoice, notification or subscription row**; plan validation.
  - The isolation tests cover the subscription tables (the fixture adds a request in clinic A); the security metadata tests list the four new tables as command tables.
  - **4 unit tests:** the transitions offered mirror the database, periods, limits and usage.
- **Verified:**
  - typecheck and lint clean;
  - 127 unit and component tests;
  - database 190 passed + 1 expected failure (SC-AUD-03, still open);
  - production build passes.
- **Not verified:**
  - the platform and subscription screens with live data (no backend on this machine);
  - the pg_cron schedule on a real project.

### Added — Module 11: Analytics (2026-11-12)

- **"Statistiques" page** (`analytics.operational`: owner, admin, and a doctor for their own agendas):
  - periods: today, 7 days, 30 days, this month, last month; a doctor filter;
  - one metrics strip: appointments (K1, with online and walk-in counts), completed consultations (K2), cancellations by actor with "left before consultation" apart (K3), no-show rate (K4), mean and median wait (K5), utilization, booked and actual (K6);
  - tables per doctor, per service with each service's share of completed consultations (K8), and per day for periods up to a month;
  - for owners and admins, the period's revenue (K7, billing's definition) with a link to Recettes.
  - A ratio whose denominator is zero shows "—", never 0 %. The definitions are printed under the tables.
- **Migration 0028:** `kpi_operational(clinic, from, to, group, doctor?)` with `group` = total, day, doctor or service.
  - **SECURITY INVOKER** (API specification BC10): it reads under the caller's RLS, so a practitioner-only doctor gets their own agendas only, and asking for another doctor answers `NOT_FOUND`.
  - Local days in the clinic's time zone. Available minutes come from the schedule that applies on each date (an override beats the regular one), minus time off (as ranges) and clinic closures.
  - At most 366 days per call.
- **Dashboard:** today's no-show rate now counts patients who left before consultation in its denominator, as K4 defines it.
- **Tests:**
  - **4 database tests** (`analytics.test.ts`):
    - every KPI against a day computed by hand: statuses, sources, cancellation actors, the K4 denominator, waits (an early arrival, a late arrival, a walk-in, a start on time), booked, actual and available minutes;
    - grouping by doctor, by service and by local day, including an appointment at 00:00 local filed on its local date and a closed Saturday without availability;
    - scope: a doctor sees their own agenda; receptionists and accountants are refused; MFA is required; other clinics, outsiders, suspended members and patients get `NOT_FOUND`; invalid periods are rejected;
    - an empty period answers zeros and no rate.
  - **5 unit tests:** period ranges across months and years, day counts, ratios that are null on a zero denominator, the dashboard's K4.
- **Verified:**
  - typecheck and lint clean;
  - 123 unit and component tests;
  - database 183 passed + 1 expected failure (SC-AUD-03, still open);
  - production build passes.
- **Not verified:** the page with live data (no backend on this machine); speed on a year of real data (MODELING_REVIEW M-09 keeps a daily snapshot table for when measurements require it).

### Added — Module 10: Billing (2026-11-12)

- **Invoices:**
  - **"Facturer"** on the appointment file opens a draft at the appointment's booked price (BR-B-11), or links to its open invoice: one open invoice per appointment. **"Nouvelle facture"** on the patient file opens an empty draft.
  - **Draft editor:** lines from the clinic's services or free lines, quantity, unit price, discount and a note. The preview is computed in cents with the database's rounding (half-up per line); the database recomputes and stores every total.
  - **Issue:** a gapless number per clinic and year (`2026-000001`, from `clinic_counters`, BR-F-01), with snapshots of the patient's name and of the clinic's identity (legal name, ICE, address). From then on, the invoice is **immutable** (BR-F-02).
  - **Void** (owner, admin, accountant, MFA): only without payments, with a reason; the number is kept (BR-F-06). A draft is discarded instead, and never had a number.
- **Payments and receipts:**
  - **"Encaisser":** cash, card, transfer, cheque or other, with a reference. At most the balance (BR-F-04); each payment gets a gapless receipt number (`R2026-000001`, BR-F-07); a double click or retry records it once (idempotency key).
  - The invoice status follows its payments: issued, partially paid, paid (BR-F-03).
  - **Reversal** (owner, admin, accountant, MFA), with a reason: the payment stays in the history, marked reversed, and the balance is recomputed (BR-F-05).
- **Facturation page:** invoices by status (drafts, to collect, paid, void), search by number or patient name.
- **Recettes page** (`billing.reports`: owner, admin, accountant), per month and local day (K7): invoiced, voided, collected, reversed and net, by payment method. A correction counts on the day it is made, so past days never change.
- **Print views** of the invoice and of each receipt (`/print/<clinic>/invoices/<id>`), outside the workspace shell. They replace the stored PDFs planned in the API specification for now.
- **Accountants** read invoices without `patients.view`: the invoice carries the billed name.
- **Migration 0027:**
  - `invoices`, `invoice_items`, `payments`: command tier, RLS on `invoices.view`, composite tenant keys, audit triggers;
  - guards for everyone, `postgres` included: an issued invoice changes only through payments or voiding; lines exist only in draft; payments are never deleted, and only go from recorded to reversed; checks keep the paid amount between 0 and the total and coherent with the status;
  - `create_invoice_draft`, `update_invoice_draft`, `discard_invoice_draft`, `issue_invoice`, `void_invoice`, `record_payment`, `reverse_payment`, `revenue_summary`;
  - lock order: idempotency key, invoice row, payments, counters.
- **New error codes:** `INVOICE_IMMUTABLE`, `INVOICE_INVALID_TRANSITION`, `PAYMENT_EXCEEDS_BALANCE`.
- **Tests:**
  - **10 database tests** (`billing.test.ts`):
    - drafts at the booked price, idempotency, one open invoice per appointment, cancelled appointments not billable;
    - line totals rounded half-up, every invalid input rejected, the total capped at 10,000,000 MAD;
    - numbering, snapshots, immutability enforced on `postgres` too;
    - **five desks issuing at once, one of them rolling back: numbers 1 to 5, no gap**;
    - partial and full payment, overpayment refused, gapless receipts, idempotent retries;
    - reversals and status recomputation, payments neither deletable nor editable;
    - **three desks collecting the same balance at once: exactly one payment**;
    - voiding rules;
    - permissions: the front desk bills and collects; void and reversal only for owner, admin and accountant with MFA; doctors and other clinics see nothing and get `FORBIDDEN` or `NOT_FOUND`;
    - the revenue summary per local day.
  - The isolation tests cover the three new tables (the fixture adds an invoice, a line and a payment). The security metadata tests list them as command tables.
  - **6 unit tests:** money in cents (parsing with a dot or comma, half-up rounding, formatting) and the actions offered per status.
- **Verified:**
  - typecheck and lint clean;
  - 118 unit and component tests;
  - database 179 passed + 1 expected failure (SC-AUD-03, still open);
  - production build passes.
- **Not verified:**
  - the screens with live data (no backend on this machine);
  - printing on paper.
- **Pending decisions (BR-F-09):** VAT, the legal mentions required on invoices (ICE, IF, RC…), credit notes and fiscal-year rules need an accountant before commercial use. Invoices in the patient portal are P1.

### Added — Module 9: Notifications (2026-11-11)

- **What gets planned**, from the domain-event outbox, by the database (`private.plan_notifications()`, every minute):
  - a **confirmation** and the clinic's **reminders** (its offsets, e.g. 24 h and 2 h) when an appointment is confirmed;
  - on a **reschedule**, the scheduled messages are cancelled, then a "moved" message and new reminders are planned;
  - on a **cancellation**, the scheduled messages are cancelled and a cancellation message is planned, except when the patient left the waiting room, for a duplicate, or once the start has passed;
  - a **delay** reported by the doctor reaches the patients waiting and those confirmed within the next 3 hours;
  - **"your turn is near"** goes once per ticket, at the clinic's configured position.
  - **Quiet hours (21:00–08:00, clinic time):** a reminder moves to 08:00, or is recorded as not sent when that would be after the start.
  - **One message per patient and event**, on the patient's preferred channel; a patient with no preferred channel gets none. A unique idempotency key makes re-planning a no-op.
- **Before each send, the database re-checks** that the appointment or ticket still matches (otherwise "stale"), that the patient's latest consent for the channel is a yes, and that an address exists. Messages that fail a check are recorded as not sent, with the reason.
- **Templates:** French and Arabic platform defaults for SMS, WhatsApp and e-mail; a clinic may add its own versions (one active per event, channel and language). Only `{clinic}`, `{date}`, `{time}`, `{ticket}` and `{delay}` are allowed, so **no service, reason or other clinical detail can appear in a message**; SMS and WhatsApp bodies are limited to 320 characters. The content of a sent message is not stored, and the recipient is stored masked.
- **Sending:**
  - **worker endpoint `POST /api/internal/jobs/dispatch`**, called every minute by pg_cron + pg_net: an HMAC-SHA256 signature of `<timestamp>.<body>` and a timestamp less than 5 minutes old; the answer is counts only, `no-store`;
  - **no service-role key:** the worker calls three database functions as `anon`, each guarded by a job key whose SHA-256 is stored in `private.job_credentials` (the same secret signs the calls);
  - leases of 120 s with `skip locked` (two workers never send the same message), retries after 1, 5, 15 and 60 minutes, at most 5 attempts, permanent errors failing at once, an append-only attempt log, late provider answers ignored;
  - **providers:** an adapter interface with a `disabled` mode (default: messages stay planned, nothing is sent) and a `simulator` for development and staging. **No real SMS, WhatsApp or e-mail provider is connected yet** (a commercial choice still to make).
- **Appointment file:** a "Messages au patient" section (owner, admin, receptionist, via `notifications.view_log`) shows each message's event, channel, masked recipient, status, time, attempts and why it was not sent.
- **Migration 0026:** `notification_templates`, `notifications`, `notification_attempts` (append-only), the planner, `jobs_plan_notifications()`, `jobs_claim_notifications()`, `jobs_record_attempt()`, `private.call_dispatch()` and guarded pg_cron schedules. The domain-event outbox is now consumed (`processed_at`, up to 5 attempts per event).
- **Configuration:** `JOBS_SECRET` and `NOTIFICATIONS_PROVIDER` in `.env.example` (server only, never `NEXT_PUBLIC_`).
- **Tests:**
  - **13 database tests** (`notifications.test.ts`):
    - confirmation and reminders planned once, quiet hours, re-planning after a reschedule or a cancellation, no cancellation message after "left";
    - turn-approaching and delay messages;
    - never a reminder after a cancellation; consent, address and locale; no clinical detail; the masked recipient;
    - templates with any other placeholder rejected;
    - backoff, the fifth attempt failing, permanent errors, late answers ignored, lease timeouts;
    - the job key required, and signed-in users refused;
    - two concurrent workers claiming disjoint messages;
    - the message log visible to the front desk of the clinic only, templates to nobody;
    - the SQL signature matching the endpoint's verification.
  - **Security metadata tests:** the three job functions are the only new functions `anon` may execute, and each must call `private.require_job_key(p_job_key)`. The isolation tests cover both new tenant tables; the contract test checks the worker's calls against `anon`'s grants.
  - **15 unit tests:**
    - signature: reference vector, tampering, wrong secret, ±5 minutes, malformed headers, short secret;
    - providers: disabled by default, simulator, timeout and exception handling;
    - worker run: counts only, disabled mode claims nothing, stops on errors;
    - the route: `401` for unsigned, wrongly signed or stale calls and without `JOBS_SECRET` (the database is never called), `413` for a large body, counts only on success, `503` with no detail on a database refusal.
- **Verified:**
  - typecheck and lint clean;
  - 112 unit and component tests;
  - database 169 passed + 1 expected failure (SC-AUD-03, still open);
  - production build passes.
- **Not verified:**
  - pg_net calling the endpoint and pg_cron scheduling, on a real Supabase project (see the deployment notes in DATABASE_SCHEMA.md);
  - any real provider (none chosen); delivery receipts (`/api/webhooks/*`) are not built;
  - the Messages section with live data.

### Added — Module 8b: SmartFlow live (2026-11-11)

- **Live queue screens:**
  - reception and the doctor console subscribe to private Supabase Realtime topics and refresh when a hint arrives, with 60-second polling kept as a fallback;
  - the browser receives only the user's own short-lived access token, from a server action. The refresh token stays in the server cookie.
- **Waiting-room screens:**
  - **Settings → "Écrans de salle d'attente"** (owner and admin): create a screen for all doctors or a selection, copy its link (shown once), see when it was last online, revoke it;
  - **the public page `/display`** (French and Arabic, `noindex`) shows, for each doctor:
    - the ticket in consultation, the called tickets (announced to screen readers) and the next five;
    - how many patients are waiting, a clock, and a warning when the connection drops;
    - **never a patient name, file number, phone or service.**
  - **`GET /api/display`**: the token is sent as `Authorization: Bearer`, so it is never in a URL or an access log (the API specification is updated). The response is `no-store`.
- **Patient portal:** "Votre passage aujourd'hui" shows the linked patient's ticket and how many patients are ahead, "c'est votre tour" when called, and an estimate range. It refreshes every 30 seconds.
- **Estimate ranges:** the upper bound widens to max(20 %, p80 − median) wherever 20 or more consultations were measured.
- **Migration 0025:**
  - **realtime hints at commit**, on `clinic:<id>:board:<date>` and `clinic:<id>:doctor:<doctor>:<date>`. Payloads hold ids and the queue version only.
  - **topic authorization**: a policy on `realtime.messages` calls `private.can_receive_queue_topic()`. The board topic needs `queue.view`; a doctor topic also needs, for a practitioner-only member, that doctor's own agenda.
  - **display screens**: `queue_display_screens` with `create_display_screen()` (256-bit token returned once, SHA-256 stored, the hash never readable), `revoke_display_screen()` and `display_snapshot()`, the only function `anon` may execute.
  - **portal**: `portal_get_my_queue_status()`, with each clinic's own time zone.
  - **end of day**: `private.close_stale_sessions()`.
  - **pg_cron schedules** for statistics (nightly), overdue estimates (every minute) and stale sessions, created where pg_cron exists.
- **Test harness:** the Supabase shim gains a minimal Realtime interface (`realtime.messages`, `realtime.topic()`, `realtime.send()`), following Supabase's documented interface.
- **Tests:**
  - **6 database tests** (`smartflow-live.test.ts`):
    - hints on both topics, with exactly three id/version fields, sent at commit only;
    - topic access for reception, a doctor's own and another doctor's agenda, another clinic, an accountant, a patient, an outsider, and malformed topics;
    - screens: owner/admin only, token once and stored hashed, anonymous snapshot holding no patient data, doctor filter, wrong or revoked token answering `NOT_FOUND`, `last_seen_at` tracked;
    - the portal showing only one's own ticket and position;
    - the end-of-day job closing past days only.
  - **Security metadata tests stay strict:**
    - `display_snapshot` is the only anonymous function, and must look tokens up by digest;
    - the new topic helper is the only new private function callable by `authenticated`.
    - The isolation tests cover the screens table.
  - **4 unit and component tests:**
    - the widened range;
    - the display board: bearer header and never the URL, numbers only, revoked and missing-link states.
- **Verified:**
  - typecheck and lint clean;
  - 97 unit and component tests;
  - database 156 passed + 1 expected failure (SC-AUD-03, still open);
  - production build passes;
  - in the browser, the display page in French (missing link) and Arabic, RTL (retry state, since this machine has no backend): 0 axe violations, `no-store` and `noindex` confirmed, `404` without a token.
- **Not verified:**
  - delivery of realtime messages to browsers, which needs a Supabase project with Realtime Authorization enabled;
  - the screens and the portal with live data;
  - the pg_cron scheduling.
  - See the deployment notes in DATABASE_SCHEMA.md.

### Added — Module 8a: SmartFlow core (2026-11-11)

- **Doctor console** ("Ma journée", today), for each of the doctor's own agendas:
  - the day's state (not started, open, paused, closed) and any announced delay;
  - start, pause, resume, report a delay, close the day;
  - the current consultation, with "Terminer";
  - "Appeler le patient suivant";
  - called patients ("Commencer", or "Absent, remettre en attente");
  - the waiting list in queue order, with priority badges and an estimated start range.
- **Reception waiting room:**
  - estimated ranges and "Appelé" / "Prioritaire" badges;
  - set or remove priority, with a reason chosen from a list;
  - "Faire passer avant" (move up), with a reason;
  - corrections "Arrivé en retard" (after a no-show) and "Annuler le démarrage".
- **Both screens refresh every 20 seconds** while visible, standing in for realtime updates until 8b.
- **Migration 0024:**
  - **Calling and consultations:**
    - `call_next` (priority, then order key, then ticket);
    - `recall_entry`, which keeps the patient's place;
    - `start_consultation`: one patient at a time per doctor, and the day opens on first use;
    - `complete_consultation`.
  - **Priority and reordering, by a person with a reason only:** `set_queue_priority` and `move_queue_entry_before`.
  - **Corrections** (`correct_appointment_status`), owner and admin only, with a reason:
    - A13: undo a consultation start within 15 minutes;
    - A14: a no-show who arrives late the same day gets a new ticket, queued by arrival.
  - **The doctor's day:** `open_doctor_day`, `pause/resume/close_doctor_session`, `report_doctor_delay`. Closing is refused during a consultation and returns the number of patients still waiting.
  - **Estimates v1:**
    - recomputed at commit whenever the queue changes;
    - based on the doctor's availability (in consultation, idle, not started with first window plus delay, paused);
    - durations are observed medians once 20 or more consultations are measured, otherwise the booked duration.
    - `consultation_duration_stats` with its rebuild function, to schedule nightly at deployment.
  - **Locking:** `mark_left` was replaced so that every queue command follows one global lock order (appointment → doctor bookings → session → entries). No two queue commands can deadlock each other.
  - **New error codes:** `SESSION_PAUSED`, `SESSION_INVALID_TRANSITION`, `DOCTOR_BUSY`, `CORRECTION_WINDOW_PASSED`.
- **Tests:**
  - **9 database tests** (`smartflow.test.ts`):
    - call/start/complete in order, with the busy and scope refusals;
    - recall keeping the place, and priority set by staff with a reason;
    - reorder within a level;
    - A13 inside and outside the 15-minute window, and A14 with a new ticket queued by arrival;
    - the full day lifecycle with its guards;
    - estimates in every doctor state, with and without statistics;
    - the statistics rebuild (median 20, p80 26) and its visibility.
  - **The isolation tests now cover the statistics table**, and the security metadata test recognises the new authorization helpers.
  - **2 unit tests** for the estimate range.
- **Verified:**
  - typecheck and lint clean;
  - 93 unit tests;
  - database 150 passed + 1 expected failure (SC-AUD-03, still open), including the contract test for the 12 new calls;
  - production build passes.
- **Not verified:** the console and the waiting room with live data. They need a running Supabase backend, which is unavailable on this machine.
- **Module 8b (next):**
  - Realtime broadcast hints;
  - public display screens (ticket numbers only);
  - patient queue status in the portal;
  - scheduling of the statistics and overdue-estimate jobs;
  - the p80 widening of the range.
  - "Turn approaching" and delay messages come with module 9 (notifications).

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
