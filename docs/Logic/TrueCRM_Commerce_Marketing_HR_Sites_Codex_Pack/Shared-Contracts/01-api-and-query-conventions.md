# API and Query Contract

## Route and transport

- Canonical internal prefix `/api/v1`. All module routes in specifications are relative to this prefix. Controllers use existing repository conventions when a route is already deployed. Do not duplicate prefix (`/api/v1/api/v1`).
- Internal access: short-lived user session plus selected workspace context, rechecked against active membership; service principals have explicit scoped grants. `X-Workspace-Id` is only a selection hint for authenticated members, never authority.
- Public: resolve verified domain/store by server-side host registry or signed public token. `workspaceId`, `price`, `allowedRole` and customer identities supplied by the client cannot elevate authority.
- External webhooks live under `/api/v1/integrations/<provider>/...` and are authenticated through provider-specific signature/verification plus known connection. Webhooks do not require browser cookie authentication.
- Use `Idempotency-Key` on checkout, order status financial commands, refunds, shipment dispatch, marketing scheduling/sending, HR leave decisions, site activation; scope key by workspace, authenticated or public subject, endpoint and request-body hash; return same cached effect on repeat, 409 if same key/different payload.

## Request and response examples

Create a store:
```http
POST /api/v1/commerce/stores
Authorization: Bearer <session-token>
X-Workspace-Id: <authorized-workspace-uuid>
Content-Type: application/json

{"name":"North Store","slug":"north","mode":"HYBRID","defaultCurrency":"EGP","defaultLocale":"ar-EG","timezone":"Africa/Cairo","policy":{"guestCheckoutEnabled":true,"backordersEnabled":false,"reservationTtlSeconds":1800}}
```
Server must reject unknown `workspaceId` in body, missing allowed currency/tax rules before activation, duplicate slug and invalid timezone. Activation is a different command.

Checkout confirm:
```http
POST /api/v1/public/checkout-sessions/<id>/confirm
Idempotency-Key: <random-uuid>
Content-Type: application/json

{"buyer":{"type":"INDIVIDUAL","name":"Test Buyer","email":"buyer@example.test"},"billingAddressId":"<checkout-address-id>","deliveryMethodId":"<delivery-id>","paymentMethodId":"<payment-method-id>","acceptedQuoteVersion":2}
```
Never accept client `total`; derive amounts and verify ownership using session binding. If quote expired return `409 QUOTE_EXPIRED` with safe refresh action; same-key retry returns same Order ID.

Marketing launch:
```http
POST /api/v1/marketing/campaigns/<id>/launch
Idempotency-Key: <random-uuid>
Content-Type: application/json

{"expectedVersion":5,"approvedRevision":3}
```
Require valid publisher permission, current entitlement, approved revision, ready audience/sender/consent policy and delivery budget.

HR correction:
```http
POST /api/v1/hr/attendance/corrections
Content-Type: application/json

{"employeeId":"<employee-uuid>","workSessionId":"<session-uuid>","proposedEvents":[{"type":"CLOCK_OUT","occurredAt":"2026-10-12T17:00:00+03:00"}],"reason":"Forgot to clock out"}
```
Correction is a request; raw original work event remains unchanged until authorized approval creates an overlay/history.

Sites release:
```http
POST /api/v1/sites/<site-id>/releases/publish
Idempotency-Key: <random-uuid>
Content-Type: application/json

{"releaseId":"<release-uuid>","expectedSiteVersion":10}
```
Ensure all associated drafts and shared-block versions are approved before atomically activating the release; rollback also creates a new activation audit.

Single resource:
```json
{"success":true,"data":{"id":"<uuid>"},"meta":null}
```
Lists:
```json
{"success":true,"data":[],"meta":{"page":1,"limit":20,"total":0,"totalPages":0}}
```
Error:
```json
{"success":false,"error":{"code":"VALIDATION_FAILED","message":"Invalid input","details":{"fields":[{"field":"email","reason":"INVALID_FORMAT"}]}},"requestId":"<correlation-id>"}
```

## Query convention

- Default page 1, limit 20, maximum 100. Keyset/cursor pagination for append-only events/large analytical feeds; never allow unbounded table scans from public input.
- Allowlist `search` fields per entity; sortBy values per endpoint, stable secondary sort by ID; supported operators: `eq`, `neq`, `in`, `notIn`, `contains`, `startsWith`, `gt`, `gte`, `lt`, `lte`, `isNull`. No raw ORM paths.
- `PUT` replaces all client-editable fields with documented required fields; `PATCH` updates supplied fields only. Atomic business commands use `POST /:id/<verb>` rather than arbitrary status mutation.
- ETags or `expectedVersion` required where concurrent edits can overwrite data. `409 VERSION_CONFLICT` includes safe current version but no restricted content.
- Validation uses canonical DTO schemas (UUIDs, E.164 phone where international routing used, normalized email, IANA zones, ISO timestamps, positive NUMERIC quantities); reject unexpected keys if privilege-sensitive.
- Avoid surprise N+1 lists; pagination, performance indexes, constrained joins, permission-aware field selection and export quotas are mandatory.
