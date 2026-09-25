# Implementation progress — Automation Rules & Triggers + Products & Catalog

Living checklist so work can be resumed after an interruption. Update as phases complete.

## Repo facts (discovered in Phase 2)
- Backend = Next.js route handlers (`app/api/v1/**`) + service classes in `src/server/**` (NOT NestJS).
- Persistence = per-request `hydrateState()` -> in-memory `DbState` -> `persistState()` diff-upsert in one Prisma transaction
  (`src/server/response.ts`, `persistence.ts`). New collections are wired via `EXTRA_COLLECTIONS` in `persistence.ts` + `DbState` in `store.ts`.
  Rows restored by `store.atomicSync` are restored SHALLOWLY -> always replace nested arrays/objects, never mutate them in place.
- Prisma schema has NO relational FKs (by repo convention); constraints = unique/index + raw SQL (CHECKs, triggers, backfill) appended to the migration.
- Reused infra: `AccessService` (scopes), `AuditService`, `emitDomainEvent` outbox, `idempotencyRecords`, `applyQuery`/cursor helpers,
  `AppError`, `route()/routeWithMeta()`, `RealtimeHub`, Custom Fields engine (`fields/*`, Product properties = entityType `PRODUCT`), `FilePort`.
- Frontend repo is a SEPARATE repo: `D:\Entertab\crm-frontend` (Next 16 / React 19 / Vitest; read `node_modules/next/dist/docs` first, see its AGENTS.md).
- Baseline before this work: 26 suites / 287 tests green (`npm test`, ~165s, needs local Postgres + `entertabcrm_test`).
- Gotcha: do not use backticks inside bash heredocs in this harness (use the Write tool).

## Phases
- [x] 1. Spec pack read fully (Agent.md, Decision-Register, all module/shared/test specs)
- [x] 2. Repository discovery
- [x] 3. Prisma schema + migration `20260924140000_automation_products_catalog` (tables, CHECKs, revision-immutability triggers, outbox backfill), client regenerated
- [x] 4. Shared wiring: `DbState`/store/persistence, permission catalog (+82 keys, seed config), `OutboxEvent.automationProcessedAt/automationDepth`
- [x] 5. Catalog backend (`src/server/catalog/*`)
- [x] 6. Catalog routes + OpenAPI
- [x] 7. Automation backend (`src/server/automation/*`)
- [x] 8. Automation routes + OpenAPI + internal job endpoint
- [x] 9. Backend tests (domain + HTTP) incl. contract-test conversion; api-endpoints coverage
- [x] 10. Frontend (`D:\Entertab\crm-frontend`): Automation + Catalog
- [x] 11. Regression run, self-review, fixes, final report

## How to run
- `npm test` (backend, needs local Postgres: `D:\Applications\PostgreSql\bin\pg_ctl -D .local-postgres\data-utf8 start`)
- `npm run typecheck`
- `npx prisma generate` after schema edits

## Status log
- Catalog backend + tests (tests/catalog-products.spec.ts 18, tests/catalog-product-rows.spec.ts 12) green.
- Automation backend (src/server/automation/*) + tests/automation-engine.spec.ts (30) green. Routes generated (catalog 34, automation 26 + custom trigger + manual execute + internal job cases).
- DONE: extension/SSRF/webhook tests, OpenAPI entries, HTTP tests (api-endpoints coverage!), full regression, frontend (D:\Entertab\crm-frontend), review, final report.

## Final status (2026-09-24)
- Backend: `npm run typecheck` clean; `npm test` = 30 suites / 372 tests green.
- Frontend (`D:\Entertab\crm-frontend`): `tsc --noEmit`, `eslint`, `vitest run` (6 files / 70 tests), `next build` all green.
- Known gaps / follow-ups: see the final report (pre-existing `softDeleteDeal` has no delete-permission check; DB is hydrated whole per request so
  execution/log tables need retention/archival before production scale; migration is NOT applied to any non-test database).
