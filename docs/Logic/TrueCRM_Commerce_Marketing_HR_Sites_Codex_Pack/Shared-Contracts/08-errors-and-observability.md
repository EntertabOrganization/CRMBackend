# Stable errors, metrics, health and operations

## Error vocabulary and HTTP mapping

| HTTP | Code | Meaning |
|---|---|---|
| 400 | VALIDATION_FAILED | Field or DTO rules fail; details.field reason |
| 401 | UNAUTHENTICATED | No valid employee/customer session |
| 403 | PERMISSION_DENIED | Authenticated subject fails action, scope, field or entitlement |
| 404 | NOT_FOUND | Resource absent or intentionally concealed foreign tenant ID |
| 409 | VERSION_CONFLICT | Optimistic version mismatch |
| 409 | INVALID_STATE_TRANSITION | Invalid lifecycle edge |
| 409 | IDEMPOTENCY_KEY_REUSED | Same scoped key with different request hash |
| 409 | POLICY_NOT_CONFIGURED | Mandatory locale, tax, leave, consent or retention policy absent |
| 409 | INSUFFICIENT_STOCK | No stock and no authorized backorder |
| 409 | QUOTE_EXPIRED | Cart/order amount must be recomputed |
| 410 | RESOURCE_EXPIRED | Guest/preview/order link expired or consumed |
| 422 | RECIPIENT_INELIGIBLE | Suppressed or cannot legally deliver |
| 429 | RATE_LIMITED | Rate or sending quota exceeded |
| 503 | DEPENDENCY_UNAVAILABLE | Critical upstream dependency unavailable; includes retry hint where safe |

Other domain codes must be registered with stable meaning and tested. Never leak raw provider response, SQL stack, PII or secret in `message`/`details`.

## Operational diagnostics

- Structured logs with correlation ID + request ID + workspace ID (not a PII dump); queue/job ID, provider connection, safe external reference ID; redacted sensitive fields.
- Counter/rate/gauge metrics: checkout idempotency conflict, payment verification rejection, inventory reservation failure, order out-of-stock exceptions, marketing send lag/retry/bounce/complaint and suppression, HR missing clock events and approval latency, site release failure/rollback, public latency/error rate, CDN purge lag, outbox publication lag and dead letters.
- Distributed tracing across Next.js->NestJS->DB->queues and external adapters; exclude tokens/addresses/sensitive fields from traces.
- Health/readiness surfaces: payment/provider connections, sender verification, ads sync, stock service, HR policy readiness, domain SSL, site release compile, storage scanner, outbox/queues.
- Alert on unprocessed paid order, duplicate side effect detection, sustained provider failures, marketing complaint spikes, legal-hold purge attempt, unverified custom domain routing and revoked-sender pending jobs.
