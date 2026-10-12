# Testing Contract — Pack 2

Every module specification in this ZIP has one `.spec.ts` (domain/service/integration scenarios) and one `.e2e-spec.ts` (one HTTP endpoint coverage obligation per operation). There are **32 spec files × 2 = 64 TypeScript contract files**, each containing deliberately failing `contract()` placeholders.

**These are not pre-passing tests.** They are executable Jest-style TODO-free safety gates: do not skip, delete, comment out, replace with static `expect(true).toBe(true)`, or call them implemented until connected to the real TrueCRM repository. Test code must use actual NestJS TestingModule, Supertest or repository HTTP helper, disposable PostgreSQL database, real validation/guards/tenant context, mocked external provider adapters with verified signatures and outbox assertions.

## Fixture matrix

- Active Workspace A owner/admin and limited employee, active Workspace B user with analogous IDs, a user not a member of A, disabled membership and a service principal with narrow API scope.
- SPA Type active/draft/archived, fields with readonly and hidden permission, two pipelines/stages, item with observer, recurrence and numbering sequence.
- Workflow definition V1/V2, failed node, timer, parallel join, approval ANY/ALL/QUORUM, scheduled callback and provider failing/timeout adapter.
- Inventory two Warehouses A/B, variant SKU with onHand 1, two competing Reservation requests, FIFO layers, average-cost receipts, transfer, Stocktake and posted immutable documents.
- Commerce Store A published and B suspended, catalog price, exclusive tax/promotion, cart tokens, same Checkout twice, Payment provider simulators (authorized/paid/refunded/failed/duplicate), split Shipments and Returns.

## Required scenario methodology

For every protected route: authenticated success (when permitted), 401 absent session, 403 insufficient action, cross-Workspace valid UUID IDOR non-disclosure, malformed input 400/422, status-invalid 409/422, stale version 409, correct DB effect and outbox. Public routes instead test unpublished Store, invalid/expired/replayed opaque token, rate limiting, cross-Store token and price/stock forgery. Provider routes test invalid signature, replay, delayed status and idempotency.

For mutations: inspect persisted entities and history, Audit for critical action, exactly-once outbox, no event on transactional failure. For jobs: 202 + ID, reproducible status, bounded retry/dead-letter, resumed completion after process restart.

## Critical race tests

1. Two concurrent Inventory reservations of last unit under negative/backorder false → only one succeeds, total reserved<=available before commits.
2. Same Inventory document Process with identical/different Idempotency-Key under concurrency → one set of movements/cost allocations.
3. Workflow timer delivered twice or worker dies after checkpoint before ACK → one logical node effect and one downstream state transition.
4. Concurrent same Checkout Session place-order across two requests → one Order, one reservation/coupon redemption.
5. Provider duplicated paid/refund/capture webhook + conflicting order of arrival → one business effect and valid state history.
6. Split shipment two Warehouses: failure of one leg never yields fully shipped/fulfilled state; retry repairs without duplicate sale.
7. Concurrent SPA stage moves with same expectedVersion → at most one transition, complete history/rollback.
8. Legal Hold blocks Workflow retention and SPA purge; immutable Inventory ledger not delete-able.

## Definition of passing

A named test PASSES only when its real expected assertions, DB effects and HTTP semantics have been executed against the implementation. Typecheck of placeholder TS is not sufficient. Do not claim tests pass without actual output. Test coverage and endpoint progress go in `IMPLEMENTATION_PROGRESS.md` inside the coding repository.
