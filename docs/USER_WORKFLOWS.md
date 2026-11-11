# SmartClinic — User Workflows

| | |
| --- | --- |
| Status | **Draft for review** (system modeling phase) |
| Date | 2026-11-10 |
| Related | [BUSINESS_RULES.md](BUSINESS_RULES.md) (rule ids referenced below) · [API_SPECIFICATION.md](API_SPECIFICATION.md) (commands) |

This document has four diagrams:
1. The patient journey (activity diagram).
2. Clinic onboarding (sequence).
3. Queue management (sequence).
4. Notification dispatch (sequence). The queue flow depends on it.

---

## 1. Patient journey — activity diagram

The colors show who acts: **patient**, **system**, **reception**, **doctor**.

```mermaid
flowchart TD
    S((Start)):::patient --> A[Opens the clinic booking link or scans its QR code]:::patient
    W0((Walk-in)):::patient --> WR[Reception finds or creates the patient record]:::reception
    WR --> WA[Walk-in appointment created directly in checked_in]:::system
    WA --> TK

    A --> B[Chooses a service and a doctor]:::patient
    B --> C[System computes available slots on the server]:::system
    C --> D{Any slot that suits?}
    D -- No --> B
    D -- Yes --> E[Selects a slot and enters a phone number]:::patient
    E --> F[OTP sent by SMS]:::system
    F --> G{OTP valid?}
    G -- "No, attempts left" --> E
    G -- "No, limit reached" --> X1[Blocked temporarily, rate limit]:::system
    G -- Yes --> H{Who is the appointment for?}
    H -- "A person already linked to this account" --> J
    H -- "Myself or a dependent, first time" --> I[Enters minimal details and consents]:::patient
    I --> J[Confirms the booking]:::patient
    J --> K[book_appointment, one transaction]:::system
    K --> L{Slot still free and rules met?}
    L -- No --> C
    L -- Yes --> M{Clinic auto-confirms online bookings?}
    M -- Yes --> N[Status confirmed, confirmation message sent]:::system
    M -- No --> O[Status pending, booking received message sent]:::system
    O --> P{Reception confirms before the start time?}
    P -- Yes --> N
    P -- "Declines or time passes" --> X2[Cancelled, patient informed]:::system

    N --> Q[Reminder sent 24 h before, status re-checked first]:::system
    Q --> R{Patient still coming?}
    R -- "No, cancels before cutoff" --> X3[Cancelled from the portal]:::patient
    R -- "Wants another time" --> C
    R -- Yes --> T{Arrives on the day?}
    T -- No --> NS[Reception marks no-show after the grace period]:::reception
    T -- Yes --> U[Reception checks the patient in]:::reception
    U --> TK[Ticket number and estimated wait range shown]:::system
    TK --> V[Waits and can follow the queue position on a phone]:::patient
    V --> V2{Two or fewer patients ahead?}
    V2 -- Yes --> V3[Turn approaching message, sent once]:::system
    V2 -- No --> V
    V3 --> Y[Doctor calls the ticket]:::doctor
    Y --> Y2{Patient present?}
    Y2 -- "No, recall later" --> V
    Y2 -- "Left the clinic" --> X4[Closed as left before consultation]:::reception
    Y2 -- Yes --> Z[Consultation in progress]:::doctor
    Z --> ZC[Doctor completes the consultation]:::doctor
    ZC --> INV[Invoice issued and payment recorded]:::reception
    INV --> RC[Receipt given or sent]:::system
    RC --> E1((End)):::patient
    NS --> E1
    X2 --> E1
    X3 --> E1
    X4 --> E1

    classDef patient fill:#e0f2fe,stroke:#0369a1,color:#0c4a6e
    classDef system fill:#f1f5f9,stroke:#475569,color:#0f172a
    classDef reception fill:#ccfbf1,stroke:#0f766e,color:#134e4a
    classDef doctor fill:#fef3c7,stroke:#b45309,color:#78350f
```

**Notes**
- **Slot lists come from the server** (BR-B-04…08). A slot shown to the patient can still be taken by someone else before confirmation, which is why step K re-checks it atomically.
- **Linking a person to an account (step H)** never happens by matching phone numbers (BR-D-02). A "first time" booking creates a new patient record linked to the account. Reception merges duplicates later.
- **The portal shows queue position and estimate by polling**, not through realtime ([SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) §5.2). It never shows other patients.
- **Patients without a smartphone** follow the same path from "Reception checks the patient in" onwards. Their booking is made by reception over the phone, starting in `confirmed`.

---

## 2. Clinic onboarding — sequence diagram

```mermaid
sequenceDiagram
    autonumber
    actor O as Clinic owner
    participant W as Next.js app (Vercel)
    participant A as Supabase Auth
    participant DB as Postgres (commands + RLS)
    participant WK as Worker (jobs route)
    participant E as Email provider
    actor PA as Platform admin

    O->>W: Sign up with email, password and language
    W->>A: signUp with CAPTCHA token
    A->>E: Send verification email
    E-->>O: Verification link
    O->>A: Open the verification link
    A-->>W: Session established (aal1)
    W->>DB: accept_legal_documents(terms, privacy policy)
    O->>W: Clinic details (name, city, phone, proposed slug)
    W->>DB: create_clinic(details)
    Note over DB: One transaction. Clinic in pending_approval, settings with defaults,<br/>owner membership, trial subscription, counters, audit entry,<br/>domain event clinic.submitted
    DB-->>W: clinic id and slug
    W-->>O: Ask to enable two-factor authentication
    O->>A: Enroll a TOTP factor and verify a code
    A-->>W: Session upgraded to aal2
    W->>DB: accept_clinic_dpa(clinic) requires aal2

    par Setup while pending approval
        O->>W: Add services, doctors, weekly schedules
        W->>DB: Managed-table writes under RLS
        DB-->>W: Rows saved, audited
    and Platform review
        WK->>DB: Claim clinic.submitted
        WK->>E: Notify the platform team
        PA->>W: Open the clinic in the platform workspace (aal2)
        W->>DB: platform_approve_clinic(clinic) on the privileged path
        Note over DB: Status active, approved_by and approved_at,<br/>audit entry, domain event clinic.approved
    end

    WK->>DB: Claim clinic.approved
    WK->>E: Clinic is active email to the owner
    O->>W: Turn on online booking
    W->>DB: update clinic_settings online_booking_enabled
    Note over DB: Trigger BR-T-07 checks the clinic is active<br/>and has an online-bookable doctor and service
    O->>W: Invite a receptionist (email, role)
    W->>DB: invite_member(email, receptionist)
    Note over DB: Invitation with hashed token,<br/>domain event member.invited
    WK->>DB: Claim member.invited
    WK->>E: Invitation email, token in the URL fragment
```

**Decisions shown**
- **Auth and staff emails.** Email verification and password reset use Supabase Auth's mailer, configured to use the same SMTP provider. Every other email goes through the SmartClinic worker, so it can be localized and tracked.
- **Approval does not block setup.** Patients can only book once the platform approves the clinic (BR-P-02).
- **MFA is required** before the owner accepts the data processing agreement and before any platform action (BR-T-06).

---

## 3. Queue management — sequence diagram

```mermaid
sequenceDiagram
    autonumber
    actor P as Patient
    actor R as Receptionist
    participant W as Next.js server
    participant DB as Postgres (commands)
    participant RT as Supabase Realtime
    participant D as Doctor console
    participant WK as Worker
    participant SMS as SMS provider

    P->>R: Arrives at the front desk
    alt Has an appointment
        R->>W: Check in the appointment
        W->>DB: check_in_appointment(appointment, expected version)
    else Walk-in
        R->>W: Register walk-in (patient, doctor, service)
        W->>DB: register_walk_in(patient, doctor, service)
    end
    Note over DB: One transaction. Lock the doctor session (created if needed),<br/>appointment to checked_in, queue entry with gapless ticket<br/>and sort key per BR-Q-04, queue event, estimate recomputation,<br/>queue_version incremented, history, audit
    DB--)RT: Broadcast hint (session, queue_version) on private topics
    DB-->>W: Ticket number and estimate range
    W-->>R: Show ticket A-012, about 25 to 35 min
    RT--)D: Hint received
    D->>W: Refetch today's queue (RLS, own doctor only)

    opt Priority set by staff
        R->>W: Set priority with a reason (e.g. elderly)
        W->>DB: set_queue_priority(entry, 1, reason)
        Note over DB: Permission check, sort recomputed,<br/>event with actor and reason, audit
        DB--)RT: Broadcast hint
    end

    D->>W: Call next patient
    W->>DB: call_next(session)
    Note over DB: Pick lowest (priority desc, sort_key) in waiting,<br/>state called, call_count + 1, recompute estimates
    DB->>DB: Entries now within 2 positions emit queue.turn_approaching once
    DB--)RT: Broadcast hint

    D->>W: Start consultation
    W->>DB: start_consultation(entry)
    Note over DB: Queue in_consultation and appointment in_progress,<br/>at most one per session (BR-Q-03)
    DB--)RT: Broadcast hint

    opt Doctor reports a delay
        D->>W: Report a delay of 30 min
        W->>DB: report_doctor_delay(session, 30)
        Note over DB: Estimates shifted, domain event session.delay_reported
    end

    par Notifications in the background
        WK->>DB: Claim turn_approaching and delay events
        WK->>DB: Plan notifications (consent, channel, locale, idempotency key)
        WK->>DB: Re-check entry still waiting (BR-N-02)
        WK->>SMS: Send short neutral SMS
        SMS-->>WK: Accepted with message id
    and Overrun refresh every minute
        DB->>DB: pg_cron refreshes estimates for overrunning consultations
        DB--)RT: Broadcast hint if estimates changed
    end

    D->>W: Complete consultation
    W->>DB: complete_consultation(entry)
    Note over DB: Entry closed (completed), appointment completed,<br/>estimates recomputed, domain event consultation.completed
    DB--)RT: Broadcast hint
    R->>W: Create and issue invoice, record payment
```

**Concurrency notes**
- **Commands lock the `doctor_sessions` row (`SELECT … FOR UPDATE`) first.** Two receptionists checking in at the same moment are serialized and get consecutive tickets.
- **Commands that act on a specific appointment pass the `version` the user saw.** A mismatch returns `STALE_STATE`, and the UI refetches.
- **Realtime messages are hints** with no patient data. Each client refetches through RLS, so a missed hint only delays an update and the next hint or a 30-second poll fixes it.

---

## 4. Notification dispatch — sequence diagram

```mermaid
sequenceDiagram
    autonumber
    participant CR as pg_cron (every minute)
    participant NET as pg_net
    participant J as Jobs route /api/internal/jobs/dispatch
    participant DB as Postgres
    participant PR as Email or SMS provider
    participant WH as Webhook route /api/webhooks/provider

    CR->>NET: Schedule an HTTP POST with an HMAC signature
    NET->>J: POST, signed timestamp and body
    J->>J: Verify the signature, reject if older than 5 min
    J->>DB: Claim unprocessed domain_events (FOR UPDATE SKIP LOCKED)
    J->>DB: Planner inserts notifications (ON CONFLICT idempotency_key DO NOTHING)
    J->>DB: Mark events processed
    J->>DB: Claim due notifications with a lease (locked_until)
    loop Each claimed notification
        J->>DB: Re-read appointment or queue state, consent, address
        alt Still valid
            J->>PR: Send rendered template (locale, neutral content)
            PR-->>J: Accepted with provider id, or an error
            J->>DB: Attempt row, status sent or retry with backoff or failed
        else Stale, no consent or quiet hours
            J->>DB: Status skipped or rescheduled, with a reason
        end
    end
    PR->>WH: Delivery receipt (signed)
    WH->>DB: Status delivered or failed, matched by provider id (idempotent)
```

A crashed worker leaves leases that expire. The next run picks those notifications up again. Duplicate sends are prevented by the idempotency key, plus the check that status is still `processing` when the result is recorded.
