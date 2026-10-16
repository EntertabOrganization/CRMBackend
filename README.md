# EntertabCRM Backend

Next.js backend for authentication, CRM, automation, catalog, commercial operations, contact center, data integration, sales intelligence, analytics, and the business suite (Online Store, Marketing campaigns, HR & time tracking, Sites & landing pages).

## Repository layout

- `src/`: application and domain modules.
- `app/`: Next.js pages and API route handlers.
- `Script/`: database, seeding, testing, and operational scripts.
- `tests/`: executable tests and shared fixtures; module test packs live in `tests/modules/`.
- `docs/Logic/`: module specifications, decisions, and module `Agent.md` contracts.
- `prisma/`: database schema and migrations.

Read root `AGENTS.md` before working on a module. Jest discovers both `.spec.ts` and `.e2e-spec.ts` files under `tests/`, including preserved contract scenarios that still fail until wired to the implementation.

## Local development on Windows

The backend uses the project-local PostgreSQL 18 cluster under `.local-postgres/data-utf8`. The incomplete Windows service cluster at `D:\Applications\PostgreSql\data` is not modified. PostgreSQL binaries default to `D:\Applications\PostgreSql\bin`; set `POSTGRES_BIN` to use another installation.

Port 3000 belongs to the frontend. The backend always starts on [http://localhost:3001](http://localhost:3001).

```powershell
npm install
npm run db:setup
npm run dev
```

`npm run dev` runs the idempotent database setup automatically. Setup recovers a stopped cluster, verifies stale PID files before removal, snapshots data before recovery, creates the application database, deploys migrations, and seeds the admin role and permissions.

Database lifecycle commands:

```powershell
npm run db:setup
npm run db:start
npm run db:health
npm run db:stop
```

The readiness endpoint is `GET /api/v1/health/ready`. A database outage returns a sanitized `503 DATABASE_UNAVAILABLE` response instead of an unhandled error.

## Validation

```powershell
npm run typecheck
npm run prisma:validate
npm test
npm run test:endpoints
npm run test:endpoints:live
npm run test:all
```

- `test:endpoints` recreates `entertabcrm_test`, deploys migrations, and exercises every Next route handler directly with real persistence.
- `test:endpoints:live` builds and starts Next.js on port 3101, then runs the same endpoint scenarios over HTTP.
- `test:all` runs type checking, Prisma validation, the complete Jest suite, live HTTP endpoint coverage, and a final production build.

The endpoint audit discovers route files automatically, rejects missing coverage, and requires protected routes to be exercised using valid credentials.

Files use a private durable `FILE_OBJECT_ROOT` volume shared by every worker. Configure the scanner/processing provider and schedule the authenticated `upload-processing`, `upload-cleanup` and `file-object-garbage` jobs regularly. Permanent purge commits metadata removal and cleanup intents together; the garbage worker deletes bytes after the last Version reference is removed. Provider configuration, scheduler contracts and retention behavior are documented in [FILES.md](src/server/collab/files/FILES.md).

## Business suite (Online Store, Marketing, HR & Time, Sites)

Specifications: `docs/Logic/TrueCRM_Commerce_Marketing_HR_Sites_Codex_Pack`. Domain code: `src/server/commerce/suite`, `src/server/marketing`, `src/server/hr`, `src/server/sites`, shared kernel/providers in `src/server/suite`.

- Admin consoles: `/commerce`, `/marketing`, `/hr`, `/sites` (workspace sign-in; every action calls the documented REST contract).
- Public surfaces: storefront and customer portal at `/store/<slug>`; published sites at `/s/<path>` resolved by verified host (`?host=` for platform previews).
- Background work runs through `SuiteWorkers` (campaign schedules and delivery, ad audience sync, repeat-sale journeys, HR access revocation and anomaly detection, scheduled site releases).
- External providers use `env:NAME` secret references (see `.env.example`). Only deterministic SANDBOX adapters are exercised by tests; live SES/SMTP/Twilio/WhatsApp/Meta, Google Ads, TLS issuance and the AI gateway require staging credentials.
- Contract suites: `tests/modules/TrueCRM_Commerce_Marketing_HR_Sites_Codex_Pack`, bound to the application by `tests/support/truecrm-contract-adapter.ts` against the owned database `truecrm_suite_contract_test`.

## Final modules (Platform Services, Subscription Billing, Partner Program, Knowledge Base, AI CoPilot)

Specifications: `docs/Logic/TrueCRM_Final_Modules_Codex_Pack`. Domain code: `src/server/platform`, `src/server/billing`, `src/server/partners`, `src/server/knowledge`, `src/server/ai`. Migrations `202610180001_subscription_billing`, `202610190001_partner_program`, `202610200001_knowledge_base`, `202610210001_ai_copilot` and `202610170001_platform_services`.

- Consoles: `/platform` (platform operators and Workspace settings), `/billing`, `/partners`, `/knowledge`, `/ai`.
- Platform-scope access is granted explicitly through `platform_role_assignments` (`node Script/Seeding/GrantPlatformRole.js`), never through Workspace roles. Sensitive platform actions require a step-up MFA assertion verified with `PLATFORM_MFA_VERIFIER_SECRET`; they fail closed when it is unset.
- Durable jobs, consumers and schedules run on PostgreSQL leases. They are registered in `src/server/platform/register.ts` and ticked by `PlatformWorkers` from `SuiteWorkers`.
- Service-to-service endpoints under `/api/v1/internal/{billing,knowledge,ai}` require `INTERNAL_JOB_TOKEN`. Billing provider webhooks are signature-verified at `/api/v1/webhooks/billing/:provider`. External MCP clients use OAuth (PKCE) at `/api/v1/ai/oauth/token` and call `/api/v1/mcp/*`.
- AI usage is charged through Billing credit reservations (`ai.credits`). Provider keys are vault references (`env:NAME`) or sealed BYOK keys. The SANDBOX provider requires `AI_SANDBOX_ENABLED=true` outside production.
- Contract suites: `tests/modules/TrueCRM_Final_Modules_Codex_Pack`. These are fail-closed (`CONTRACT_NOT_WIRED`) until bound to the application. Implementation status is in `IMPLEMENTATION_PROGRESS.md` and the outstanding test work is in `TESTING_REMAINING.md`.

### Final-module integration completion (2026-10-16; runtime tests deferred)

Migration `202610220001_final_module_integrations` adds provider-customer references, transient encrypted AI stream buffers and encrypted external-email delivery records. It has not been applied by the implementation agent. Deploy only through the normal authorized migration process.

- Protected console actions accept a recent MFA assertion per request. The assertion is not persisted in browser storage. Configure the MFA issuer and `PLATFORM_MFA_VERIFIER_SECRET` before using these actions.
- `POST /api/v1/billing/payment-method/change` accepts `{accountId,providerId:"stripe"|"xpay",idempotencyKey}` and returns a provider-hosted setup URL. `POST /api/v1/billing/payment-method/setups/:setupId/refresh` confirms setup by authenticated provider lookup. Customer references are server-owned and Workspace-scoped. These flows never mark invoices paid or enable automatic charges. Setup contracts: [Stripe Checkout](https://docs.stripe.com/api/checkout/sessions/create), [XPay Checkout](https://docs.xpay.app/en/api-reference/checkout-sessions/createCheckoutSession).
- Configure `BILLING_TAX_POLICY_JSON` with an approved version and explicit country rules (`rateBasisPoints`, `taxCode`). This implements flat, exclusive country tax on the discounted/credited quote base, with decimal rounding, immutable quote snapshots and stale-policy rejection. Missing production configuration or a missing country rule fails closed; jurisdiction-specific rates and applicability require operator configuration. Tax is represented on invoices as a separate tax line.
- Sites consent accepts optional `referralCode` from the `ref` query parameter only after marketing consent. Signup accepts optional `{referral:{visitorToken,consent:"ATTRIBUTION"}}`, or uses the consented same-origin Sites cookies. No cross-domain cookie sharing is assumed. New signup clients on another domain must explicitly carry the consented visitor token. Only the hash survives signup; attribution commits with verified Workspace creation and does not grant Partner access.
- Knowledge guest invitations queue encrypted email delivery through Platform jobs. Set `NOTIFICATION_EMAIL_PROVIDER=SES|SMTP`, `NOTIFICATION_EMAIL_SECRET_REF`, `NOTIFICATION_EMAIL_FROM`, `APP_URL`, `SUITE_DATA_KEY` and `KNOWLEDGE_GUEST_SECRET`. Invitation URLs carry the one-time token in the fragment, which the guest page clears immediately. Invitation API responses, outbox events and job payloads contain no token. The public reader is `/knowledge/guest`. Delivery metadata is available at `GET /api/v1/knowledge/articles/:id/guest-invitations/:invitationId/delivery`. Uncertain sends become `UNKNOWN` and require operator reconciliation or a newly issued invitation; they are not blindly resent.
- The editor at `/knowledge/articles/:id/edit` refreshes remote drafts and submits block operations to `POST /api/v1/knowledge/articles/:id/collaborative-edits` with `Idempotency-Key` and `{baseRevisionId,operations}`. Supported operations are `REPLACE` (`blockId`, `block`), `DELETE` (`blockId`), and `INSERT_AFTER` (`blockId|null`, `block`). Independent block changes merge; concurrent changes to the same block return `409 REVISION_CONFLICT`. Every successful command writes an immutable revision, audit and outbox. The UI edits text blocks and adds paragraphs; other block types remain readable through the existing editor contract. Publication still requires review of the exact resulting revision.
- Optional semantic retrieval uses an approved `knowledge.embedding` AI route and model catalog entry with the `embedding` capability. An OPENAI connection supports [embeddings](https://developers.openai.com/api/reference/resources/embeddings/methods/create). Model prices, allowed regions/classifications, Workspace AI settings, access permissions and Billing credits must be configured. Enable the Space AI indexing policy and reindex published articles to queue embeddings. Vectors live in encrypted AI-run outputs referenced by Knowledge chunks; retrieval uses bounded exact cosine ranking (up to 5,000 active chunks) plus FTS and rechecks live ACL, publication and classification. FTS remains available if embeddings are disabled or unavailable. No pgvector extension is required.
- Plain-text runs without retrieval/tools stream through OpenAI-compatible provider adapters. `GET /api/v1/ai/runs/:id/stream` uses bearer and Workspace headers, reauthorizes every snapshot and sends encrypted-buffer snapshots as SSE. The viewer is `/ai/runs/:id`. Tool, JSON, retrieval and no-history runs remain completion-only; raw proposals and invalid JSON are never streamed. Buffers are cleared at completion and stale buffers are cleaned by `ai.stream.cleanup`, respecting legal holds. Provider contract: [Chat streaming](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events).
- Diarization requires an approved `gpt-4o-transcribe-diarize` model route. The adapter requests speaker annotations and stores segments encrypted; transcript reads reauthorize source Files access. Other transcription models reject diarization rather than silently ignoring it. Provider contract: [transcription](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create).

Production type checking uses `tsconfig.build.json` to exclude the independent development/live build route declarations. `npm run typecheck` allows an 8 GiB Node heap for the current Prisma schema. No runtime, provider, migration or UI checks are implied by a successful type check or build.

### Filling the local integration configuration

The local `.env` contains configuration slots matching `.env.example`. Keep real credentials in `.env` (Git ignores it). Existing values must be preserved when adding missing slots. Restart the API and workers after editing configuration.

- Billing: fill the selected provider's `BILLING_STRIPE_*` or `BILLING_XPAY_*` credentials, choose `BILLING_PAYMENT_PROVIDER=STRIPE|XPAY`, and supply the approved `BILLING_TAX_POLICY_JSON` policy. Keep unselected credentials blank.
- Email: choose `NOTIFICATION_EMAIL_PROVIDER=SES|SMTP`, fill the matching `NOTIFICATION_SES_CREDENTIALS` or `NOTIFICATION_SMTP_CREDENTIALS`, and set `NOTIFICATION_EMAIL_SECRET_REF=env:NOTIFICATION_SES_CREDENTIALS` or `env:NOTIFICATION_SMTP_CREDENTIALS`. Configure the verified sender and public `APP_URL` too. The credential formats are documented beside the slots.
- AI: fill only the selected provider's credential slot. Through the existing `/platform/ai` and `/ai` configuration APIs/consoles, create the provider connection referencing that `env:NAME`, versioned model rates/capabilities, approved region/classification routes, Workspace settings and Billing credits. Credentials alone do not create these database records. Knowledge embeddings additionally require the `knowledge.embedding` route and the Space indexing policy.
- MFA: connect an issuer that performs MFA before issuing the supported signed assertion, using the shared `PLATFORM_MFA_VERIFIER_SECRET`. An empty slot leaves protected actions unavailable; the environment file does not supply an issuer.
- Set encryption/signing secrets before using their features. Preserve established keys and the current database URL. In an existing development environment, leave the new `SUITE_DATA_KEY` slot commented until deliberately configured: an empty active value changes the legacy development key derivation. Setting a new key after encrypting data requires re-encryption. Database migrations require separate authorization; adding environment slots does not apply them.

Blank credentials are intentional until configured. Sandbox selections record simulated operations in development; they do not deliver email or call live payment/AI providers.
