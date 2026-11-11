# SmartClinic — System Architecture

| | |
| --- | --- |
| Status | **Draft for review** (system modeling phase) |
| Date | 2026-11-10 |
| Related | [PHASE_0_REPOSITORY_AUDIT.md](PHASE_0_REPOSITORY_AUDIT.md) §8 · [SECURITY_MODEL.md](SECURITY_MODEL.md) · [API_SPECIFICATION.md](API_SPECIFICATION.md) |

These diagrams follow the C4 levels (context → containers → components) and are drawn as Mermaid flowcharts.

---

## 1. System context

```mermaid
flowchart LR
    patient["Patient<br/>mobile browser, French or Arabic"]
    reception["Receptionist<br/>desktop at the front desk"]
    doctor["Doctor<br/>desktop or tablet"]
    admin["Clinic owner / admin / accountant<br/>desktop"]
    platform["Platform admin<br/>SmartClinic team"]
    display["Waiting-room screen<br/>TV browser, no login"]

    sc["SmartClinic<br/>multi-tenant clinic management SaaS<br/>(Next.js on Vercel + Supabase)"]

    email["Email provider<br/>transactional SMTP or API"]
    sms["SMS provider<br/>OTP, reminders, queue alerts"]
    wa["WhatsApp Business API<br/>later, after Meta verification"]
    captcha["CAPTCHA service<br/>Turnstile or hCaptcha"]

    patient -->|"books, cancels, reschedules, follows queue"| sc
    reception -->|"registers patients, books, checks in, manages queue, takes payments"| sc
    doctor -->|"sees own day, calls patients, reports delays"| sc
    admin -->|"configures clinic, staff, services, billing, reports"| sc
    platform -->|"approves clinics, manages plans and subscriptions"| sc
    display -->|"polls called ticket numbers"| sc

    sc -->|"verification, invitations, confirmations"| email
    sc -->|"OTP and short neutral messages"| sms
    sc -.->|"future channel"| wa
    sc -->|"verifies sign-up and OTP requests"| captcha
    sms -->|"delivery receipts"| sc
    email -->|"delivery events"| sc

    classDef person fill:#e0f2fe,stroke:#0369a1,color:#0c4a6e
    classDef system fill:#10283b,stroke:#10283b,color:#ffffff
    classDef external fill:#f1f5f9,stroke:#64748b,color:#0f172a
    classDef future fill:#ffffff,stroke:#94a3b8,color:#64748b,stroke-dasharray: 4 3
    class patient,reception,doctor,admin,platform,display person
    class sc system
    class email,sms,captcha external
    class wa future
```

**Outside the system boundary on purpose:** insurers (AMO/CNSS/CNOPS), laboratories, electronic medical records, payment gateways and any AI service. None of them is in the MVP.

---

## 2. Containers

```mermaid
flowchart TB
    subgraph clients["Clients"]
        browser["Web browser<br/>React client components<br/>workspace UI, patient portal"]
        tv["Display screen browser<br/>token URL, polling"]
    end

    subgraph vercel["Vercel (EU region, co-located with the database)"]
        next["Next.js application<br/>React Server Components, Server Actions,<br/>Route Handlers, proxy (headers, locale, session refresh)"]
    end

    subgraph supa["Supabase project (EU region)"]
        auth["Supabase Auth<br/>email and password, phone OTP, TOTP MFA, JWT"]
        rest["Data API (PostgREST)<br/>exposes public schema only"]
        rt["Realtime<br/>private broadcast channels"]
        storage["Storage<br/>private buckets, signed URLs"]
        subgraph pg["PostgreSQL"]
            tables["Tables + RLS<br/>public schema"]
            cmds["Command and query functions<br/>public schema, permission checked"]
            priv["private schema<br/>RLS helpers, rate limits, job log"]
            cron["pg_cron + pg_net<br/>scheduled jobs"]
        end
    end

    ext["Email / SMS providers"]

    browser -->|"HTTPS: pages, Server Actions"| next
    tv -->|"HTTPS: GET display snapshot"| next
    browser -->|"WebSocket: subscribe with user JWT"| rt
    next -->|"user-scoped client (JWT): queries and commands"| rest
    next -->|"auth calls, session cookies"| auth
    next -->|"signed URL creation"| storage
    next -->|"privileged client in server-only code: jobs, webhooks, platform"| rest
    rest --> tables
    rest --> cmds
    cmds --> tables
    cmds --> priv
    tables -->|"triggers: realtime.send hints"| rt
    cron -->|"HTTP POST, HMAC signed"| next
    next -->|"send messages"| ext
    ext -->|"webhooks, signed"| next
    auth -->|"Send SMS hook or built-in provider"| ext
```

| Container | Technology | Responsibility | Notes |
| --- | --- | --- | --- |
| Next.js application | Next.js App Router, React, TypeScript strict, Tailwind, shadcn/ui, next-intl | All user interfaces; application services; jobs and webhook endpoints | One deployment, five workspaces as route groups |
| Supabase Auth | GoTrue | Identities, sessions, MFA, OTP | Staff: email + password (+ TOTP). Patients: phone OTP |
| Data API | PostgREST | The only way into PostgreSQL from the application | Reachable directly by any signed-in user with their JWT, so **RLS and command checks must assume hostile callers** |
| PostgreSQL | Postgres 15+ (Supabase) | Data, invariants, RLS, commands, triggers, jobs | The real security and consistency boundary |
| Realtime | Supabase Realtime | Staff screen updates | Hints only, private channels |
| Storage | Supabase Storage | Clinic logos, invoice and receipt PDFs | No patient documents in the MVP |

---

## 3. Components — Next.js application

```mermaid
flowchart LR
    subgraph ui["app/ route groups (presentation)"]
        pub["(public)<br/>booking pages"]
        portal["(patient)<br/>portal"]
        ws["(workspace)<br/>admin, reception, doctor"]
        plat["(platform)<br/>super admin"]
        api["api/<br/>jobs, webhooks, display, files"]
    end

    subgraph kernel["shared kernel"]
        sess["Session and identity<br/>verified claims, aal level"]
        tenant["Tenant resolver<br/>slug to clinic, membership, role"]
        guard["Permission guard<br/>can(permission, scope)"]
        i18n["i18n and formatting<br/>locale, direction, Casablanca time, MAD"]
        err["Error mapper<br/>Postgres codes to domain codes"]
        clients["Supabase clients<br/>user-scoped, privileged (server-only)"]
    end

    subgraph modules["modules (application + infrastructure)"]
        m_iam["identity-access"]
        m_ten["tenancy"]
        m_cat["practice-catalog"]
        m_sch["scheduling"]
        m_pat["patients"]
        m_app["appointments"]
        m_flow["patient-flow"]
        m_com["communications"]
        m_bil["billing"]
        m_ana["analytics"]
        m_sub["subscriptions"]
        m_cmp["compliance"]
    end

    pub --> m_sch
    pub --> m_app
    portal --> m_app
    portal --> m_pat
    portal --> m_flow
    ws --> modules
    plat --> m_ten
    plat --> m_sub
    plat --> m_ana
    api --> m_com
    api --> m_flow
    api --> m_bil

    modules --> kernel
    m_app -->|"public interface only"| m_sch
    m_flow -->|"public interface only"| m_app
    m_bil -->|"public interface only"| m_app
```

**Module rules** (enforced by ESLint `no-restricted-imports`)
- A module imports another module only through its `index.ts`.
- `domain/` has no I/O imports.
- The privileged Supabase client may be imported only from `app/api/**` jobs and webhooks and from the platform module's infrastructure.
- Components in `app/` never import `infrastructure/` directly. They call Server Actions exported by modules.

### 3.1 Inside one module

```mermaid
flowchart LR
    action["Server Action or Route Handler<br/>parse input with Zod, resolve tenant"]
    svc["Application service<br/>authorize, orchestrate, map errors"]
    dom["Domain<br/>pure types, transition metadata, formatting rules"]
    infra["Infrastructure<br/>typed Supabase queries and RPC calls"]
    db[("PostgreSQL<br/>RLS + command functions")]

    action --> svc
    svc --> dom
    svc --> infra
    infra --> db
```

---

## 4. Components — PostgreSQL

```mermaid
flowchart TB
    subgraph public_schema["public schema (exposed through the Data API)"]
        t_managed["Managed tables<br/>services, doctors, schedules, time off,<br/>patients, closures, settings<br/>DML allowed under RLS"]
        t_command["Command tables<br/>appointments, queue, sessions, invoices,<br/>payments, members, invitations, consents<br/>SELECT under RLS, no direct DML"]
        f_cmd["Command functions (SECURITY DEFINER)<br/>book_appointment, check_in_appointment,<br/>call_next, issue_invoice, record_payment ..."]
        f_qry["Query functions (SECURITY INVOKER)<br/>get_available_slots, analytics KPIs"]
        f_portal["Portal functions (SECURITY DEFINER)<br/>patient-scoped reads and commands"]
    end

    subgraph private_schema["private schema (not exposed)"]
        h_auth["RLS helpers<br/>is_member, has_permission,<br/>current_doctor_ids, require_aal2"]
        h_num["Numbering<br/>next_counter_value"]
        h_rl["Rate limiter"]
        h_est["SmartFlow estimator<br/>recompute_estimates"]
    end

    subgraph triggers["Triggers"]
        tr_hist["History writers<br/>appointment_history, queue_events"]
        tr_audit["Audit writer<br/>audit_logs"]
        tr_rt["Realtime broadcaster<br/>realtime.send hints"]
        tr_inv["Invariant guards<br/>tenant immutability, last owner,<br/>invoice immutability, status coherence"]
    end

    subgraph jobs["pg_cron jobs"]
        j_dispatch["every minute: call the jobs route"]
        j_est["every minute: refresh overrunning estimates"]
        j_exp["every 5 minutes: expire pending appointments past start"]
        j_stats["nightly: rebuild consultation_duration_stats"]
        j_close["nightly: close sessions, end-of-day list"]
        j_ret["nightly: retention purges (once counsel defines periods)"]
    end

    f_cmd --> h_auth
    f_cmd --> h_num
    f_cmd --> h_est
    f_cmd --> t_command
    f_portal --> h_auth
    f_portal --> t_command
    f_qry --> t_managed
    f_qry --> t_command
    t_managed --> tr_audit
    t_command --> tr_hist
    t_command --> tr_audit
    t_command --> tr_rt
    t_command --> tr_inv
    t_managed --> tr_inv
    j_est --> h_est
```

---

## 5. Key runtime decisions

### 5.1 Reads and writes
- **Reads:** Server Components query through the user-scoped client, so RLS applies. Pagination is keyset-based. Large lists never use `count=exact`.
- **Writes:**
  - managed tables: direct DML under RLS;
  - command tables: command functions only.
  - Both are always called from Server Actions, never from client components.
- **Concurrency:**
  - optimistic, through `version` columns, for user edits;
  - pessimistic, with row locks inside commands, for sessions, counters and invoices.

### 5.2 Realtime
- **Staff screens** subscribe to private broadcast topics:
  - `clinic:<clinic_id>:board:<date>`, the reception day board;
  - `clinic:<clinic_id>:doctor:<doctor_id>:<date>`, the doctor console.
- Payload: `{ "entity": "queue", "session_id": …, "version": n }`. Clients refetch when the version increases. They also poll every 30 s as a safety net.
- **Patient portal** polls its own entry's position and estimate every 30 s through a portal function. It has no realtime subscription in the MVP, so there are no patient-facing channels to secure.
- **Display screens** poll `GET /api/display/<token>` every 10 s. The response is ticket numbers only.

### 5.3 Background jobs
- **pg_cron schedules everything.** For work that needs provider APIs, `pg_net` POSTs a signed request to `/api/internal/jobs/*` on the Next.js app.
- This needs no Vercel cron (plan-limited) and keeps all job code in the same TypeScript modules.
- Each job run handles a bounded batch (at most 100 items) to stay within function time limits.
- Pure-SQL jobs (estimate refresh, pending expiry, stats, session close) run directly in PostgreSQL.

### 5.4 Estimator placement
The v1 estimator runs **in PostgreSQL** (`private.recompute_estimates`), inside every queue command. Estimates are therefore always consistent with the queue state that the same transaction commits. This supersedes audit §8.3, which placed the estimator in TypeScript (decision MD-13).

### 5.5 Environments

| Environment | Supabase | Vercel | Data |
| --- | --- | --- | --- |
| Local | Supabase CLI stack (`supabase start -x` with unused services excluded) | `next dev` | Seed fixtures only |
| Staging | Separate project, same region as prod | Preview / staging deployment | Synthetic data only |
| Production | Separate project, paid tier + PITR | Production deployment, Pro plan | Real data only after CNDP clearance |

Migrations reach staging and production only through CI, after review. The service-role key exists only in Vercel's server environment and in CI secrets.
