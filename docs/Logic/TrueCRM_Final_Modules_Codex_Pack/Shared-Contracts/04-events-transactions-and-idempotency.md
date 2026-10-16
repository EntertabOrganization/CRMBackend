# Outbox, retries, transactions, sagas and reliable integrations

## Event shape

```json
{"eventId":"uuid","eventType":"BILLING_PAYMENT_CONFIRMED","eventVersion":1,"workspaceId":"uuid","aggregateType":"BillingPayment","aggregateId":"uuid","aggregateVersion":3,"occurredAt":"2026-01-01T10:00:00Z","correlationId":"uuid","causationId":"uuid","actorType":"SERVICE","payload":{"paymentId":"uuid","invoiceId":"uuid"}}
```

Non-workspace Platform-level Partner/Plan events may have `workspaceId:null` only when schema explicitly declares a global/Partner audience. Never include credentials, raw prompts, private article body or card data in payload.

## Transaction pattern

1. Authenticate/authorize actor and validate preconditions (version/entitlements/ACL).
2. Claim idempotency key `(scope,operation,keyHash)` and compare canonical request hash; hash mismatch -> 409.
3. Lock authoritative aggregate row(s) deterministically, perform business transition, append redacted audit and outbox row in **one DB transaction**.
4. Worker publishes committed outbox; consumer dedup `(consumer,eventId)` and rechecks owner state/permission when required.
5. External provider action uses unique stable attempt/transaction ID, bounded retry and reconciliation on uncertain timeout. Success only on trusted confirmation.

## Long-running workflows

No 2PC across provider HTTP services. Use durable saga steps: QUOTED -> RESERVED -> DISPATCHED -> CONFIRMED -> SETTLED, compensating release/reversal if later step fails. A compensation is a new event/ledger row, never destructive edit of successful history. Concurrent insufficient-credit reserve uses database atomic balance check before issuing provider request.

## Race assertions

- Two Partner approvals cannot create multiple organizations or memberships.
- Two active Partner relations cannot be established for one Workspace.
- Two AI runs cannot each reserve the last available credit.
- Two payout requests cannot claim same eligible commission.
- Duplicate provider callback affects payment/commission/credits once only.
