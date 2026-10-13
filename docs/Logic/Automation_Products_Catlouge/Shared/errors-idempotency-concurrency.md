# Errors, Idempotency & Concurrency

## Stable errors

Use machine-readable codes with safe detail objects. Field/config validation should report all safe errors in one response when possible.

Do not leak SQL constraint names as public API contracts.

## HTTP guidance

Adapt to repository conventions, but generally:

- 400 invalid business input/configuration;
- 401 unauthenticated;
- 403 permission denied;
- 404 inaccessible/not found according to anti-disclosure policy;
- 409 optimistic version/uniqueness/state conflict;
- 422 if repository uses it for semantic validation;
- 429 rate limit;
- 5xx unexpected/transient platform/provider failures.

## Idempotency

### Automation

Require internal idempotency/dedupe for:

- event-to-execution creation;
- scheduled job claiming/execution;
- Action side effects;
- external custom trigger ingestion.

Manual execute API should support request idempotency key if repeated submission can duplicate business effects.

### Catalog

Idempotency is especially useful for:

- external/import Product creation;
- Variant matrix generation;
- bulk price upsert;
- Product Row replacement if called by retrying clients/integrations.

Normal PATCH uses optimistic concurrency rather than treating every edit as an idempotent replay.

## Optimistic concurrency

Use `version` or repository-equivalent ETag/version contract for:

- Rule Draft edits/publish;
- Catalog/Product/Price Type configuration where concurrent admins can overwrite each other;
- Product Row set if owner supports concurrent editing.

Stale write returns conflict with latest version metadata when safe.

## Database uniqueness conflicts

Translate:

- SKU unique violation -> `PRODUCT_SKU_CONFLICT`;
- base/default unique violation -> clear conflict/retry;
- Rule revision number conflict -> internal retry or version conflict;
- Variant combination unique violation -> `VARIANT_COMBINATION_CONFLICT`.

## Locking

Use row locking only for short critical sections such as atomically switching default/base records or posting a coordinated bulk mutation. Do not hold DB transaction open around network/provider calls.
