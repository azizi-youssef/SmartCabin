# SmartClinic

Multi-tenant clinic management SaaS for independent doctors and private clinics in Nador, Morocco (French and Arabic).
It is administrative software only: no diagnosis, triage or medical recommendations.

> **Status:**
> - Database foundation (Phase 3): written, **not yet run against a database**.
> - Design system and workspace shells (Phase 4): implemented.
>
> See [docs/DEVELOPMENT_ROADMAP.md](docs/DEVELOPMENT_ROADMAP.md) and [docs/CHANGELOG.md](docs/CHANGELOG.md).

## Repository

| Path | Contents |
| --- | --- |
| `src/app/[locale]/` | Pages: sign-in, MFA, clinic workspaces (`/w/[clinicSlug]`), patient portal (`/me`), platform (`/platform`) |
| `src/modules/` | Business modules: data access (RLS), Server Actions, module UI |
| `src/shared/ui/` | Design system components. See [docs/UI_UX_GUIDELINES.md](docs/UI_UX_GUIDELINES.md) |
| `src/styles/globals.css` | Design tokens (CSS variables → Tailwind theme) |
| `messages/` | French and Arabic dictionaries |
| `supabase/migrations/` | Version-controlled SQL migrations (forward-only, additive) |
| `supabase/seed.sql` | Synthetic local development data. Never real patient data |
| `tests/db/` | Database integration tests: RLS, tenant isolation, booking rules, concurrency |
| `docs/` | Requirements, architecture, domain model, security, design system. Start with [docs/README.md](docs/README.md) |

## Prerequisites

- Node.js 22, pnpm 12
- Docker Desktop (local Supabase)

## Getting started

```bash
pnpm install
pnpm stack:start          # local Supabase (Postgres, Auth, API) — needs Docker
pnpm db:reset             # migrations + development seed (local only)
pnpm stack:status         # copy the API URL and publishable key into .env.local (see .env.example)
pnpm dev                  # http://localhost:3000
```

Without a configured backend, the app still runs and shows explicit "service unavailable" states (never sample data).
The component gallery is at `/fr/design-system` (development only).
Local accounts and their password are documented at the top of `supabase/seed.sql`. They are local-only values.

## Quality checks

```bash
pnpm typecheck
pnpm lint
pnpm test        # unit and component tests
pnpm test:db     # database integration tests (local stack running)
pnpm build
```

## Security notes

- The web app never uses a service-role key; there is none in the codebase.
- Lint forbids privileged clients in UI code.
- Tenant isolation is enforced in PostgreSQL by RLS, composite foreign keys and guarded commands. Hiding things in the frontend is not a security control. See [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md).
- No real patient data in any environment before the CNDP (Law 09-08) clearance.
