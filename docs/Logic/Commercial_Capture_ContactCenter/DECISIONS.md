# Confirmed Decision Register

> **Backend-only implementation scope:** This specification authorizes server-side work only: database schema and migrations, domain/application services, REST APIs, authorization, audit/outbox events, workers/jobs, provider adapters, and automated backend tests. Do not create, modify, scaffold, or test frontend pages, UI components, browser views, styling, or client-side application code. Any UI/browser wording below defines backend-facing behavior or security constraints only.


All decisions below are locked unless the human partner explicitly changes them later.

## Round 1 — Scope/foundation
- **Q1:** Bitrix24 is a strong behavioral/reference model, but TrueCRM is designed natively.
- **Q2:** Target full production-ready specification depth rather than a minimal MVP.
- **Q3:** Deliver one combined pack for the connected capability areas.
- **Q4:** Split significant concepts into dedicated submodule specifications.
- **Q5:** Canonical domain name is `Estimate`; UI may use configurable aliases such as Quote.
- **Q6:** Payments support Manual + Stripe + XPay + a generic provider adapter architecture.
- **Q7:** CRM Forms support both `SUBMISSION_ONLY` and CRM-capture behavior.
- **Q8:** Contact Center architecture covers Web Chat, WhatsApp, Telegram/social messenger adapters, Email, SMS, Telephony, Callback and future connectors.
- **Q9:** Requisites use country + entity-type presets with dynamic required/available fields.
- **Q10:** Contact Center AI supports summaries, transcription, suggested replies and classification/extraction; a human sends customer-facing replies.

## Round 2 — Estimates / Invoices / Payments
- **Q11:** Estimate stages are configurable and map to fixed semantic states.
- **Q12:** A sent Estimate's commercial version is immutable; financial changes create a revision.
- **Q13:** One accepted Estimate may produce multiple Invoices.
- **Q14:** Invoice sequences are configurable per Workspace and optionally per seller/legal entity.
- **Q15:** Invoice semantics include `DRAFT`, `ISSUED`, `PARTIALLY_PAID`, `PAID`, controlled `VOID/CANCELLED`; overdue is derived.
- **Q16:** Issued invoice financial/legal snapshot fields are locked; corrections use controlled adjustment/void/reissue/credit mechanisms.
- **Q17:** One Payment can allocate across multiple Invoices.
- **Q18:** Overpayment is recorded in full; excess remains unapplied customer credit until allocated or refunded.
- **Q19:** Full and partial refunds are supported, including multiple refunds up to the refundable amount.
- **Q20:** Recurring rules can create Draft invoices or automatically issue/send them; occurrences are idempotent.

## Round 3 — CRM Forms & Capture
- **Q21:** Published Form versions are immutable; edits create a draft and require republishing.
- **Q22:** Public forms use random public UUID/token references separate from internal database IDs.
- **Q23:** Forms support `PUBLIC`, `AUTHENTICATED`, and restricted/token access modes.
- **Q24:** A form can execute deterministic multi-entity capture recipes.
- **Q25:** Duplicate behavior is configurable per Form and per target entity.
- **Q26:** Assignment policies include fixed user, department/team, round-robin, source rules, existing customer owner and automation.
- **Q27:** Public uploads go through temporary/quarantine storage, validation and scanning before final attachment.
- **Q28:** Consent stores evidence including agreement/version, timestamp and submission/source context.
- **Q29:** Multi-step Forms can optionally save resumable drafts using secure expiring resume tokens.
- **Q30:** Valid final submission is stored first; CRM capture processing then runs asynchronously and retryably.

## Round 4 — Contact Center
- **Q31:** Conversations are session-based; a customer can have several conversations over time on the same channel.
- **Q32:** Identity resolution uses normalized identities and deterministic/confidence rules; ambiguity requires controlled resolution.
- **Q33:** Unknown-customer behavior is configurable: create Contact/Lead, keep temporarily unlinked, or require confirmation.
- **Q34:** Routing supports fixed, round-robin, least-loaded/balanced, broadcast, existing-owner, department/team and rules.
- **Q35:** Agent eligibility considers queue membership, work hours, availability, capacity/concurrency and optional absence state.
- **Q36:** Transfers preserve the same Conversation and full history while recording assignment/transfer history.
- **Q37:** Closed Conversation behavior uses a configurable reopen window.
- **Q38:** SLA supports first response, next response, resolution, work calendars, pause rules, breach events and escalation.
- **Q39:** Assigned agent normally responds; authorized queue/manager users may respond according to permission/channel policy.
- **Q40:** AI enrichment may run automatically, suggested replies may be on-demand, but humans remain responsible for sending.

## Round 5 — Company Details / Requisites / Bank Data
- **Q41:** Requisites belong to CRM Contacts or CRM Companies; seller status/configuration is layered on CRM Companies.
- **Q42:** A Contact/Company can have multiple Requisites with contextual/default selection.
- **Q43:** A Workspace can have multiple seller companies with a Workspace default and optional contextual defaults.
- **Q44:** Requisite schemas use country + entity/person type presets and extensible custom fields.
- **Q45:** Requisites support multiple typed addresses.
- **Q46:** Requisites support multiple bank accounts with optional defaults.
- **Q47:** Bank Data has dedicated view/manage permissions instead of inheriting ordinary Company access.
- **Q48:** Commercial documents snapshot full selected buyer/seller legal identity and relevant address/bank information.
- **Q49:** Master Requisites remain editable after use; historical snapshots remain unchanged.
- **Q50:** Referenced Requisites/Bank records are archived/deactivated rather than destructively deleted.

## Round 6 — Shared implementation contract
- **Q51:** Permissions are action-based with scopes and dedicated sensitive-operation permissions.
- **Q52:** APIs use versioned REST `/api/v1` backed by domain/application services.
- **Q53:** Idempotency is mandatory for high-risk/retry-prone commands and external/provider operations.
- **Q54:** Cross-module side effects use durable domain events/transactional outbox rather than foreign-table writes.
- **Q55:** Important business and sensitive operations are structurally audited.
- **Q56:** Archive/soft lifecycle is the default; hard deletion is limited to safe/unreferenced cases subject to retention.
- **Q57:** Retry policy distinguishes transient from permanent failures and uses visible failed/dead-letter state after exhaustion.
- **Q58:** Public/provider endpoints use layered rate-limit, validation, spam/signature, upload and replay protections.
- **Q59:** Schema changes use new versioned migrations; already-applied production migrations are never rewritten.
- **Q60:** Definition of Done requires unit, integration/service, E2E, tenant/security and concurrency/idempotency tests where applicable.
