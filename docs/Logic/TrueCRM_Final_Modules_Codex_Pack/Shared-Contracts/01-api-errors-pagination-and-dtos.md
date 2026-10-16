# API, DTO, lists and errors

All module authenticated controllers under `/api/v1`. Public endpoints are explicitly prefixed `/api/v1/public` or rendered host routes, and internal commands are never internet-exposed. Reuse repository patterns when they meet these semantics.

## Response shapes

Successful command `{ "success": true, "data": {"id":"uuid","status":"...","version":1}, "meta": null }`; list `{ "success":true,"data":[],"meta":{"page":1,"limit":20,"total":0,"totalPages":0}}`; error `{ "success": false, "error": { "code": "PERMISSION_DENIED", "message": "Not authorized", "details": null}, "requestId": "uuid" }`. No raw stack trace, provider keys or private title in errors.

## Request schemas

- `POST` creates or runs a command; `PUT` replaces all editable fields; `PATCH` updates only supplied values. `expectedVersion` or `If-Match` on concurrent edits. `Idempotency-Key` (UUID/high-entropy string, scope and request hash persisted) required for paid/financial actions and provisioning.
- Common `GET` query: `page` positive integer 1, default 1; `limit` 1–100 default 20; `search` up to 500 chars, allowed `sortBy`/`sortOrder` per entity. Structured filters use `eq,neq,in,notIn,contains,startsWith,endsWith,gt,gte,lt,lte,isNull` only where a module explicitly exposes the field. Never client SQL or ORM paths.
- Reject client-supplied `workspaceId`, `partnerId` authority, paid flag, audit actor, payout status, secret fields, createdBy unless an explicit privileged service command verifies them. IDs are UUID and cross-tenant resource references return a leak-safe error.

## Stable status mapping

| HTTP | Code | Meaning |
|---|---|---|
| 400 | VALIDATION_FAILED | Malformed/unknown fields, invalid ranges, filter syntax |
| 401 | UNAUTHENTICATED | No valid principal/session |
| 403 | PERMISSION_DENIED | Authenticated but unauthorized scope/action |
| 404 | NOT_FOUND | Missing or hidden record in public/tenant-scoped views |
| 409 | VERSION_CONFLICT | Optimistic concurrency loses; no mutation |
| 409 | INVALID_STATE_TRANSITION | Source state disallows target |
| 409 | IDEMPOTENCY_CONFLICT | Same key, changed canonical request |
| 422 | BUSINESS_RULE_VIOLATION | Consent, approval, tax, risk or lifecycle violation |
| 422 | INSUFFICIENT_QUOTA | Allowable balance or entitlement insufficient |
| 429 | RATE_LIMITED | Retry-After according to policy |
| 502 | PROVIDER_UNAVAILABLE | Provider failed before confirmed effect; safely retryable |
| 503 | DEPENDENCY_UNAVAILABLE | Required production integration cannot execute |

Callbacks respond 2xx to previously verified duplicate events without repeating business mutation. Never return success solely because queued work may eventually happen; return 202 with durable job ID and queryable status.
