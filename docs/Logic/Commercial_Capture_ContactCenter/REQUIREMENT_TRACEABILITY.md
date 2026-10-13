# Requirement Traceability

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


This file maps the major confirmed requirement groups to implementation specifications and tests. It is a coverage aid, not a replacement for the detailed specifications.

| Requirement | Primary specification | Primary executable contracts |
|---|---|---|
| Estimate lifecycle, semantic stages, revisions | `Estimates-Invoices-Payments/estimates.md` | `tests/modules/Commercial_Capture_ContactCenter/Estimates-Invoices-Payments/estimates.spec.ts`, `estimates.e2e-spec.ts` |
| Invoice lifecycle, numbering, immutable issue snapshot | `Estimates-Invoices-Payments/invoices.md` | `invoices.spec.ts`, `invoices.e2e-spec.ts` |
| Payment records, attempts, allocation, unapplied amount | `Estimates-Invoices-Payments/payments.md` | `payments.spec.ts`, `payments.e2e-spec.ts` |
| Stripe/XPay/generic provider callbacks | `Estimates-Invoices-Payments/payment-providers.md` | `payment-providers.spec.ts` |
| Full/partial refunds and unapplied credit | `Estimates-Invoices-Payments/refunds-and-credit.md` | `refunds.spec.ts` |
| Recurring invoice schedule/idempotency | `Estimates-Invoices-Payments/recurring-invoices.md` | `recurring-invoices.spec.ts` |
| Form logical entity and access modes | `CRM-Forms-Capture/forms.md` | `forms.spec.ts`, `forms.e2e-spec.ts` |
| Draft/publish/versioned schema | `CRM-Forms-Capture/form-builder-and-publishing.md` | `form-versioning.spec.ts` |
| Durable submission-first processing | `CRM-Forms-Capture/submissions-and-processing.md` | `form-processing.spec.ts` |
| Multi-entity capture, duplicate and assignment policy | `CRM-Forms-Capture/crm-capture-and-duplicate-resolution.md` | `crm-capture.spec.ts` |
| Contact Center boundary/channel model/AI policy | `Contact-Center/contact-center.md` | `contact-center.e2e-spec.ts` |
| Provider connection and normalized event model | `Contact-Center/channels-and-connectors.md` | `channel-events.spec.ts` |
| Session conversations/messages/transfers/reopen | `Contact-Center/conversations-and-messages.md` | `conversations.spec.ts` |
| Queue routing, eligibility, SLA | `Contact-Center/routing-sla-and-agent-assignment.md` | `routing.spec.ts`, `sla.spec.ts` |
| Requisite ownership/lifecycle | `Company-Details-Requisites-Bank/requisites.md` | `requisites.spec.ts`, `requisites.e2e-spec.ts` |
| Country/entity presets and typed addresses | `Company-Details-Requisites-Bank/requisite-presets-and-addresses.md` | `requisites.spec.ts` |
| Sensitive bank account data and permissions | `Company-Details-Requisites-Bank/bank-data.md` | `bank-data.spec.ts` |
| Seller company defaults and immutable commercial snapshots | `Company-Details-Requisites-Bank/seller-companies-and-commercial-snapshots.md` | `commercial-snapshots.spec.ts` |
| Tenant isolation | `Agent.md` + every module spec | E2E contracts in each top-level Testing folder |
| Outbox, audit, idempotency, retry, migrations | `Agent.md` + module-specific rules | all relevant contract tests |

## Source-to-module coverage

- TrueCRM PRD commercial document requirements -> Estimates/Invoices/Payments specs.
- TrueCRM PRD CRM Forms requirements -> CRM Forms/Capture specs.
- TrueCRM PRD Contact Center requirements -> Contact Center specs.
- TrueCRM PRD Company Details/Requisite requirements -> Requisite/Bank/Snapshot specs.
- TrueCRM System Architecture module boundaries -> service ownership, PostgreSQL model, outbox/jobs and dependencies in every specification.
- TrueCRM BRD business rules -> acceptance criteria and lifecycle constraints.
- Confirmed Q1-Q60 -> `DECISIONS.md` and corresponding specification sections.
- Bitrix24 official API reference -> conceptual reference only; no Bitrix legacy API is made a TrueCRM requirement.
