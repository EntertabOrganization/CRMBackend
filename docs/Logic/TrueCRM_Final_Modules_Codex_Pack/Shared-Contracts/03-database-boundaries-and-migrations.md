# Domain ownership, relational constraints and migrations

PostgreSQL owns durable business records, including event receipts and financial/credit/commission ledgers. Redis/cache/search/vector indexes are projections only. Use repository ORM (Prisma or TypeORM/etc) already installed; no forced ORM migration based solely on reference ZIP. New migrations additive; never edit migrations previously applied in staging/production.

## Ownership graph

- `knowledge_*` owns Space/Article/Revision/ACL/review/acknowledgement, not actual shared Files binary or global User.
- `ai_*` owns provider connection metadata, prompts, scenarios, runs, citations, tool policy, usage observations; cannot own spendable `billing_credit_*` ledger.
- `platform_*`/existing shared services own Outbox, Jobs, Audit, Search, Notifications, feature flags, retention and support access.
- `billing_*` owns SaaS subscription/invoice/payment, usage reservations, credit ledger and financial reconciliation, never CRM customer invoices.
- `partner_*` owns Partner organizations, relationships, role memberships, discount policies, referral/commission/payout policy and accrual ledger. Billing owns actual settled SaaS transactions and invoice snapshots; payout settlement evidence is retained in Partner Finance.

## Required database checks

- Every Workspace-scoped relation includes workspace-consistency invariant; foreign UUID cannot bind across tenants. Partner-scoped tables use partner relation and active membership verification.
- `partner_workspace_relations`: unique partial index on `(workspace_id)` WHERE `status='ACTIVE'`; tested under concurrent insertion.
- `partner_memberships`: unique active `(partner_id,user_id)` and last-owner protect with transactional locking.
- Provider events: unique `(provider_code, external_event_id)`; ledger event keys unique per financial effect.
- `billing_credit_ledger_entries` append only; `billing_usage_reservations` concurrency-safe row locks; `outbox` and `audit` appended in same transaction as domain mutation.
- `article_revisions` unique `(article_id,version_number)`; published pointer references immutable article revision; parent hierarchy acyclic and same-space/workspace.
- Currency amount, quantity, percentage use SQL NUMERIC, integer basis points, and immutable commercial/commission policy versions. Unit calculations use decimal, no binary float.

## Source-of-truth consistency

Outbox and Audit never replace source records; financial history corrected with separate reversal/adjustment; deleting User/Partner/Workspace never cascades audit or historical accounting evidence. Retention/legal holds gate final erasure. Maintain indexes on workspace+ID, scope+status/time, idempotency keys, provider receipts, version projections and hierarchy FKs.
