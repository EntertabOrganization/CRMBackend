# EntertabCRM Backend

Auth/identity module implementation based on the provided `Auth_Module` specification pack.

## What is included

- NestJS modular backend using Fastify.
- Auth, Workspace, User, Authorization, Department, Partner and Audit HTTP APIs under `/api/v1`.
- Prisma PostgreSQL schema and initial SQL migration.
- Contract-style domain tests and HTTP E2E tests.
- Deterministic local mail/OAuth fakes for automated tests.

## Local commands

```bash
npm install
npm run build
npm test
npm run test:auth
npm run test:e2e
npm audit
```

Prisma validation:

```bash
DATABASE_URL="postgresql://entertabcrm:entertabcrm@localhost:5432/entertabcrm_auth" npx prisma validate --schema prisma/schema.prisma
DATABASE_URL="postgresql://entertabcrm:entertabcrm@localhost:5432/entertabcrm_auth" npx prisma generate --schema prisma/schema.prisma
```

PostgreSQL for future DB integration:

```bash
docker compose up -d postgres
npx prisma migrate deploy --schema prisma/schema.prisma
```

The current automated suite runs against the in-memory domain service. Live PostgreSQL integration requires Docker/PostgreSQL availability, which was not present in this workspace environment.
