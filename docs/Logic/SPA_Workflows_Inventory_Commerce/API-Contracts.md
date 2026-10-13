# API Execution Contract — TrueCRM Pack 2

This document is normative alongside `Agent.md`; every operation in `api-operations.json` and `Controller-Inventory.md` implements these conventions.

## Authentication and response envelopes

- `/api/v1/...` authenticated endpoints require active Workspace membership (or scoped delegated service principal) plus the exact action permission declared per operation. Workspaces are resolved from authenticated context, never request bodies.
- `/api/v1/storefront/:storeSlug/...` is public only for **published Store context** and returns no admin schema, warehouse balances, cost or CRM private data. Cart/Checkout routes additionally require opaque bearer tokens scoped to the Store; `CUSTOMER_SESSION` requires authenticated commerce-customer context without workspace membership.
- `PROVIDER_SIGNED` requires raw-body provider signature verification, source mapping, replay/idempotency and bounded requests. `PUBLIC_SCOPED` on workflow callbacks means expiring, single-purpose signed token + correlation + rate limit.
- Exactly one success envelope: `{ "success": true, "data": <resource|array>, "meta": null }`; page list: `{ "success": true, "data": [], "meta": {"page":1,"limit":20,"total":0,"totalPages":0} }`.
- `202 Accepted` actions return `{ "success":true, "data":{"jobId":"<uuid>","status":"QUEUED"},"meta":null }` except Workflow start returns `executionId` with `QUEUED`. Poll endpoints are documented in their modules or shared Job controller (do not duplicate Job backend).
- Errors: `{ "success":false,"error":{"code":"RESOURCE_VERSION_CONFLICT","message":"...","details":null},"requestId":"..." }`.
- Standard mapping: `400 INVALID_ARGUMENT` (shape/type), `401 UNAUTHENTICATED`, `403 PERMISSION_DENIED`, `404 RESOURCE_NOT_FOUND` for absent or inaccessible private resource IDs, `409 RESOURCE_VERSION_CONFLICT | INVALID_STATE | IDEMPOTENCY_KEY_REUSED`, `413 PAYLOAD_TOO_LARGE`, `422 DOMAIN_VALIDATION_FAILED`, `429 RATE_LIMITED`, `502 PROVIDER_FAILURE` only when synchronously necessary. Module-specific codes in each spec refine the `error.code`.
- Use `201` for new persisted resource; `200` for normal success; `202` queued; `204` successful delete with no response body when repository convention is established, otherwise `200` envelope. Do not invent hidden server state for 202.

## Validation / DTO semantics

Each endpoint's `Request / Query` column lists accepted caller fields. Route identifiers are server-resolved UUIDs unless `:storeSlug`, `:cartToken`, `:token`, `:providerCode`, or node keys. UUIDs must parse; references must belong to same authorized Workspace. A field named `Idempotency-Key` denotes required HTTP header rather than JSON body. `expectedVersion` denotes mandatory numeric optimistic concurrency on mutable aggregate. Unknown or privileged keys, including `workspaceId`, `createdByUserId`, payment state, or server totals, are forbidden unless explicitly granted in the endpoint contract. `PUT` replaces all editable state; `PATCH` only supplied keys; actions are `POST` commands, not status patches.

- String names trim whitespace, reject empty input, enforce business code regex `^[A-Z][A-Z0-9_]{1,63}$` when labeled code and max 160 Unicode characters for names unless domain spec says otherwise.
- `NUMERIC` uses Decimal values; quantities positive on requested movement/reservation/line except reversal deltas; monetary amounts nonnegative and currency ISO 4217 uppercase, using repository Money type/decimal implementation and deterministic rounding (never JS floating-point).
- Stored real timestamps are `timestamptz`; scheduled triggers preserve explicit IANA timezone; reject invalid date/time/zone values and ensure start before end.
- Generic page defaults page=1, limit=20, max=100; `sortBy`, filter and search accept module-whitelisted fields only; queries must not expose hidden data via filter/sort.
- Retry-sensitive POST operations require `Idempotency-Key` (opaque, 8..128 chars, unique per workspace + actor/client + route/command). Same key and same normalized request hash returns same committed outcome; same key with different hash returns 409 `IDEMPOTENCY_KEY_REUSED` and no effect. Hold result at least 24h or more per domain/provider; for financial/stock provider IDs retain durable unique constraints for full business retention.
- Mutations with `expectedVersion` check current aggregate numeric version in transactional update, increment once on success, return 409 on mismatch. No updates allowed without current version where required.

## Authorization, events and transactions

Every operation evaluates feature entitlement + active workspace principal + action + scope (OWN, DEPARTMENT, DEPARTMENT_TREE, TEAM, ALL) + relevant domain rules. Storefront/public tokens confer only their single scope, never employee privileges. No cross-tenant relation.

Commands that create business effects transactionally persist: authoritative domain rows, immutable history/evidence, an outbox event, and critical audit as appropriate. Worker/provider effects happen after commit and are retry-safe. Cross-domain services are called via owning module/application interfaces; no direct cross-domain table mutation.

Successful outbox events include `eventId`, `eventType`, `workspaceId`, `aggregateType`, `aggregateId`, `occurredAt`, `schemaVersion`, `correlationId`, `actorType`, `actorId`, `payload` with least necessary data. Shared Integration webhook service owns HMAC signing/delivery/retention/retry/dead-letter. Notification/Analytics/Search/Realtime consumers dedupe on eventId. Domain E2E tests validate no event after rollback and one event after idempotent replay.

## Endpoint success and error mapping

For every operation in a spec:
1. Parse the **Request / Query** field into an explicit DTO and documented OpenAPI schema; there must not be a generic unvalidated JSON passthrough.
2. Resolve the declared `Permission` using the shared policy engine; admin/owner alone is not a blanket bypass.
3. Perform the **Outcome / Effects** as one complete vertical slice with audit/outbox where declared.
4. Use module-specific errors from the spec and the stable common envelope; never leak SQL, credential secret, provider raw body, sensitive logging variables, or stock costs through storefront.
5. Test 2xx, input validation, 401/403, other-workspace IDOR rejection, state guards, retry/concurrency and persisted side effects. Public/provider routes replace the normal 401 tests with token/signature/abuse tests.
