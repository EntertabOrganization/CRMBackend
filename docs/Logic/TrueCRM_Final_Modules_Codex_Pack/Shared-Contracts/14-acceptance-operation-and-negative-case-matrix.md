# High-value operational DTOs, DB effects and failure assertions

| Operation | Valid request and checked preconditions | Atomic successful effects | Failure and expected code |
|---|---|---|---|
| `POST /api/v1/platform/partner-applications/:id/approve` | Platform Admin, verified applicant, PENDING application, `expectedVersion`, command key | one Partner, PartnerOwner role, membership, discount version, audit, outbox | two admin approvals race -> one 200/other 409; non-Admin 403, zero writes |
| `POST /api/v1/partners/:id/customer-workspaces` | active Partner Member with provision permission, real customer user and consent, valid name | Workspace owner = customer, one Partner relation, no Partner workspace membership | conflicting active Partner relation 409, no double Workspace |
| `POST /api/v1/workspaces/:id/partner-access/:grant/approve` | customer owner, restricted permission list, expiry, grant version | grant ACTIVE, cache version invalidated, audited | cross-tenant or Partner self-grant 403; stale version 409 |
| `POST /api/v1/billing/credits/topup-purchase` | immutable quote, verified payer, idempotency, permitted Partner rate snapshot | trusted payment => ledger GRANT, invoice, audit/outbox | browser-only success no GRANT; duplicate provider event does not regrant |
| `POST /internal/billing/usage/reserve` | eligible meter, estimated units, operation key | unique reservation, lock quota, increment reserved | two concurrent overspends: only one success, other 422 |
| `POST /internal/billing/usage/:id/settle` | trusted usage actual <= reserved unless approved extra reserve, unique event key | consumption ledger + release remainder, immutable event | duplicate event returns same receipt, no negative balance |
| `POST /api/v1/knowledge/articles/:id/publish` | publish role, exact approved revision, current ACL/file scan, expectedVersion | publishedRevision pointer, audit, outbox/search event | changed draft without review -> 409; draft never leaked |
| `POST /api/v1/ai/runs` | authorized scenario, allowed region/provider, quota reserve, idempotency | durable run, reservation, async job, audit | forbidden scenario 403, no provider/credit debit |
| `POST /api/v1/ai/runs/:id/tool-calls/:call/approve` | exact hash, live domain permission, tool risk/approval rule | pending tool status and audit, subsequent service command under policy | high-risk Allow Always 403/422; changed args 409 |
| `POST /api/v1/platform/support-access/requests` | purpose, Workspace, scope, expiry, global support role | REQUESTED grant + notification; no access until approved | silent staff browsing 403 |
| `POST /api/v1/partners/:id/payout-requests` | eligible approved commissions, unique claims, payer/legal policy | single batch, reserved payouts, audit/outbox | duplicate eligible commission in another active batch 409 |

Concrete URLs may be adapted to existing Nest controller prefixes as long as this behavior remains test-verifiable. Every operation must also cover invalid input, actor denial, foreign Workspace/Partner UUID, duplicate retry, transaction rollback and audit redaction.
