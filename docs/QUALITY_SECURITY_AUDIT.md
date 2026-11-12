# SmartCabin — engineering quality and security audit

- **Date:** 2026-11-11
- **Scope:** the repository as it stands. That is migrations 0001–0019, the seed, business modules 1–4 (authentication and onboarding, clinic and membership, doctors, patients), and the Phase 4 workspaces (reception, doctor's day, dashboard, portal, platform administration).
- **Method:**
  - automated checks;
  - new adversarial database tests;
  - measured query plans on synthetic volume;
  - accessibility scans of the running application;
  - reading of the implementation.
- **Severity scale:** CRITICAL / HIGH / MEDIUM / LOW. Every finding below was reproduced or read in the code; nothing is reported from assumption.

## 1. Verdict

- **No CRITICAL finding.** No tenant isolation breach, authorization bypass to confidential data, injection, secret exposure or data-corruption path was found. So no correction was required under the audit's "fix critical issues" mandate, and **no production code was changed**. The audit added tests only (§7).
- **3 HIGH findings:**
  - SMS-pumping exposure of patient phone sign-in, once an SMS provider is configured;
  - a slot-lookup cost that grows with each doctor's appointment history (measured at 2–5 s per week of slots);
  - deadlocks between simultaneous overlapping bookings for one doctor. Reception gets "unexpected error" instead of "slot taken", and the existing concurrency test fails intermittently. No double booking occurs.
- **8 MEDIUM and 12 LOW findings.** They are listed in §3 and detailed in §4 and §5.
- **Production readiness is NOT claimed.** The evidence does not support it:
  - the HIGH findings are open;
  - the Supabase Auth flows (email links, SMS OTP, TOTP) have never run end to end;
  - the screens have not been exercised against a live backend;
  - modules 5–12 do not exist;
  - legal texts are placeholders;
  - no real patient data may be processed before CNDP clearance.

## 2. Evidence — what was run

| Check | Result |
|---|---|
| `tsc --noEmit` (strict) | 0 errors |
| `eslint .` | 0 problems |
| Unit and component tests (`pnpm test`) | 8 files, 75 / 75 passed |
| Database tests (`pnpm test:db`, embedded PostgreSQL 17 + Supabase shim) | 13 files, 117 tests: 2 *expected failures* (open findings SC-AUD-02 and SC-AUD-03, see §7), all others pass except an **intermittent** failure of `concurrency.test.ts` › "never commits two overlapping appointments when start times differ". It failed in 1 of 2 full-suite runs and passed 3 of 3 times when run alone; the cause is SC-AUD-23. The other full run: 115 passed + 2 expected failures. |
| `pnpm audit --prod` | No known vulnerabilities |
| `pnpm audit` (including dev) | 1 moderate: `minimatch` ReDoS, dev toolchain only (SC-AUD-21) |
| `next build` (production) | Succeeds in 36 s. The `/[locale]/design-system` gallery is pre-rendered as 404 in production (verified in `.next/server/app`). |
| Translation keys | All 799 literal keys used in `src/` exist in `fr.json` and `ar.json`. Enum-driven keys (roles, statuses, channels, consent purposes, sources, staff cancellation reasons, document kinds) and all 32 error codes exist in both. Every code raised by SQL is mapped, except three integrity guards that the UI cannot reach. |
| Static scans | No `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`. No service-role key or browser Supabase client anywhere in `src/`. Only one physical-direction class pair (dialog centering, `left-1/2` + `-translate-x-1/2`), which is symmetric and correct in RTL. |
| Open redirect | `auth/callback` validates the locale and `safeNextPath` rejects absolute, protocol-relative, backslash and scheme paths. The redirect is always prefixed with `/{locale}`. |
| PostgREST filter injection | Patient search strips `, ( ) * % \ : "` before building `.or()`, and RLS scopes the result to the caller's clinics. No injection path. |
| Accessibility (axe-core 4.10.2, WCAG 2.0/2.1/2.2 A+AA + best practice) | 0 violations on 11 scans: sign-in (fr, ar), sign-up, forgot password, patient sign-in (ar), component gallery (fr, ar), application shell (fr, ar), dialog open. The dialog moves focus inside, is labelled and described, closes on Escape and returns focus to its trigger. One inconclusive contrast check was a false positive (element partly covered at that scroll position). |
| Query plans, 60 000 patients and 17 500 appointments, RLS active | Day agenda 2–3 ms (index on `(clinic_id, starts_at)`). Patient history 0.9–1.3 ms. Patient search 56–99 ms (sequential scan, SC-AUD-15). One week of free slots 2 065–5 041 ms (**SC-AUD-02**). RLS helpers are evaluated once per statement (hashed SubPlan), never per row. |
| Application ↔ database contract (new) | All 22 RPC calls name an existing function with existing parameter names, pass every required parameter, and are executable by `authenticated`. Every column the app selects, filters, orders, inserts or updates exists and is granted to `authenticated` with the right privilege. Every foreign-key hint in embedded selects exists. A mutation check (one misspelled column, one misspelled RPC parameter) made the test fail as intended. |

## 3. Findings summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| SC-AUD-01 | HIGH | Patient phone sign-in creates an account for any number, with no CAPTCHA (SMS pumping) | Fixed in code and configuration (2026-11-12); GoTrue behaviour to confirm on a live stack (SC-AUD-10) |
| SC-AUD-02 | HIGH | Free-slot lookup scans the doctor's entire appointment history for each candidate slot | **Fixed** 2026-11-11 by migration 0021 (see §8) |
| SC-AUD-23 | HIGH | Simultaneous overlapping bookings for one doctor deadlock (`40P01`) instead of answering "slot taken" | **Fixed** 2026-11-11 by migration 0020 (see §8) |
| SC-AUD-03 | MEDIUM | An admin can lift an owner-decided suspension of an admin through a new invitation | Open, confirmed, expected-failure test in place |
| SC-AUD-04 | MEDIUM | Unexpected errors are neither logged nor traceable | Open |
| SC-AUD-05 | MEDIUM | No Content-Security-Policy; HSTS left to the host | Open |
| SC-AUD-06 | MEDIUM | Session cookies are readable by page scripts (not HttpOnly) | Open |
| SC-AUD-07 | MEDIUM | Patient search terms (names, phone numbers) travel in the URL | Open |
| SC-AUD-08 | MEDIUM | Appointments never leave active states (no pending expiry, no completion yet) | Fixed: completion since module 8a; pending expiry (A7) by migration 0030, every 10 minutes where pg_cron exists. Confirmed appointments never checked in stay on the end-of-day list (MD-09) |
| SC-AUD-09 | MEDIUM | The development seed creates a platform admin with a published password, and runs on `db reset --linked` | Open |
| SC-AUD-10 | MEDIUM | The Auth flows (email, SMS OTP, TOTP) and the screens have never run against a live backend | Open (verification gap) |
| SC-AUD-11 | LOW | `create_clinic` pending-clinic limit can be exceeded by concurrent calls | Open (read in code, not reproduced) |
| SC-AUD-12 | LOW | Sign-up reports success for unexpected Auth errors | Open |
| SC-AUD-13 | LOW | Editing a patient whose preferred channel is WhatsApp silently changes it to SMS | Open |
| SC-AUD-14 | LOW | No application-level throttling of authenticated commands | Open |
| SC-AUD-15 | LOW | Patient search does not use the trigram index | Open |
| SC-AUD-16 | LOW | Slot picker radio group lacks arrow-key navigation | **Fixed** 2026-11-11 (module 6, see §8) |
| SC-AUD-17 | LOW | Login CSRF through email-link callback (`token_hash`) | Accepted risk, documented |
| SC-AUD-18 | LOW | Appointment commands lock the row before checking authorization | **Fixed** 2026-11-11 by migration 0022 (see §8) |
| SC-AUD-19 | LOW | Domain events are never consumed or purged | Partly fixed: consumed by module 9 (`processed_at`, idempotency key); retention purge still open |
| SC-AUD-20 | LOW | Clinic closures list is unbounded | Open |
| SC-AUD-21 | LOW | Dev-only `minimatch` advisory; build depends on Google Fonts | Open |
| SC-AUD-22 | LOW | Database tests run against a shim, not the real Supabase services | Open (verification gap) |

## 4. HIGH and MEDIUM findings

### SC-AUD-01 — HIGH — Patient phone sign-in creates accounts for any number, no CAPTCHA

- **Component:**
  - `src/modules/identity/actions.ts`: `requestPhoneCode` calls `signInWithOtp({ phone, options: { shouldCreateUser: true } })`;
  - `supabase/config.toml`: no `[auth.captcha]`, `enable_signup = true`, `sms_sent = 30`/hour.
- **Reproduction:** call the patient sign-in action (or GoTrue `/otp` directly with the public key) in a loop with arbitrary valid E.164 numbers, including premium-rate ranges. Each call creates an `auth.users` row and sends one SMS.
- **Business impact:** SMS toll fraud ("SMS pumping") billed to the clinic platform, up to the provider's per-hour limit, every hour. Also junk accounts.
- **Security impact:** financial abuse and resource exhaustion. No data exposure: a new phone account sees nothing until a clinic links it to a patient.
- **Recommended correction:**
  - enable Supabase CAPTCHA (Turnstile or hCaptcha) for OTP;
  - set `shouldCreateUser: false` for the portal, so accounts are created only when a clinic links a patient phone or during online booking (module 6 with CAPTCHA);
  - restrict SMS to Moroccan numbers (`+212`) at the action;
  - keep or tighten `sms_sent`.
- **Verification test:**
  - unit test: the action refuses non-`+212` numbers and does not create users;
  - a configuration check in CI that `[auth.captcha] enabled = true`;
  - manual GoTrue test on the local stack that an unknown number receives no SMS.

### SC-AUD-02 — HIGH — Free-slot lookup scans the doctor's whole history

- **Component:** `public.get_available_slots` (migration 0012), its `not exists (… tstzrange(x.starts_at, x.ends_at) && tstzrange(c.s, c.e))` predicate. Used by the booking dialog through `src/modules/appointments/actions.ts`.
- **Reproduction:** `tests/db/performance.test.ts`, test "lists one week of free slots within budget…":
  - one doctor with 8,760 appointments (one year, 24 a day);
  - a one-week lookup measured 2,065 ms and 5,041 ms on two runs.
  - Cause:
    - the overlap test cannot use the GiST exclusion index, which is partial (`not is_overbooked`);
    - the `(doctor_id, starts_at)` btree only narrows by doctor;
    - so every candidate slot re-reads all of the doctor's appointments.
- **Business impact:** the booking dialog at reception gets slower every month a doctor works, which is directly felt in the core workflow. A busy doctor reaches this volume in about one year.
- **Security impact:** availability. `slots.view` is held by every staff role, and a few parallel calls can saturate database CPU.
- **Recommended correction:** a forward migration that replaces the predicate with the exact bounded form

  ```sql
  x.starts_at < c.e and x.starts_at > c.s - interval '480 minutes' and x.ends_at > c.s
  ```

  It is exact, because `appointments_duration` caps a duration at 480 minutes. Measured on the same data: **3 ms instead of 1,309–2,335 ms, with an identical result (173 free slots)**, using `appointments_doctor_start_idx`.
- **Verification test:** remove `.fails` from the performance test (budget 1 s), and keep `tests/db/scheduling-booking.test.ts` green for slot correctness.

### SC-AUD-23 — HIGH — Overlapping simultaneous bookings deadlock

The ID is out of order because this finding was found last, during the final verification run.

- **Component:**
  - `public.book_appointment` (migrations 0012, 0014, 0019), and the same pattern in `reschedule_appointment`;
  - the `appointments_no_overlap` exclusion constraint;
  - `toErrorCode`, which does not map `40P01`.
- **Reproduction:**
  - Several connections book the same doctor at the same moment with *different but overlapping* start times (13:00, 13:05, 13:10…). With an exclusion constraint, each transaction inserts its index entry, then waits for the other's conflicting in-progress entry. Two such waits form a cycle, and PostgreSQL aborts one with `40P01 deadlock detected`.
  - A temporary stress test produced 12 and 25 deadlocks in two runs of 144 bookings (24 rounds × 6).
  - `tests/db/concurrency.test.ts` › "never commits two overlapping appointments when start times differ" catches it intermittently. That test was green three times in a row after migration 0019, which was not enough evidence.
- **Business impact:** two receptionists, or later a receptionist and an online patient, booking close times for one doctor see "unexpected error" instead of "slot taken" and must retry. No double booking is ever committed: the exclusion constraint still holds, and the test's overlap count is 0.
- **Security impact:** none on integrity or confidentiality. Errors are not logged (SC-AUD-04), so the issue would be invisible in production.
- **Recommended correction:**
  - a forward migration that serializes bookings per doctor with a transaction-scoped advisory lock taken just before the insert, `perform pg_advisory_xact_lock(hashtextextended('booking-doctor:' || p_doctor_id::text, 0))`;
  - the same lock in `reschedule_appointment` before its update;
  - lock order stays deadlock-free: idempotency key, then doctor; or appointment row, then doctor;
  - map `40P01` to `UNAVAILABLE` (retry) in `toErrorCode` as a safety net.
  - **Validated:** with the lock added to `book_appointment` on the throwaway test database, the same stress test produced **0 deadlocks in 2 × 144 bookings**. Throughput cost is negligible: bookings for one doctor are seconds apart.
- **Verification test:**
  - the existing concurrency test, green across repeated full-suite runs;
  - a permanent version of the stress test (24 rounds, distinct overlapping starts, every failure must be `SLOT_UNAVAILABLE`) for booking and for rescheduling.

### SC-AUD-03 — MEDIUM — An admin can lift an owner's suspension of an admin through an invitation

- **Component:** `public.invite_member` (refuses only *active* members) and `public.accept_invitation` (`on conflict … do update … where m.status <> 'active'` reactivates any non-active membership), migration 0011.
- **Reproduction:** `tests/db/audit-adversarial.test.ts`, "does not let an admin lift a suspension…":
  1. A clinic admin is suspended.
  2. Another admin cannot reactivate them (`set_member_status` → FORBIDDEN, as designed).
  3. That admin invites the same e-mail as receptionist, and the suspended person accepts.
  4. The membership becomes `active / receptionist`. Confirmed: the invitation and the acceptance both succeeded.
- **Business impact:** a suspension decided by the owner, for example during an internal investigation, can be lifted by an admin. That contradicts the rule that admins manage non-admin members only.
- **Security impact:** an RBAC boundary bypass. It needs a cooperating admin and grants no role above what that admin may already invite.
- **Recommended correction:**
  - `invite_member` raises `MEMBER_SUSPENDED` when the e-mail belongs to a suspended member of the clinic;
  - `accept_invitation` reactivates only `removed` memberships and refuses `suspended` ones, which covers suspensions made after the invitation was sent.
  - Reactivation stays with `set_member_status`.
- **Verification test:** remove `.fails` from that test.

### SC-AUD-04 — MEDIUM — Unexpected errors are neither logged nor traceable

- **Component:**
  - `src/shared/lib/errors.ts` `toErrorCode` maps any unknown error to `INTERNAL`;
  - there is no `console.*` or logger call anywhere in `src/` (grep);
  - `signUp` also hides non-listed errors (SC-AUD-12).
- **Reproduction:** make any RPC fail with an unmapped SQLSTATE, for example a database restarted mid-request. The user sees "unexpected error" and no trace exists anywhere.
- **Business impact:** incidents cannot be diagnosed. Support cannot correlate a clinic's complaint with a cause.
- **Security impact:** weak detection. Repeated forbidden or failed operations are invisible, which hurts auditability (database audit logs record successful changes only).
- **Recommended correction:**
  - one server-side `reportError(context, error)` used by `toErrorCode` callers for `INTERNAL` and `UNAVAILABLE`;
  - structured, with a request id returned to the user, and without PII (no request bodies, no patient fields);
  - to the host's log drain; an error tracker after a DPA.
- **Verification test:** unit test that `INTERNAL` calls the reporter once with a request id and no input payload.

### SC-AUD-05 — MEDIUM — No Content-Security-Policy; HSTS left to the host

- **Component:** `next.config.ts` sends `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy` and `Permissions-Policy`, but no CSP and no `Strict-Transport-Security`.
- **Reproduction:** `curl -I` on any page of a production build. No `content-security-policy` header.
- **Business impact:** none today.
- **Security impact:** defense in depth only. React escaping and the absence of raw-HTML sinks were verified, but any future XSS (a dependency or a new sink) would run unrestricted and could read session cookies (SC-AUD-06).
- **Recommended correction:**
  - a nonce-based CSP in `src/proxy.ts` (`default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'; connect-src 'self' <supabase-url>; frame-ancestors 'none'; img-src 'self' data:`);
  - HSTS at the edge, or in headers for production.
- **Verification test:** a Playwright check that pages carry the CSP and that no CSP violation is reported on the main screens.

### SC-AUD-06 — MEDIUM — Session cookies are readable by page scripts

- **Component:** `src/shared/lib/supabase/server.ts` and `src/proxy.ts` use `@supabase/ssr` defaults (`httpOnly: false`). No browser Supabase client exists, so nothing needs script access to these cookies.
- **Reproduction:** after sign-in, `document.cookie` in the browser console shows the `sb-…-auth-token` cookies.
- **Business impact:** none directly.
- **Security impact:** any XSS could steal the refresh token and take over the session, including MFA-elevated owner sessions.
- **Recommended correction:**
  - pass `cookieOptions: { httpOnly: true, secure: true, sameSite: 'lax' }` to both server clients;
  - verify that `@supabase/ssr` 0.12 honours it on refresh.
- **Verification test:** an integration test of the proxy that the `Set-Cookie` header contains `HttpOnly; Secure`.

### SC-AUD-07 — MEDIUM — Patient search terms travel in the URL

- **Component:** the patients page reads `?q=` and passes it to `searchPatients`.
- **Reproduction:** search "Haddou 0612…". The URL becomes `/w/<clinic>/patients?q=Haddou…`.
- **Business impact:** patient names and phone numbers land in browser history, in shared screenshots, and in the hosting provider's request logs (possibly outside Morocco), which is a CNDP concern.
- **Security impact:** personal-data exposure in logs. `Referrer-Policy` already prevents leakage to other sites.
- **Recommended correction:**
  - submit the search through a Server Action (POST) and keep the term in client state;
  - or keep only a non-identifying page state in the URL.
- **Verification test:** a Playwright test that after a search the URL contains no query term.

### SC-AUD-08 — MEDIUM — Appointments never leave active states

- **Component:**
  - no job expires `pending` appointments, although the `not_confirmed_in_time` reason exists;
  - check-in and completion arrive with modules 7–8.
- **Reproduction:** book a pending appointment. It blocks its slot until someone acts on it, indefinitely.
- **Business impact:** unconfirmed requests block capacity, and active-status history accumulates, which compounds SC-AUD-02.
- **Security impact:** none.
- **Recommended correction:**
  - a scheduled `expire_pending_appointments()` (`pg_cron` or a scheduled function) that cancels with `actor = system`, `reason = not_confirmed_in_time` after the clinic's policy delay;
  - deliver modules 7–8 for completion and no-show.
- **Verification test:** a DB test that the function cancels only pending appointments past the delay, writes history, and is idempotent.

### SC-AUD-09 — MEDIUM — The development seed creates a platform admin with a published password

- **Component:** `supabase/seed.sql` (`admin@example.test`, platform admin, password in the file) and `supabase/config.toml` (`[db.seed] enabled = true`).
- **Reproduction:** `supabase db reset --linked` against a remote project runs the seed there. Anyone who reads the repository can then sign in. The account has no TOTP factor yet, so the attacker enrols their own and reaches the aal2 that platform functions require.
- **Business impact:** platform takeover. The precondition is an operator error that also wipes the remote database.
- **Security impact:** full platform-admin access.
- **Recommended correction:** make the seed refuse to run when the database holds any non-`.test` account, or any clinic not created by the seed, and document `db reset --linked` as forbidden.
- **Verification test:** a DB test that applying the seed on a database containing a non-`.test` user raises an error.

### SC-AUD-10 — MEDIUM — The Auth flows and the screens have never run against a live backend

- **Component:**
  - email confirmation, recovery links, SMS OTP and TOTP enrolment/verification (GoTrue);
  - every workspace screen with real data.
- **Reproduction:** Docker Desktop is unavailable on the development machine, so the local Supabase stack cannot start. The database layer is verified on embedded PostgreSQL. The new contract test now checks the app's calls against the schema.
- **Business impact:** defects in redirects, cookies, MFA steps or screen rendering with real data would surface only at first deployment.
- **Security impact:** the MFA enforcement path (`aal` claims from GoTrue) is verified only with simulated JWT claims.
- **Recommended correction:** run the local stack (Docker) or a Supabase staging project with synthetic data, then add Playwright end-to-end tests for sign-up → onboarding → MFA → booking, and patient OTP → portal.
- **Verification test:** that Playwright suite, green in CI.

## 5. LOW findings

Each entry gives the component, reproduction, impact (business / security), correction and verification test.

- **SC-AUD-11 — The `create_clinic` pending limit can be exceeded concurrently.**
  - **Component:** `create_clinic` (migration 0015) counts the caller's `pending_approval` clinics (`>= 3` refuses) without a lock.
  - **Reproduction (read in the code, not yet reproduced by a test):** several parallel `create_clinic` calls for one user each see a count below 3 and insert.
  - **Impact:** more clinic requests to review than intended / quota bypass only.
  - **Correction:** `perform pg_advisory_xact_lock(hashtextextended('create_clinic:' || v_uid, 0))` before counting.
  - **Verification test:** a concurrency test with 6 parallel calls for one user that expects exactly as many successes as the remaining quota.
- **SC-AUD-12 — Sign-up reports success on unexpected Auth errors.**
  - **Component:** `signUp` in `src/modules/identity/actions.ts`. Only `WEAK_PASSWORD`, `RATE_LIMITED` and `UNAVAILABLE` are surfaced; other errors return `ok`.
  - **Reproduction:** an SMTP misconfiguration. The user is told to check their inbox and no e-mail ever arrives.
  - **Impact:** lost sign-ups, not diagnosable (with SC-AUD-04) / none. The behaviour is intended to avoid account enumeration.
  - **Correction:** keep the neutral answer for "already registered" only, and report other errors through SC-AUD-04.
  - **Verification test:** a unit test with a mocked Auth error.
- **SC-AUD-13 — The edit dialog changes a WhatsApp preference to SMS.**
  - **Component:** `patients/[patientId]/page.tsx` maps `whatsapp → sms` for the form, and the update schema allows only `sms | email | none`.
  - **Reproduction:** a patient with `preferred_channel = whatsapp` (database or future online booking); edit their phone and save. The channel is now SMS.
  - **Impact:** reminders on a channel the patient did not choose, possibly without SMS consent / none.
  - **Correction:** add `whatsapp` to the schema and the select, or keep the stored value when the field is untouched.
  - **Verification test:** a unit test of the schema plus a component test of the dialog defaults.
- **SC-AUD-14 — No application-level throttling of authenticated commands.**
  - **Component:** Server Actions (search, booking, invitations).
  - **Reproduction:** a staff account scripts thousands of searches or slot lookups.
  - **Impact:** load amplification (see SC-AUD-02) / availability.
  - **Correction:** per-user token bucket in the proxy or the actions (for example with an edge KV), or rely on the host's WAF.
  - **Verification test:** a unit test of the limiter.
- **SC-AUD-15 — Patient search does not use the trigram index.**
  - **Component:** `searchPatients` uses five per-column `ilike '%q%'`, while `patients_name_trgm_idx` indexes a concatenated expression.
  - **Reproduction:** `tests/db/performance.test.ts` shows a sequential scan, 56–99 ms with 30,000 patients per clinic.
  - **Impact:** acceptable now; grows linearly / none.
  - **Correction:** a search RPC filtering on the indexed expression, or a generated `search_text` column with its own trigram index.
  - **Verification test:** the performance test asserts a Bitmap Index Scan on the trigram index.
- **SC-AUD-16 — Slot picker keyboard pattern.**
  - **Component:** `slot-picker.tsx`, `role="radiogroup"` with `role="radio"` buttons.
  - **Reproduction:** Tab moves through every slot, and arrow keys do nothing (WAI-ARIA radio-group pattern expects roving focus).
  - **Impact:** slower keyboard booking at reception / none.
  - **Correction:** roving `tabIndex` plus arrow keys (direction-aware in RTL), or use Radix `RadioGroup`.
  - **Verification test:** a component test with `userEvent.keyboard('{ArrowRight}')`.
- **SC-AUD-17 — Login CSRF through the e-mail link callback.**
  - **Component:** `auth/callback/route.ts` (`token_hash` flow).
  - **Reproduction:** an attacker sends a victim their own valid confirmation link. The victim's browser becomes signed in to the attacker's account.
  - **Impact:** confusion; the victim could enter data into the attacker's account / low. This is inherent to e-mail-link sign-in.
  - **Correction:** accept the risk. Optionally, show the signed-in e-mail prominently after a link sign-in.
  - **Verification test:** none needed beyond the existing `safeNextPath` tests.
- **SC-AUD-18 — Commands lock the appointment before authorization.**
  - **Component:** `private.lock_appointment_for_command` (`select … for update`, then `require_clinic_access`).
  - **Reproduction:** a member of another clinic calls `confirm_appointment` with a known id. The row is locked for the duration of the failing call.
  - **Impact:** negligible contention / no data access (NOT_FOUND).
  - **Correction:** read the row without a lock, check access, then lock.
  - **Verification test:** a DB test where a foreign caller does not block a concurrent legitimate command.
- **SC-AUD-19 — Domain events are never consumed or purged.**
  - **Component:** `domain_events` outbox (migration 0007).
  - **Reproduction:** every command emits an event; none is ever processed.
  - **Impact:** unbounded table growth; notifications will need idempotent consumption (module 9) / none.
  - **Correction:** module 9 consumer with `processed_at` plus a retention purge.
  - **Verification test:** a consumer idempotency test (same event twice → one notification).
- **SC-AUD-20 — The clinic closures list is unbounded.**
  - **Component:** `src/modules/tenancy/queries.ts` (`clinic_closures` select without a date bound or limit).
  - **Reproduction:** years of closures load on every settings view, capped silently by PostgREST's row limit.
  - **Impact:** minor / none.
  - **Correction:** load closures ending today or later, plus a paginated history.
  - **Verification test:** a unit test of the query builder or a DB test of the RPC.
- **SC-AUD-21 — Toolchain hygiene.**
  - **Component:** dev dependency `minimatch` (GHSA-g3hv-75wg-m249, moderate ReDoS, through `eslint-config-next`); `next/font/google` downloads fonts at build time.
  - **Reproduction:** `pnpm audit`; a build without network access fails.
  - **Impact:** none at runtime / none in production (dev only).
  - **Correction:** update when `eslint-config-next` ships a fixed range, or add a pnpm override `minimatch@>=11.0.1` if compatible; self-host the IBM Plex files with `next/font/local`.
  - **Verification test:** `pnpm audit` clean; an offline build in CI.
- **SC-AUD-22 — The database tests run against a shim.**
  - **Component:** `tests/db/harness/supabase-shim.sql` reproduces the API roles, `auth.uid()`/`auth.jwt()` and default privileges, but not GoTrue, PostgREST or Realtime.
  - **Reproduction:** n/a (method limit).
  - **Impact:** behaviour that depends on real Supabase services is unverified / RLS and grants verified on PostgreSQL itself.
  - **Correction:** run the same suite with `TEST_DATABASE_URL` against the local Supabase stack once Docker works (supported already).
  - **Verification test:** the same suite, green against the stack.

## 6. Areas assessed without defects found

- **Multi-tenant isolation and RLS:**
  - 53 policies;
  - cross-clinic reads return nothing and cross-clinic commands answer NOT_FOUND;
  - composite tenant foreign keys and the immutable `clinic_id` are tested (tenant-isolation, security-meta).
- **RBAC:**
  - the permission matrix per role, suspended members limited to reads, the MFA requirement for owner, admin, accountant and platform admin (rbac, membership);
  - new checks on `revoke_invitation`: permission, clinic scope, the admin role limit, and a revoked token cannot be accepted.
- **Appointment concurrency** (apart from SC-AUD-23, which affects error reporting, not integrity):
  - 10 simultaneous bookings of one slot → exactly 1;
  - idempotent retries (concurrency suite);
  - no overlapping pair ever committed, even when deadlocks occur;
  - new (the reschedule race can also be exposed to SC-AUD-23 until it is corrected):
    - two appointments moved into the same free slot at once → exactly one succeeds, the other gets `SLOT_UNAVAILABLE`;
    - confirm racing cancel → always a valid final state (`cancelled`), with history rows matching the successful commands;
    - two edits from the same version → the second gets `STALE_STATE`.
- **UI ↔ database rules:** every action the reception UI offers for a status is allowed by `appointment_status_transitions`, and rescheduling is offered exactly where the database accepts it (new parity test).
- **Input validation:**
  - zod on every Server Action;
  - database checks (formats, ranges, coherence constraints) as the final authority.
- **Sensitive data:**
  - no service-role credentials;
  - invitation tokens stored as SHA-256 only and delivered in the URL fragment;
  - patient views audited (`patient.viewed`);
  - the audit trigger stores field names, not values.
- **Arabic RTL:**
  - logical properties throughout;
  - `dir` and `lang` set per locale;
  - parity of keys and placeholders tested;
  - axe found no issue in `ar` pages.
- **Build reliability:**
  - the production build passes;
  - the development gallery is excluded from production;
  - lint and types are clean.

**Not assessable, because the modules do not exist yet:**

- SmartFlow queue correctness (module 8);
- notification idempotency (module 9; only the outbox table exists, see SC-AUD-19);
- billing (10), analytics (11) and SaaS administration beyond clinic status (12).

## 7. Changes made during the audit

No application code, migration or translation was changed. Added or changed:

- **`tests/db/audit-adversarial.test.ts`**: 5 passing tests (invitation revocation, the three concurrent-command scenarios, transition parity). Plus 1 *expected failure* documenting SC-AUD-03.
- **`tests/db/performance.test.ts`**: 1 passing plan/budget test (search, agenda, patient history; index use; once-per-statement RLS). Plus 1 *expected failure* documenting SC-AUD-02.
- **`tests/db/app-contract.test.ts`**: 4 tests checking every RPC call and table access in `src/` against the schema and the `authenticated` privileges.
- **`tests/db/helpers/fixtures.ts`**: `createUser` is now exported.
- **`.claude/launch.json`**: a second dev-server entry on port 3100, because port 3000 was taken by another project.
- **Temporary measurement tests**, deleted after use: the slot-predicate comparison (SC-AUD-02) and the overlapping-booking stress test (SC-AUD-23). The SC-AUD-23 candidate fix was applied only to the throwaway embedded database. No migration was changed.

An expected failure (`it.fails`) passes while the defect exists. When a correction lands, the test fails, which reminds you to remove `.fails`, and then it guards against regression.

## 8. Corrections after the audit

| Date | Finding | Correction | Evidence |
|---|---|---|---|
| 2026-11-11 | SC-AUD-23 (HIGH) | Migration 0020: `private.lock_doctor_bookings()`, a per-doctor advisory lock taken before writing in `book_appointment` and `reschedule_appointment`. `40P01`/`40001` now map to the retry message. | New stress tests in `tests/db/concurrency.test.ts`: 24 rounds of overlapping bookings and 9 of overlapping reschedules. They failed before the migration (22 deadlocks) and pass after it. Full database suite green 3 runs in a row (117 passed + 2 expected failures); concurrency file green 5 runs in a row. |
| 2026-11-11 | SC-AUD-02 (HIGH) | Migration 0021 (module 5): the overlap search of `get_available_slots` is bounded to `starts_at in (slot start - 480 min, slot end)`, which uses `(doctor_id, starts_at)`. | `tests/db/performance.test.ts`: the expected-failure marker is removed and a one-week lookup with a year of history passes the 1 s budget. The same rewrite fixed a latent defect found by the new time-change property tests. On 2027-02-07 (Ramadan switch), a 20-minute slot lasted 80 minutes, because its end was converted from local time. Ends are now start + duration. |
| 2026-11-11 | SC-AUD-18 (LOW) | Migration 0022: `private.lock_appointment_for_command` checks clinic access, permission and doctor scope on an unlocked read, then locks the row. `clinic_id` and `doctor_id` are immutable, so the checks still hold. | `tests/db/appointments.test.ts`: while a legitimate transaction holds the row, a user of another clinic gets `NOT_FOUND` at once. Before the fix, the same test hit `lock timeout`. |
| 2026-11-12 | SC-AUD-01 (HIGH) | `sendPhoneCode` uses `shouldCreateUser: false` and answers an unknown number like a known one; only Moroccan mobile numbers (`+2126`, `+2127`) get a code (synthetic `+999` outside production). Turnstile CAPTCHA on every form that reaches Supabase Auth (sign-up, password sign-in, SMS code, password reset): the token is passed to Supabase Auth, and the server refuses early when a site key is configured but no token comes. `supabase/config.toml`: `[auth.captcha]` enabled (Turnstile, secret from the environment), `[auth.sms] enable_signup = false` kept, `max_frequency` raised from 5 s to 60 s, `sms_sent = 30` per hour kept. New codes `CAPTCHA_REQUIRED` and `PHONE_NOT_ALLOWED`. | `src/modules/identity/sms-abuse.test.ts` (7 tests, Supabase client mocked): Supabase Auth is never asked to create an account; a foreign, landline or premium number never reaches it; a missing token is refused when CAPTCHA is configured; an unknown number gets the same answer; rate limits and CAPTCHA refusals are reported, other details hidden. `src/shared/lib/auth-config.test.ts` (2 tests): fails if the CAPTCHA, the phone sign-up block or the SMS limits are loosened in `config.toml`. `src/shared/ui/captcha.test.tsx` (2 tests). Typecheck, lint, 138 unit tests, database 190 passed + 1 expected failure (SC-AUD-03, still open), build: all green. **Not verified:** GoTrue on a live stack (no Docker here), and the hosted project's dashboard settings, which must mirror `config.toml` (SECURITY_MODEL §7). |
| 2026-11-12 | SC-AUD-01 (follow-up, S7) | Online booking needs new phone accounts, so phone sign-ups are on again in Supabase Auth, **behind the before-user-created hook** `public.before_user_created` (migration 0030): only Moroccan mobile numbers can create an account. CAPTCHA and the SMS limits are unchanged. The portal's sign-in still never creates an account. | `tests/db/portal.test.ts`: the hook accepts `+2126`/`+2127` numbers and refuses foreign, landline, premium and synthetic numbers; only `supabase_auth_admin` can call it. `auth-config.test.ts` requires the hook in `config.toml`. Not verified on a live stack. |
| 2026-11-11 | SC-AUD-16 (LOW) | The slot picker is now a WAI-ARIA radio group (`slot-radio-group.tsx`): a single Tab stop, arrow keys move and select, Home/End, and Left/Right follow the reading direction. | `slot-radio-group.test.tsx`: 3 component tests, including Arabic (RTL). |

Every other finding is still open as described above, including SC-AUD-03, which keeps its expected-failure test.
