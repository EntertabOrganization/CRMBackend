# Delivery phases, module boundaries and dependencies

**Overall decision (Q1):** specify complete scope, implement by Core V1 then advanced phase. Backend remains one NestJS modular monolith; frontend Next.js. No Python/LangChain second backend introduced.

## Build order

0. Repository reconnaissance: verify existing Auth/Workspaces/Permissions/CRM/Catalog/Inventory/Commercial Payments/Workflow/Files/Jobs/Audit/Subscription/AI interfaces and migrations. Missing module => implement narrowly specified adapter contract, keep production blocker visible; do not clone shared domain tables.
1. Shared contracts: /api/v1 envelopes, auth/entitlement, outbox/worker, seed data, provider registry and failure taxonomy.
2. Commerce V1: stores + listings + carts/checkout + Orders + stock reservations + Stripe/XPay/offline payments + fulfillment/returns and CRM linkage. Extended portal/pricing/promotion/reporting follows after core flows.
3. Marketing V1: segments/imports + consent/suppression + sender accounts + immutable templates + approvals + scheduler/delivery worker + engagement/reporting. Journeys/experiments/ad connectors and repeat-sales as advanced tracks; production provider interfaces specified now.
4. HR V1: employee work profiles + schedule versions + clock/break/attendance corrections + timesheet + leave/absence + scoped data security. Overtime policy, work reports and expanded onboarding, reporting advanced.
5. Sites V1: site/domain managed hosting + editor/page/block/theme + draft/revision/publish + languages/RTL/SEO + Forms/Commerce blocks. Script approval, experiments, AI generator, extended exports/recovery advanced.
6. Cross-module E2E regression, security, permission, performance, queue restart, consistency, rollback, deployment readiness and live staging provider smoke.

## Dependency resolution

- If Auth, CRM, Inventory, Commercial Payments or Workflow do not yet exist: state missing production integration and provide typed contract, adapter and test fake. **Do not** change source-of-truth ownership by creating duplicate tables in this pack.
- Portability export is content/config export; Q25 selected managed hosting, not externally hosting an identical executable site. Any future independent-site runtime export requires separate product decision.
- Meta/Google advertising connector and voice provider integrations can be phased implementation features but are in target scope. Implementation agent must not misreport them as finished if only interfaces exist.
- Jurisdiction-specific tax/HR/consent/retention rules require explicit administrative configuration; no secret tax rates, leave entitlements or legal timelines are baked into defaults.

## Definition of Done per increment

Schema/migration and typed API implemented; field validation+scope+entitlement+history; domain event/outbox; integration contract; Next.js screens; all module unit/integration/E2E/security tests passing, affected cross-module tests passing, docs/env updates, and production blockers called out. The whole package is complete only when all Core+Advanced target features and supported provider adapters have verified test evidence or are explicitly reported incomplete.
