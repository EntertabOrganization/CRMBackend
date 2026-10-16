# Decision-to-specification traceability — Q77–Q126

**Approved interview decisions:** 50 new decisions in three rounds; **prior decisions:** Q1–Q76 from previous four-module pack remain inherited where shared platform, Commerce, Marketing, HR and Sites contracts intersect. No important open product-scope decisions remained at user confirmation.

| Decision | Locked requirement | Specification (and matching test by same basename) |
|---|---|---|
| Q77 | Partner-specific role catalog on shared permission engine | [`32-Partner-Program/02-partner-memberships-roles-and-permissions.md`](32-Partner-Program/02-partner-memberships-roles-and-permissions.md) |
| Q78 | Discounts stored in integer basis points; deterministic precision | [`32-Partner-Program/03-partner-discounts-and-price-rules.md`](32-Partner-Program/03-partner-discounts-and-price-rules.md) |
| Q79 | Protected global Platform Admin with MFA and separate Workspace permission | [`30-Platform-Services/06-audit-security-history-and-support-access.md`](30-Platform-Services/06-audit-security-history-and-support-access.md) |
| Q80 | Discounted resale and referral commissions | [`32-Partner-Program/07-commissions-and-accrual-ledger.md`](32-Partner-Program/07-commissions-and-accrual-ledger.md) |
| Q81 | Controlled Partner transfer with customer owner and Platform Admin approval | [`32-Partner-Program/06-referrals-attribution-and-transfer.md`](32-Partner-Program/06-referrals-attribution-and-transfer.md) |
| Q82 | Core version/autosave conflict handling; real-time collaboration later | [`28-Knowledge-Base/02-article-editor-and-revisions.md`](28-Knowledge-Base/02-article-editor-and-revisions.md) |
| Q83 | Restricted expiring guest sharing | [`28-Knowledge-Base/03-acl-sharing-and-external-guests.md`](28-Knowledge-Base/03-acl-sharing-and-external-guests.md) |
| Q84 | Draft/publish review configured by Space | [`28-Knowledge-Base/04-review-publish-and-acknowledgement.md`](28-Knowledge-Base/04-review-publish-and-acknowledgement.md) |
| Q85 | OpenAI, Azure OpenAI, Anthropic, Gemini and OpenRouter gateway | [`29-AI-CoPilot/01-provider-connections-and-model-routing.md`](29-AI-CoPilot/01-provider-connections-and-model-routing.md) |
| Q86 | Inference-only by default; classification/provider regional rules | [`29-AI-CoPilot/09-governance-evaluation-and-feedback.md`](29-AI-CoPilot/09-governance-evaluation-and-feedback.md) |
| Q87 | Workspace credits, quotas, cost caps and BYOK | [`31-Subscription-Billing/06-credit-ledger-topups-and-expiration.md`](31-Subscription-Billing/06-credit-ledger-topups-and-expiration.md) |
| Q88 | Redis/BullMQ plus PostgreSQL transactional outbox | [`30-Platform-Services/02-jobs-scheduler-and-retries.md`](30-Platform-Services/02-jobs-scheduler-and-retries.md) |
| Q89 | User preferences with mandatory security/billing notices | [`30-Platform-Services/03-notifications-preferences-and-delivery.md`](30-Platform-Services/03-notifications-preferences-and-delivery.md) |
| Q90 | Admin-configurable immutable plans and entitlements | [`31-Subscription-Billing/01-plan-catalog-and-entitlements.md`](31-Subscription-Billing/01-plan-catalog-and-entitlements.md) |
| Q91 | Stripe and XPay SaaS provider adapters | [`31-Subscription-Billing/04-billing-accounts-invoices-and-provider-payments.md`](31-Subscription-Billing/04-billing-accounts-invoices-and-provider-payments.md) |
| Q92 | Separate plan and purchased credits with expiry and append-only ledger | [`31-Subscription-Billing/06-credit-ledger-topups-and-expiration.md`](31-Subscription-Billing/06-credit-ledger-topups-and-expiration.md) |
| Q93 | 30-day default Knowledge Recycle Bin with legal holds | [`28-Knowledge-Base/07-archive-trash-retention-and-moves.md`](28-Knowledge-Base/07-archive-trash-retention-and-moves.md) |
| Q94 | AI retrieval indexes only approved/published/authorized Knowledge | [`28-Knowledge-Base/05-search-ai-indexing-and-citations.md`](28-Knowledge-Base/05-search-ai-indexing-and-citations.md) |
| Q95 | Safe Markdown/HTML/DOCX import and export | [`28-Knowledge-Base/06-import-export-and-templates.md`](28-Knowledge-Base/06-import-export-and-templates.md) |
| Q96 | No approval for reads; low-risk Allow Once/Always; high-risk every time | [`29-AI-CoPilot/05-tool-registry-approvals-and-actions.md`](29-AI-CoPilot/05-tool-registry-approvals-and-actions.md) |
| Q97 | Fallback only among approved providers/region/classification/cost | [`29-AI-CoPilot/01-provider-connections-and-model-routing.md`](29-AI-CoPilot/01-provider-connections-and-model-routing.md) |
| Q98 | Module/scenario/role/classification AI gating, HR/Billing opt-in | [`29-AI-CoPilot/02-scenarios-prompts-and-assistants.md`](29-AI-CoPilot/02-scenarios-prompts-and-assistants.md) |
| Q99 | Durable in-app/email/push notices with dedupe and retries | [`30-Platform-Services/03-notifications-preferences-and-delivery.md`](30-Platform-Services/03-notifications-preferences-and-delivery.md) |
| Q100 | Bounded backoff/DLQ/manual replay and idempotent workers | [`30-Platform-Services/02-jobs-scheduler-and-retries.md`](30-Platform-Services/02-jobs-scheduler-and-retries.md) |
| Q101 | ACL-aware PostgreSQL-first global search and sensitive data protection | [`30-Platform-Services/05-global-search-recents-and-favorites.md`](30-Platform-Services/05-global-search-recents-and-favorites.md) |
| Q102 | Verified paid upgrade and scheduled checked downgrade | [`31-Subscription-Billing/03-upgrades-downgrades-proration.md`](31-Subscription-Billing/03-upgrades-downgrades-proration.md) |
| Q103 | 14-day configurable anti-abuse trial, no default card | [`31-Subscription-Billing/02-trials-and-subscription-lifecycle.md`](31-Subscription-Billing/02-trials-and-subscription-lifecycle.md) |
| Q104 | Customer-paid or Partner-paid subscription with payer/beneficiary separation | [`31-Subscription-Billing/08-referrals-discounts-and-partner-billing.md`](31-Subscription-Billing/08-referrals-discounts-and-partner-billing.md) |
| Q105 | Fixed/percentage settled-revenue commission and reversal | [`32-Partner-Program/07-commissions-and-accrual-ledger.md`](32-Partner-Program/07-commissions-and-accrual-ledger.md) |
| Q106 | Time-limited explicit customer-authorized delegated Workspace access | [`32-Partner-Program/05-delegated-workspace-access-and-revocation.md`](32-Partner-Program/05-delegated-workspace-access-and-revocation.md) |
| Q107 | Partner suspension blocks privilege, preserves customer/financial records | [`32-Partner-Program/09-suspension-deletion-and-governance.md`](32-Partner-Program/09-suspension-deletion-and-governance.md) |
| Q108 | Partner commercial dashboard only; customer detail requires delegation | [`32-Partner-Program/10-dashboard-admin-and-search.md`](32-Partner-Program/10-dashboard-admin-and-search.md) |
| Q109 | Move Knowledge hierarchies, recompute ACL and links | [`28-Knowledge-Base/01-spaces-and-hierarchy.md`](28-Knowledge-Base/01-spaces-and-hierarchy.md) |
| Q110 | Version-bound employee article acknowledgements | [`28-Knowledge-Base/04-review-publish-and-acknowledgement.md`](28-Knowledge-Base/04-review-publish-and-acknowledgement.md) |
| Q111 | Review cadence/owners/reminders, no automatic deletion | [`28-Knowledge-Base/04-review-publish-and-acknowledgement.md`](28-Knowledge-Base/04-review-publish-and-acknowledgement.md) |
| Q112 | BYOK and platform AI provider connections with tracked token usage | [`29-AI-CoPilot/07-model-usage-costs-and-credits.md`](29-AI-CoPilot/07-model-usage-costs-and-credits.md) |
| Q113 | Classification-dependent AI retention and optional no-history | [`29-AI-CoPilot/03-conversations-messages-and-retention.md`](29-AI-CoPilot/03-conversations-messages-and-retention.md) |
| Q114 | Controlled external OAuth/MCP clients/tools with revocation | [`29-AI-CoPilot/08-external-mcp-and-oauth.md`](29-AI-CoPilot/08-external-mcp-and-oauth.md) |
| Q115 | Async AI run lifecycle and credit reservation settlement | [`29-AI-CoPilot/06-async-runs-and-fallback.md`](29-AI-CoPilot/06-async-runs-and-fallback.md) |
| Q116 | Scoped consented platform support access and separate emergency path | [`30-Platform-Services/06-audit-security-history-and-support-access.md`](30-Platform-Services/06-audit-security-history-and-support-access.md) |
| Q117 | Encrypted PITR-capable backup, restore testing and recovery targets | [`30-Platform-Services/10-observability-backups-and-recovery.md`](30-Platform-Services/10-observability-backups-and-recovery.md) |
| Q118 | Privacy portability, lawful delete/anonymize and legal hold | [`30-Platform-Services/09-retention-portability-and-legal-holds.md`](30-Platform-Services/09-retention-portability-and-legal-holds.md) |
| Q119 | Atomic quota reserve, settle actual and release unused | [`31-Subscription-Billing/05-entitlement-usage-reservations-and-overages.md`](31-Subscription-Billing/05-entitlement-usage-reservations-and-overages.md) |
| Q120 | Plan credits earliest expiry first then purchased credits | [`31-Subscription-Billing/06-credit-ledger-topups-and-expiration.md`](31-Subscription-Billing/06-credit-ledger-topups-and-expiration.md) |
| Q121 | Cancel renewal by default, paid-term access until expiration | [`31-Subscription-Billing/02-trials-and-subscription-lifecycle.md`](31-Subscription-Billing/02-trials-and-subscription-lifecycle.md) |
| Q122 | Block over-limit by default; opt-in capped overage | [`31-Subscription-Billing/05-entitlement-usage-reservations-and-overages.md`](31-Subscription-Billing/05-entitlement-usage-reservations-and-overages.md) |
| Q123 | Detect duplicate Partner applications without auto-merging legal entities | [`32-Partner-Program/01-public-applications-and-approval.md`](32-Partner-Program/01-public-applications-and-approval.md) |
| Q124 | Commission payout after settlement/finance approval and reconciliation | [`32-Partner-Program/08-payouts-finance-approvals-and-reconciliation.md`](32-Partner-Program/08-payouts-finance-approvals-and-reconciliation.md) |
| Q125 | Partner payment failure preserves customer Workspace and allows direct payer transition | [`31-Subscription-Billing/07-dunning-grace-and-service-continuity.md`](31-Subscription-Billing/07-dunning-grace-and-service-continuity.md) |
| Q126 | Referral links/windows/attribution snapshot; one active Partner | [`32-Partner-Program/06-referrals-attribution-and-transfer.md`](32-Partner-Program/06-referrals-attribution-and-transfer.md) |

## Cross-contract coverage

- Q1–Q76 policies inherited from prior pack: separated Orders/CRM deals, provider adapters, inventory idempotency, campaign consent, confidential HR, site publication, 15-day initial grace, tenant-scoped access and configurable retention. This pack does not regenerate previous modules; see `Shared-Contracts/12-source-precedence-and-open-operational-config.md`.
- Q77/Q79/Q106 and Q116 support global Platform Admin vs Partner vs Workspace distinctions: `Shared-Contracts/02-identity-tenancy-and-authorization.md`.
- Q78/Q80/Q87/Q92/Q104/Q105/Q119–Q126 share finance invariants: `Shared-Contracts/06-financial-credit-and-partner-accounting.md` and `14-acceptance-operation-and-negative-case-matrix.md`.
- Q94/Q96/Q98/Q113/Q114: `Shared-Contracts/08-search-knowledge-ai-acl-freshness.md` and `09-security-privacy-retention-and-mcp.md`.

Every spec includes five or more module-specific AC IDs plus shared S01–S04 and tests with the same IDs. `Testing/CrossModule` asserts seam behavior. All rows remain traceable without referring to files absent from the ZIP.
