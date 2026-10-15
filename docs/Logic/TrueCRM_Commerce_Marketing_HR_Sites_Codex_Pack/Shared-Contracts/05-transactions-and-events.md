# Transactions, outbox, workers, webhooks and idempotency

Every domain mutation: validate/authorize -> acquire expected-version/row locks -> change authoritative rows + append audit + append `outbox_events` in ONE PostgreSQL transaction -> commit -> asynchronously fan out Notifications/Search/Analytics/Workflow/Webhooks/Realtime.

Event JSON envelope:
```json
{"eventId":"uuid","eventType":"ORDER_CREATED","eventVersion":1,"workspaceId":"uuid","resourceId":"uuid","occurredAt":"2026-10-12T12:00:00Z","correlationId":"uuid","causationId":"uuid","actor":{"type":"USER","id":"uuid"},"payload":{"orderId":"uuid","status":"PENDING_PAYMENT"}}
```
PII minimization: payload includes IDs/safe status, no unencrypted destinations, full addresses, HR reasons, provider credentials or financial card data.

### Concurrency/once-effective processing
- Idempotency uniqueness includes workspace, logical command, key, request hash. Same key/same payload => replay original response; different payload => `409 IDEMPOTENCY_KEY_REUSED`. Retain idempotency record for configured provider retry horizon/financial retention needs; never recycle financial keys early.
- Worker/job claim via DB `FOR UPDATE SKIP LOCKED` or existing equivalent lease. Lease renewal/expiration, capped retries, exponential jitter, dead-letter visible in operations dashboard. No promise of exactly-once message transport; guarantee exactly-once **business effect** by domain constraints and idempotent consumers.
- Provider inbox persists verified callback ID under unique `(connection_id,provider_event_id)` before applying. Use signatures/timestamps and authoritative lookup for providers whose callback signature model differs; unverified events do not affect state.
- External API call after DB commit can fail: persist transition command, retry/reconcile; if previous call may have succeeded, check provider state by correlation/external reference rather than blindly duplicating charge/message/shipment.
- Read models and CDN can lag; expose freshness/health and rebuild from durable source; authoritative API read/permission check is never replaced by stale search index.
