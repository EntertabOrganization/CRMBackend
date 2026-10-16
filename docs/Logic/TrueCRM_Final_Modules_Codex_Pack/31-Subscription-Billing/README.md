# 31-Subscription-Billing — module map

SaaS plans, subscriptions, entitlements, payments, usage, credits, grace and reconciliation.

## Read order

First `../Agent.md`, all `../Shared-Contracts`, then these specs in numbered order:

- [`01-plan-catalog-and-entitlements.md`](01-plan-catalog-and-entitlements.md) — Plan catalog, immutable versions and entitlement resolution (Core V1).
- [`02-trials-and-subscription-lifecycle.md`](02-trials-and-subscription-lifecycle.md) — Trials, subscriptions, activation and renewals (Core V1).
- [`03-upgrades-downgrades-proration.md`](03-upgrades-downgrades-proration.md) — Plan changes, proration and compatibility (Core V1).
- [`04-billing-accounts-invoices-and-provider-payments.md`](04-billing-accounts-invoices-and-provider-payments.md) — Billing accounts, invoices, payments and provider reconciliation (Core V1).
- [`05-entitlement-usage-reservations-and-overages.md`](05-entitlement-usage-reservations-and-overages.md) — Quotas, usage reservations and overage controls (Core V1).
- [`06-credit-ledger-topups-and-expiration.md`](06-credit-ledger-topups-and-expiration.md) — AI credit ledger, grant types, top-ups and expiration (Core V1).
- [`07-dunning-grace-and-service-continuity.md`](07-dunning-grace-and-service-continuity.md) — Past-due recovery, grace and controlled service continuity (Core V1).
- [`08-referrals-discounts-and-partner-billing.md`](08-referrals-discounts-and-partner-billing.md) — Partner pricing integration and payer/beneficiary separation (Core V1).
- [`09-finance-reconciliation-and-reporting.md`](09-finance-reconciliation-and-reporting.md) — Billing ledger reconciliation and recurring revenue analytics (Core V1).
- [`10-billing-security-and-operations.md`](10-billing-security-and-operations.md) — Billing admin, finance permissions and operational safety (Core V1).

Tests: `../Testing/31-Subscription-Billing`. Dependencies crossing module boundaries are in the contracts, not owned tables.
