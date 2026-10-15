# Operational DTO contracts, validation matrix and transaction assertions

This document makes critical write payloads explicit. Where no example is supplied for a CRUD endpoint, derive the DTO from its owning entity fields and module-specific validation rules and reuse repository conventions; no client payload may specify workspace, audit actor or privileged generated fields.

## Commerce: cart and order

| Operation | Mandatory payload and validation | Authorized effects | Atomicity and error assertion |
|---|---|---|---|
| `POST /api/v1/commerce/stores` | `name` 1–120 trimmed chars, `slug` URL-safe unique in workspace, `mode` `WEB/HEADLESS/HYBRID`, uppercase ISO currency, supported locale and IANA timezone; policy fields type-safe | Store created `DRAFT`, audit+outbox; no public routing | Duplicate slug 409; missing permission 403; Store quota reached denies create without side effects |
| `POST /api/v1/commerce/stores/:id/activate` | expected version; configured merchant/offline payment mode, tax/zero-tax rule, delivery/pickup, store public channel and mandatory retention | State `ACTIVE`, publish public readable Store reference | Missing required policy 409; failed domain ownership does not create a route |
| `POST /api/v1/public/carts/:id/items` | `variantId` UUID, `quantity` >0 in Catalog unit granularity, selectedOption IDs belong to variant | Locked Cart version + updated line + quote invalidation | Foreign variant 404; unpublished product 409; quantity overflow 400 |
| `POST /api/v1/public/checkout-sessions/:id/confirm` | `buyer.type` `INDIVIDUAL/COMPANY`; verified/normalized name and email or phone per Store policy; company billing fields when company payer; `deliveryMethodId`, `paymentMethodId`, `acceptedQuoteVersion`, idempotency key | Exactly one Order with immutable line/address/pricing snapshots, valid reservation records, checkout `ORDER_CREATED`, audited outbox | Same payload/key returns same Order ID; different payload/key 409; failed stock check 409 without orphaned paid Order; stale quote 409 |
| `POST /api/v1/commerce/orders/:id/amend` | `expectedVersion`, `reason` 1–500 chars, changed unfulfilled lines (positive quantity/known variant), no write to immutable captured details | New amendment/history snapshot, updated unfulfilled quantities, stock deltas through Inventory | Shipped/invoiced immutable quantities 409; invalid stock => no partial mutation |
| `POST /api/v1/commerce/returns/:id/inspect` | inspected quantity <= received, disposition `RESTOCK/SCRAP/REPAIR/NO_RESTOCK`, signed reviewer reason | Inspection event; Inventory movement only for approved RESTOCK | Unreceived return 409; repeated inspection key never double-restocks |
| `POST /api/v1/commerce/orders/:id/payment-intents` | validated payment method, client-return URL from allowed host list; amount resolved from Order, not submitted | Payment owner creates attempt and provider reference; Order status only updates from verified trust | Invalid/replayed callback cannot capture; provider timeout reconciled before second intent |
| `POST /api/v1/public/digital-deliveries/:id/token` | validated purchaser session/guest order token and licensed order line | Expiring hashed download token and audit | Foreign customer 404; refunded access follows stored policy; download count enforced |

## Marketing: targeting and sending

| Operation | Mandatory payload and validation | Authorized effects | Atomicity and error assertion |
|---|---|---|---|
| `POST /api/v1/marketing/segments` | `name`, `kind=STATIC|DYNAMIC`; dynamic rules versioned declarative AST with allowlisted fields/operators | Segment DRAFT/ACTIVE and version | Unknown CRM filter field 400, never arbitrary SQL |
| `POST /api/v1/marketing/audiences/import-jobs` | Files-scanned file ID, `segmentId`, `fieldMapping`, source/consent-evidence policy, idempotency key | Async preview with row errors; no CRM create until separately authorized | Invalid/malicious CSV quarantined and rejected; imports do NOT grant consent |
| `POST /api/v1/marketing/consents` | subject or destination key, channel, purpose, lawful basis, verified source/evidence, effective date | Append-only consent history, suppression invalidation only through authorized process | Unknown consent remains ineligible when consent required; employee cannot set consent for arbitrary tenant |
| `POST /api/v1/marketing/campaigns/:id/schedule` | expected revision, ISO zoned scheduled time with IANA zone, approved sender, audience snapshot and template; explicit quota/cost estimate acknowledgement as configured | Immutable schedule job, approval-bound revision | Same schedule key once; material edit invalidates old approval; missing provider verification 409 |
| Send worker `deliver(deliveryId)` | Frozen campaign version; eligible recipient destination; latest suppression/consent; quiet hours, cap, source policy | Durable attempt + provider request, status events; provider key recorded | Suppressed never sent; timeout-after-accept reconciles first; no cross-channel retry without explicit new recipient eligibility |
| `POST /api/v1/marketing/campaigns/:id/experiments` | 2+ approved variants, percentages sum exactly 100, valid metric/min sample, randomization seed | Stable recipient allocation per experiment | 60+50 rejected; no unpublished variant; running version immutable |

## HR: time and leave

| Operation | Mandatory payload and validation | Authorized effects | Atomicity and error assertion |
|---|---|---|---|
| `POST /api/v1/hr/schedules/:id/versions` | effective DATE start/end, `type`, IANA timezone, working weekday windows/break rules, version | Future-dated ScheduleVersion, no retroactive final record edit | Overlap 409; illegal DST wall-time rule requires resolution policy |
| `POST /api/v1/hr/me/clock-in` | authenticated active EmployeeProfile, client command key; any GPS/QR evidence only if configured | One open WorkSession + CLOCK_IN WorkEvent + audit | Duplicate key returns same session, simultaneous new session 409, unavailable verification 409 policy-specific |
| `POST /api/v1/hr/attendance/corrections` | employee/session, proposed event types and timestamp, nonempty reason | REQUESTED correction + supervisor inbox notification | Original raw event unchanged, no auto-approve; unauthorized manager 403 |
| `POST /api/v1/hr/timesheets/:id/approve` | reviewer user, expectedVersion, approval comment if required | APPROVED review, immutable calculation version | Reviewer must be distinct if self-approval prohibited; locked timesheet cannot mutate |
| `POST /api/v1/hr/leave/requests/:id/submit` | effective leave policy, schedule-local dates or hourly ranges, balance account, expectedVersion | REQUEST_HOLD ledger + workflow instance and notification | Two concurrent requests cannot overspend; missing accrual policy => 409 POLICY_NOT_CONFIGURED |
| `POST /api/v1/hr/leave/requests/:id/approve` | authorized active human workflow approver, workflow step, expected state | Convert one hold to debit, publish free/busy through outbox | Repeat approval no second debit; personal reason not copied to Calendar |

## Sites: release and public access

| Operation | Mandatory payload and validation | Authorized effects | Atomicity and error assertion |
|---|---|---|---|
| `POST /api/v1/sites/:id/domains` | normalized hostname, valid DNS verification method, site ownership | PENDING domain challenge; no public bind yet | Host takeover/duplicate 409; unverified hostname never serves victim content |
| `POST /api/v1/sites/pages/:id/revisions` | explicit valid block/schema refs, safe props/media IDs, expected draft revision | New draft PageRevision with sanitized schema | XSS/unknown block 400; ACTIVE revision and public content unchanged |
| `POST /api/v1/sites/:id/releases/publish` | release UUID, expectedSiteVersion, approved candidate page/shared-block refs, entitlement and domain ready | Atomically move active pointer to frozen release, publish event, async CDN invalidation | Mixed partial release impossible; failed validation leaves old public content |
| `POST /api/v1/sites/:id/preview-links` | release draft reference, audience restriction, positive finite expiry, optional password | Hashed scoped link with noindex and revocation | Expired/revoked link 410; preview cannot call publish API |
| `POST /api/v1/sites/:id/scripts` | controlled CSS/JS source or approved provider integration, consent category, origin allowlist, review request | DRAFT script only; separate approver required before production | Unsafe executable code or credential access 400/403; no site publication side effect |
| `POST /api/v1/sites/pages/:id/experiments` | A/B allocation 100%, immutable approved variants, goal/time policy, tracking consent | Experiment DRAFT/READY; stable deterministic assignment on activation | Privacy blocks prohibited visitor persistence; cannot auto-publish winner |

## Error/audit/outbox transaction assertion

For every row above, tests execute: (1) permitted command, (2) invalid values, (3) disallowed actor, (4) foreign workspace reference, (5) same-key retry/expected-version conflict, (6) direct database check for state and history, (7) audit and outbox once-effective rows, (8) worker/provider failure and recovery. Mutation must not update business rows without corresponding audit/outbox (except narrowly documented ephemeral/attempt telemetry). Authorization errors may create *separate sanitized security-denial events* but must not mutate the protected business resource.
