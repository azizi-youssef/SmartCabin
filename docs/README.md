# SmartCabin documentation

| Document | Content | Status |
| --- | --- | --- |
| [PHASE_0_REPOSITORY_AUDIT.md](PHASE_0_REPOSITORY_AUDIT.md) | Initial audit, stack decision D-0, risks R1–R14 | Delivered (2026-11-10) |
| [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) | Phases, slices, prioritized backlog | Maintained |
| [MODELING_REVIEW.md](MODELING_REVIEW.md) | **Start here for review:** decisions MD-01…24, inconsistencies, added entities, risks | Under review |
| [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) | Context, containers, components, runtime decisions | Under review |
| [DOMAIN_MODEL.md](DOMAIN_MODEL.md) | Bounded contexts, aggregates, events, UML classes, entity catalog | Under review |
| [DATABASE_ERD.md](DATABASE_ERD.md) | Overview ERD + one ERD per context, enum types | Under review |
| [BUSINESS_RULES.md](BUSINESS_RULES.md) | State machines, booking, queue, billing and notification rules, KPI definitions | Under review |
| [USER_WORKFLOWS.md](USER_WORKFLOWS.md) | Patient journey, onboarding, queue, notification dispatch | Under review |
| [RBAC_PERMISSION_MATRIX.md](RBAC_PERMISSION_MATRIX.md) | Principals, permissions × roles, MFA, enforcement points | Under review |
| [SECURITY_MODEL.md](SECURITY_MODEL.md) | Tenant isolation, RLS policies, threats, test matrix | Under review |
| [API_SPECIFICATION.md](API_SPECIFICATION.md) | API surfaces, boundaries per context, error contract | Under review |
| [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) | Migrations, constraints, RLS policies, commands | Written, not yet tested |
| [UI_UX_GUIDELINES.md](UI_UX_GUIDELINES.md) | Design system: tokens, typography, components, patterns, RTL, accessibility | Implemented |
| [CHANGELOG.md](CHANGELOG.md) | Changes per phase, including what is not yet verified | Maintained |

Diagrams are written in Mermaid. They render on GitHub, in VS Code (Markdown Preview Mermaid Support extension) and on mermaid.live.

Still to come (master specification §18): PRODUCT_REQUIREMENTS, DATABASE_SCHEMA (Phase 3), UI_UX_GUIDELINES and TESTING_STRATEGY (Phase 4), DEPLOYMENT_GUIDE (Phase 8), CHANGELOG (first commit of code).
