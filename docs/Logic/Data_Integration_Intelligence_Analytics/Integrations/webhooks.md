# Webhooks & Provider Events Specification

## Goal

Deliver TrueCRM business events reliably to external subscribers and accept provider callbacks securely/idempotently.

## Outgoing webhook subscription

Suggested fields:

```text
id
workspaceId
name
targetUrl
secretRef
eventTypes
status ACTIVE|PAUSED|DISABLED
schemaVersion
createdBy
```

Validation:
- HTTPS required except explicitly allowed local development,
- block loopback/private-network SSRF destinations according to platform egress policy unless explicitly allowlisted,
- event types must be recognized,
- secret stored securely.

## Event envelope

Outgoing webhook body should be a stable versioned envelope:

```json
{
  "id": "event-uuid",
  "type": "CRM_CONTACT_UPDATED",
  "version": 1,
  "occurredAt": "2026-09-28T12:00:00Z",
  "workspace": {
    "id": "workspace-uuid"
  },
  "resource": {
    "type": "CONTACT",
    "id": "contact-uuid"
  },
  "actor": {
    "type": "USER",
    "id": "user-uuid"
  },
  "data": {
    "changedFields": ["email"]
  }
}
```

Do not include unrestricted full database records by default.

Subscriber can call API for current authorized resource data.

Sensitive fields must be excluded unless the webhook event contract explicitly allows them and subscription scope permits them.

## Signature

Use platform standard; if absent, recommended:
- HMAC-SHA256 over canonical timestamp + raw body,
- timestamp header,
- signature header,
- delivery/event ID header.

Document algorithm/version.

Secret rotation should support an overlap window if platform permits.

## Delivery state

Suggested statuses:

```text
PENDING
DELIVERING
DELIVERED
RETRY_WAIT
DEAD_LETTER
CANCELLED
```

Delivery row:
- subscription ID,
- outbox event ID,
- attempt count,
- next attempt time,
- last HTTP status,
- sanitized error,
- request body/version reference,
- response summary truncated/sanitized,
- timestamps.

## Retry

Retry only transient/network/server failures according to policy.

Use exponential backoff with jitter and shared job default max attempts unless webhook policy explicitly defines more/less.

Permanent 4xx errors generally dead-letter without endless retry, except documented retryable statuses.

## Manual replay

Authorized user can replay a dead-letter/failed delivery if:
- subscription still active or explicitly allowed,
- retained event payload/schema is available,
- event is replayable.

Replay creates a new delivery attempt linked to original event; it does not mutate the original delivery history.

Requires `webhook.replay` and audit.

## APIs

```text
GET    /api/v1/integrations/webhook-subscriptions
POST   /api/v1/integrations/webhook-subscriptions
GET    /api/v1/integrations/webhook-subscriptions/:id
PATCH  /api/v1/integrations/webhook-subscriptions/:id
POST   /api/v1/integrations/webhook-subscriptions/:id/rotate-secret
POST   /api/v1/integrations/webhook-subscriptions/:id/pause
POST   /api/v1/integrations/webhook-subscriptions/:id/resume

GET    /api/v1/integrations/webhook-deliveries
GET    /api/v1/integrations/webhook-deliveries/:id
POST   /api/v1/integrations/webhook-deliveries/:id/replay
```

## Incoming provider events

Provider callback routes are owned by provider adapters/connections.

Conceptual flow:

```text
HTTP callback
→ resolve provider/connection from trusted route/token mapping
→ capture raw body safely
→ verify signature/secret/OAuth/provider lookup as adapter requires
→ validate timestamp/replay window if supported
→ persist provider event with unique external event ID/hash
→ acknowledge according to provider contract
→ enqueue processing
→ domain adapter maps event
→ call owning TrueCRM service
→ store processed outcome
```

Never select workspace from untrusted callback body alone.

## Provider event model

Suggested:

```text
id
workspaceId
connectionId
provider
externalEventId
eventType
payloadRef/encryptedPayload depending policy
payloadHash
verificationStatus
processingStatus
receivedAt
processedAt
attemptCount
errorCode
```

Unique:
`connectionId + externalEventId` where provider supplies stable ID.

If provider lacks an event ID, use documented deterministic fingerprint with replay window.

## Verification policies

Adapter may use:
- HMAC,
- asymmetric signature,
- shared secret,
- OAuth/provider-signed token,
- authoritative provider lookup,
- IP allowlist as supplemental control,
- timestamp/nonce.

IP allowlist alone is not sufficient where stronger provider verification exists.

## Idempotent processing

Duplicate callbacks return/ack safely without reapplying business effect.

Provider-event state is durable before processing side effects where practical.

## Operational logs/retention

Detailed webhook/provider payload logs default to 90-day retention, subject to policy/legal hold.

Sanitize secrets and sensitive fields.

## Audit

Audit:
- subscription create/update/pause/resume,
- secret rotation,
- manual replay,
- security-relevant provider connection verification setting changes.

## Acceptance criteria

- Outgoing payload schema is versioned/stable.
- Secret never returned after creation/rotation response.
- Signature verification test detects tampering.
- Delivery retries safely and reaches dead-letter after policy limit.
- Manual replay is permission-controlled and audited.
- SSRF-prohibited target URL is rejected.
- Duplicate incoming provider event processes business effect once.
- Callback cannot select another workspace from body data.
- Invalid signature/replay is rejected before domain mutation.
