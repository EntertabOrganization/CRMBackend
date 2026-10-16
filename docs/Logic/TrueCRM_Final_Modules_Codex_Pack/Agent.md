# TrueCRM Final Modules — MASTER EXECUTION CONTRACT

> **READ THIS FILE FIRST.** This is an implementation contract for Modules 28–32 of the approved TrueCRM platform. It is NOT a request to create new disconnected applications or parallel backends.

## Mission

Accept goals such as `Complete 30-Platform-Services`, `Complete 32-Partner-Program`, `Complete the whole final pack`. Inspect the actual repository, load relevant specs and shared contracts, implement backend and Next.js frontend, create versioned migrations, bind fail-closed test contracts to real implementation, run tests/regression and provide verifiable handoff. Do not stop after producing a plan if implementation is feasible. Never claim integration-complete when providers or a required domain service are missing.

## Requirement precedence

1. Latest explicit user changes after this pack.
2. Approved Q77–Q126 plus prior Q1–Q76 inherited rules and the user-confirmed Shared Understanding Report.
3. Updated TrueCRM BRD, PRD, System Architecture, and original Partner reference spec.
4. Existing repository implementation for technical choices that do not contradict locked business policies.
5. Bitrix24 as **functional comparison reference**, never as authority over confirmed TrueCRM decisions.
6. Implementation recommendations in this pack where the source left a purely technical detail unspecified.

If a source conflict changes behavior, flag it with the conflicting clauses instead of silently choosing. Repo-first ORM, naming and testing conventions win where the business contract is unchanged. Do not import the structural reference ZIP's Auth-only quirks or unverified defaults.

## Fixed platform architecture

- Next.js + TypeScript frontend, NestJS + TypeScript modular monolith backend, PostgreSQL transaction truth, Redis ephemeral/cache/queue transport, BullMQ workers, S3-compatible binary store, PostgreSQL FTS initially, WebSocket/SSE hints where useful.
- Do **not** introduce a parallel Python or LangChain backend solely for the AI module. Provider-agnostic gateway in the NestJS platform; OpenAI, Azure OpenAI, Anthropic Claude, Gemini, OpenRouter adapters.
- SaaS Billing, CRM invoicing and Commerce payments are distinct aggregates. Billing is sole owner of subscription, paid status, credit ledger, quota reservations and provider reconciliations. Partner is sole owner of discount/referral/commission policy and Partner membership. AI owns model usage evidence but not spendable balances.
- Global User identity, Workspace membership and PartnerMembership are different. Partner commercial relationship never grants customer Workspace access. Partner delegated access is explicit, expiring, revocable and further restricted by normal Workspace permission.
- PostgreSQL source entities, audit and outbox commit atomically. Caches/search/embeddings/counters/dashboards/realtime are rebuildable and must never be sources of authorization/business truth.

## Mandatory repository reconnaissance

1. Read this complete file and `README.md`.
2. Inspect root package manager/workspace, `package.json`, Next/Nest modules, compiler and test configs, environmental layouts and CI scripts.
3. Inspect existing Auth, Workspace, Permissions, Partner (from prior Auth pack), Audit, Billing, Knowledge, AI and shared Files/CRM/Workflows and earlier Commerce/Marketing/HR/Sites integrations; identify collisions, don't reimplement owners.
4. Inspect database schema and migration history; create only **new** versioned migrations, never rewrite applied files; no automatic production migration execution.
5. Read `Shared-Contracts/` and the module README + specs, then build code and tests in small dependency-aligned slices.
6. If dependency missing, implement typed integration seam and honest blocker report, never claim production-ready based on fake/test-only adapters.

## API, persistence, money, query

- `/api/v1` default REST prefix; keep repository response envelope if already approved, else `{success:true,data,meta}` and `{success:false,error:{code,message,details},requestId}`.
- `PUT` full editable replacement, `PATCH` partial; `Idempotency-Key` required for external billable side effects, retryable approvals, provision/refund/credit/payout operations.
- Pagination GET default `page=1 limit=20`, `limit<=100`; only allowlisted `search`, `sortBy`, `sortOrder`, structured filters; no arbitrary ORM column selection. Cursor-based event history where appropriate.
- Workspace ID is resolved and validated server-side. Keep `workspace_id`/UUID scope (or existing repo equivalent) and unique indexed `(workspace_id, id)` access. Partner IDs similarly scoped to an explicit Partner membership, never infer ownership from a query parameter.
- `NUMERIC` amount/unit precision. Discount/commission rates **integer basis points 0..10000**, currency precision per ISO currency minor units, deterministic decimal `ROUND_HALF_UP` at line amount boundaries; line and document totals recompute from immutable snapshots (no JS floats).
- `timestamptz` real instants and IANA timezone on schedules/periods; immutable commercial histories, append-only financial/usage/commission/audit ledgers.

## Auth and privacy non-negotiables

- AuthN != AuthZ; effective access intersects session/global role, active Workspace/Partner permission, resource ACL, explicitly delegated access, entitlement and feature flag. Never use UI gates as authority.
- Platform Admin is distinct from Workspace/Partner roles. No silent Platform Admin customer-data browsing; purpose-bound temporary customer-approved support grant or audited emergency flow.
- MFA for high-risk platform actions. Hash one-time tokens; use vault for provider credentials; don't log card details, API keys, full prompt input, HR protected records, private knowledge content or raw provider payloads.
- AI source content and tool arguments are untrusted. Filter source content before model request; validate schema after; high-risk tool changes always require human confirmation. AI role is behavior, never authorization. MCP/OAuth tools use limited, revocable grants and ordinary domain service commands.
- Access revocation must take effect despite stale search/embeddings/cache/realtime subscriptions.

## Reliability, deployment and retention

- Postgres domain transaction + audit/outbox; consumers/jobs at-least-once delivery with exactly-once **business effects** enforced by durable keys, stable provider event IDs and compensating ledgers.
- Durable asynchronous status, bounded retries, backoff/dead letter, operator intervention, timeouts and reconciliation for payment/AI provider uncertainty.
- Configure retention by data category and applicable jurisdiction before production activation, legal hold outranks deletion, Knowledge recycle default 30 days, plan trial 14 days, subscription recovery grace 15 days (all configurable policies). No silent data destruction on offboarding, expiry, Partner transfer or plan downgrade.
- CI: type check, formatting/lint, migrations, unit, integration, e2e, security and performance tests; staging and production isolated; backups encrypted, PITR when supported, verify restore. Preserve Git history: avoid destructive reset/rebase; commit only authorized source changes, never secrets.

## Module implementation order

1. `30-Platform-Services` event/outbox/jobs/audit/search/notifications first, while reusing any platform modules already implemented.
2. `31-Subscription-Billing` plans, entitlements, payment adapters, usage/credits, revenue.
3. `32-Partner-Program` applications, roles, customer relationship, discount/referral/commission/payout.
4. `28-Knowledge-Base` spaces, ACL, versions, publishing, import, search/recovery.
5. `29-AI-CoPilot` provider routing, permission-filtered RAG, tool policy, durable runs, MCP, evaluation and credit usage.

Integrate any earlier modules through contracts and repository-resolved service methods, not direct writes into other domains' tables.

## Testing contract

`Testing/*.spec.ts` and `.e2e-spec.ts` are executable, **fail-closed** Jest-style requirement contracts, not proof an application exists. A coding agent must implement real adapter setup/assertions for each ID and run against real domain/repository behavior. The harness rejects missing adapters and dummy evidence. Do not change tests to no-ops/skip/todo or mark production integrations complete from mocks. If repo uses Vitest, adapt tests to its existing runner. Successful tests must verify business state, authorization, audit/outbox, idempotency and cross-tenant isolation where applicable; E2E includes deployed HTTP/worker integration and is not satisfied by unit stubs.

## Definition of done

- All module-owned CRUD, commands, validators, screens, responsive/accessible UX and security checks integrated.
- Migrations additive, indexes+uniqueness constraints enforce race-critical invariants.
- API request/response examples implemented and error contracts stable.
- Critical mutations transactional; events/jobs idempotent and observed; secrets redacted.
- Every acceptance criterion maps to a passing real test. Run affected regression and audit/tenant security suite.
- README/manifest and test evidence up to date; no hidden TODO for approved behavior. Report real external prerequisites (provider keys, account approval, jurisdiction policies) separately.
- If a PR is asked, follow repository PR template and branch policy, inspect duplicates before proposing. Don't impersonate human authors or invent passing CI results.
