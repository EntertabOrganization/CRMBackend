# 32-Partner-Program — module map

Applications, membership, Partner permissions, discounts, customer provisioning, delegation, referral attribution and payouts.

## Read order

First `../Agent.md`, all `../Shared-Contracts`, then these specs in numbered order:

- [`01-public-applications-and-approval.md`](01-public-applications-and-approval.md) — Public Partner application, verification and atomic approval (Core V1).
- [`02-partner-memberships-roles-and-permissions.md`](02-partner-memberships-roles-and-permissions.md) — Partner memberships, fixed roles and scoped permissions (Core V1).
- [`03-partner-discounts-and-price-rules.md`](03-partner-discounts-and-price-rules.md) — Partner default discounts, overrides and effective pricing (Core V1).
- [`04-workspace-provisioning-and-commercial-relationship.md`](04-workspace-provisioning-and-commercial-relationship.md) — Customer workspace provisioning and one active Partner relationship (Core V1).
- [`05-delegated-workspace-access-and-revocation.md`](05-delegated-workspace-access-and-revocation.md) — Explicit Partner delegated access to customer Workspace (Core V1).
- [`06-referrals-attribution-and-transfer.md`](06-referrals-attribution-and-transfer.md) — Partner referral codes, attribution and reassignment (Core V1).
- [`07-commissions-and-accrual-ledger.md`](07-commissions-and-accrual-ledger.md) — Commission eligibility, accrual and reversals (Core V1).
- [`08-payouts-finance-approvals-and-reconciliation.md`](08-payouts-finance-approvals-and-reconciliation.md) — Partner payouts, finance approval and reconciliation (Core V1).
- [`09-suspension-deletion-and-governance.md`](09-suspension-deletion-and-governance.md) — Partner suspension, deletion, restore and retention (Core V1).
- [`10-dashboard-admin-and-search.md`](10-dashboard-admin-and-search.md) — Partner portal dashboard, dynamic query and reporting (Core V1).

Tests: `../Testing/32-Partner-Program`. Dependencies crossing module boundaries are in the contracts, not owned tables.
