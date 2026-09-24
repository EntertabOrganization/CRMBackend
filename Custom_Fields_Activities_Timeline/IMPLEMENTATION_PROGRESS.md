# Implementation progress (Custom & Required Fields + Activities & Timeline)

Living checklist so work can be resumed after an interruption. Update as phases complete.

## Repo facts (discovered in Phase 1)
- Backend = Next.js route handlers (`app/api/v1/**`) + service classes in `src/server/**`, NOT NestJS.
- Persistence = per-request `hydrateState()` -> in-memory `DbState` -> `persistState()` diff-upsert in one Prisma transaction
  (`src/server/response.ts`, `persistence.ts`). New tables are wired into `DbState` (store.ts) and `COLLECTIONS`/hydrate (persistence.ts).
- Reused shared infra: `AuditService`, `outboxEvents`, `idempotencyRecords`, `applyQuery`, permission catalog + scopes,
  `AppError` helpers, `route()`/`routeWithMeta()`, department tree.
- Frontend repo is `D:\Entertab\crm-frontend` (Next 16 — read `node_modules/next/dist/docs` first; only landing/login/register pages,
  no API client / test runner / shell yet).

## Phases
- [x] 1. Spec pack read fully, repo discovery
- [x] 2. Prisma schema + additive migration `20260924090000_crm_custom_fields_activities_timeline` (applied to the local dev DB)
- [x] 3. Shared wiring: DbState/persistence (incl. delete-before-upsert for natural-unique collections), permissions (+seed), events (outbox envelope), realtime hub, access service, request mutex
- [x] 4. Custom Fields engine (`src/server/fields/*`): types/registry, definitions, options, values, permissions, schema, dependencies, type migration
- [x] 5. Required Fields (rules + safe declarative evaluator) + CRM integration (create / PATCH / stage transition / lead conversion)
- [x] 6. Activities (`src/server/activities/*`): types, core, bindings, participants, communications, reminders, lifecycle, bulk, overdue, adapters (Calendar/Tasks ports + fakes), provider ingest
- [x] 7. Timeline: outbox projector, query/filters/grouping, comments (files/mentions/edit/soft-delete), rebuild, realtime (SSE)
- [x] 8. API routes (44 generated + record detail/PATCH routes + realtime + jobs) + OpenAPI (`openapi-extensions.ts`) + per-user rate limits
- [x] 9. Backend tests (domain + HTTP/Postgres): see `tests/*.spec.ts` (custom-fields, required-fields, activities, activity-bindings-reminders, activity-adapters, timeline, api-endpoints)
- [x] 10. Frontend (`D:\Entertab\crm-frontend`): API client, session/login, shell (+ workspace creation), Settings (Custom Fields incl. options/dependencies/type migration, Required Fields with nested condition builder, Activity Types), CRM record pages (custom fields, Activities, Timeline), Global Activities (List + Deadline Board, bulk), Vitest suites (34 tests)
- [x] 11. Review pass (live smoke against the running backend found and fixed 4 issues, see final report) + final report

## How to run
- `npm test` (backend, needs local Postgres: `D:\Applications\PostgreSql\bin\pg_ctl -D .local-postgres\data-utf8 start`)
- `npm run typecheck`
- Schedulers call `POST /api/v1/internal/crm/jobs/{overdue|reminders|timeline-project|timeline-rebuild}` with header `x-internal-job-token` (env `INTERNAL_JOB_TOKEN`).
