# EntertabCRM Backend

Next.js backend for authentication, CRM, automation, catalog, commercial operations, contact center, data integration, sales intelligence, analytics, and the business suite (Online Store, Marketing campaigns, HR & time tracking, Sites & landing pages).

## Repository layout

- `src/`: application and domain modules.
- `app/`: Next.js pages and API route handlers.
- `Script/`: database, seeding, testing, and operational scripts.
- `tests/`: executable tests and shared fixtures; module test packs live in `tests/modules/`.
- `docs/Logic/`: module specifications, decisions, and module `Agent.md` contracts.
- `prisma/`: database schema and migrations.

Read root `AGENTS.md` before working on a module. Jest discovers both `.spec.ts` and `.e2e-spec.ts` files under `tests/`, including preserved contract scenarios that still fail until wired to the implementation.

## Local development on Windows

The backend uses the project-local PostgreSQL 18 cluster under `.local-postgres/data-utf8`. The incomplete Windows service cluster at `D:\Applications\PostgreSql\data` is not modified. PostgreSQL binaries default to `D:\Applications\PostgreSql\bin`; set `POSTGRES_BIN` to use another installation.

Port 3000 belongs to the frontend. The backend always starts on [http://localhost:3001](http://localhost:3001).

```powershell
npm install
npm run db:setup
npm run dev
```

`npm run dev` runs the idempotent database setup automatically. Setup recovers a stopped cluster, verifies stale PID files before removal, snapshots data before recovery, creates the application database, deploys migrations, and seeds the admin role and permissions.

Database lifecycle commands:

```powershell
npm run db:setup
npm run db:start
npm run db:health
npm run db:stop
```

The readiness endpoint is `GET /api/v1/health/ready`. A database outage returns a sanitized `503 DATABASE_UNAVAILABLE` response instead of an unhandled error.

## Validation

```powershell
npm run typecheck
npm run prisma:validate
npm test
npm run test:endpoints
npm run test:endpoints:live
npm run test:all
```

- `test:endpoints` recreates `entertabcrm_test`, deploys migrations, and exercises every Next route handler directly with real persistence.
- `test:endpoints:live` builds and starts Next.js on port 3101, then runs the same endpoint scenarios over HTTP.
- `test:all` runs type checking, Prisma validation, the complete Jest suite, live HTTP endpoint coverage, and a final production build.

The endpoint audit discovers route files automatically, rejects missing coverage, and requires protected routes to be exercised using valid credentials.

Files use a private durable `FILE_OBJECT_ROOT` volume shared by every worker. Configure the scanner/processing provider and schedule the authenticated `upload-processing`, `upload-cleanup` and `file-object-garbage` jobs regularly. Permanent purge commits metadata removal and cleanup intents together; the garbage worker deletes bytes after the last Version reference is removed. Provider configuration, scheduler contracts and retention behavior are documented in [FILES.md](src/server/collab/files/FILES.md).

## Business suite (Online Store, Marketing, HR & Time, Sites)

Specifications: `docs/Logic/TrueCRM_Commerce_Marketing_HR_Sites_Codex_Pack`. Domain code: `src/server/commerce/suite`, `src/server/marketing`, `src/server/hr`, `src/server/sites`, shared kernel/providers in `src/server/suite`.

- Admin consoles: `/commerce`, `/marketing`, `/hr`, `/sites` (workspace sign-in; every action calls the documented REST contract).
- Public surfaces: storefront and customer portal at `/store/<slug>`; published sites at `/s/<path>` resolved by verified host (`?host=` for platform previews).
- Background work runs through `SuiteWorkers` (campaign schedules and delivery, ad audience sync, repeat-sale journeys, HR access revocation and anomaly detection, scheduled site releases).
- External providers use `env:NAME` secret references (see `.env.example`). Only deterministic SANDBOX adapters are exercised by tests; live SES/SMTP/Twilio/WhatsApp/Meta, Google Ads, TLS issuance and the AI gateway require staging credentials.
- Contract suites: `tests/modules/TrueCRM_Commerce_Marketing_HR_Sites_Codex_Pack`, bound to the application by `tests/support/truecrm-contract-adapter.ts` against the owned database `truecrm_suite_contract_test`.
