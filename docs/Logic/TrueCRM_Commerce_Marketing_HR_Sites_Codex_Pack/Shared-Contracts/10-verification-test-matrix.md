# Verification matrix and test philosophy

Every module spec has a matching TypeScript contract test file and module E2E suite. **Tests fail closed** until the coding agent connects real services, database and provider fakes. A passing `true` from a mock scenario without requests/assertions is forbidden. See `Testing/README.md`.

| Class | Minimum evidence |
|---|---|
| Domain service/unit | DTO rule, policy version, state transition, invalid values, decimals/timezones |
| API integration | Real NestJS request, auth membership/field checks, Postgres rows, outbox/audit transaction |
| Tenant isolation | Two workspaces and foreign resource identifiers, including public tokens |
| Concurrency/idempotency | Parallel checkout/stock, delivery workers, leave balance holds, site releases |
| Provider contract | Signature tamper/replay, provider timeout-after-accept, partial failure, retry/dead letter |
| Privacy | Suppressed recipient never sent; HR sensitive fields masked; consent-required script not loaded |
| Business lifecycle | partial fulfillment, return/refund, audience freeze, timesheet locking, rollback |
| Recovery | worker restart, provider reconciliation, legal hold retention, entitlements downgrade |
| Frontend | role-specific navigation, forms, progress/error, responsiveness/RTL, accessibility |

Never mark tests skipped/todo to obtain green build. Tests may adapt import paths, mocks, fixtures and runner to repository architecture but must retain intended assertions. Evidence includes commands, outcomes, commit hash/diff, migrations and verified external staging checks. External provider fakes are not equivalent to a live provider smoke test.
