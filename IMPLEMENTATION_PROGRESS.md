# Remaining implementation progress - Final Modules pack

> Latest user instruction (2026-10-16): remove completed items after each change. Do not commit or push; the user will commit.
> Testing remains deferred by the user. Preserve required verification in `TESTING_REMAINING.md`.
> User will supply credentials later in local `.env`. Missing slots are prepared; live activation remains pending below. Preserve existing values and keys.

Scope: `docs/Logic/TrueCRM_Final_Modules_Codex_Pack/`; dependency order: Platform (30), Billing (31), Partner (32), Knowledge (28), AI (29).
Completed code items and completed check history have been removed. Written behavior remains runtime-unverified; no tests or migrations have been executed for the integration work.

## Remaining blockers

- [!] **Platform MFA:** select/configure an assertion issuer that performs actual MFA and issues `<userId>.<expiresEpoch>.<hmac>` assertions; configure its shared `PLATFORM_MFA_VERIFIER_SECRET`. A signing secret alone does not implement MFA.
- [!] **Billing:** enable the selected Stripe/XPay merchant provider and webhook credentials; supply approved country rates/codes and policy version in `BILLING_TAX_POLICY_JSON`. Renewals remain invoice-based; hosted setup does not enable automatic charging.
- [!] **Knowledge delivery:** select SES/SMTP; configure `NOTIFICATION_EMAIL_PROVIDER`, `NOTIFICATION_EMAIL_SECRET_REF`, `NOTIFICATION_EMAIL_FROM`, the referenced credential, trusted `APP_URL`, and shared `SUITE_DATA_KEY` / `KNOWLEDGE_GUEST_SECRET`. Existing encryption keys must not be replaced without re-encryption planning.
- [!] **AI and semantic retrieval:** select approved provider/model connections, rates, region/classification policies and scenario routes; identify the Workspace and authorized Billing credit grants. Live provider operations require those configurations.
- [!] **Database integration:** identify and authorize the target database/environment before applying pending migrations, including `202610220001_final_module_integrations`. No shared/application database will be reset. Disposable-database migration verification remains deferred with testing.

Remaining work requires filling the environment slots, configuring the existing operator APIs/consoles as documented in README, or authorizing the database target. No credentials, approved prices/taxes, MFA issuer or migration authorization have been supplied yet. Required runtime/UI/provider verification and contract-suite wiring remain in `TESTING_REMAINING.md`; this file must not imply those checks passed.
