# Security, privacy, retention, external MCP

Threat model: cross-tenant UUID enumeration, Partner/Workspace authority confusion, payment webhook forgery, duplicate charges/credits, prompt injection and malicious Tool args, retrieval data exfiltration, PDF/HTML import scripts, OAuth grant theft, broad admin support impersonation, S3 URL leakage, PII in notifications, logged provider keys, distributed cache inconsistency.

Controls: server-only ownership checks, per-action RBAC+resource ACL+entitlement, deny-by-default tool registry, no arbitrary SQL/shell, OAuth PKCE/state and redirect allowlist, scopes bound to external clients, command input schema validation, no client-provided privileged fields, secret-vault references, short-lived signed URLs and tokens, credential redaction, provider verified callbacks, scoped rate limits and audit.

Retention: configure country/category-specific policy before production. Knowledge recycle default 30 days; AI conversations per workspace and classification (no-history optional), published versions/legal holds, billing invoices/credit ledger and Partner payout evidence preserved per applicable law. Employee data and personal tracking from earlier packs must use same shared policy engine. No universal data-retention period invented for legal obligations. Erasure/anonymization uses module hooks and preserves permitted redacted evidence.

Support access: customer-approved or explicitly authorized narrow, expiring grant; global Platform Admin is not carte-blanche tenant reader. Emergency access MFA, reason, post-review and extensive audit. Tenant/Partner delegation revoked promptly, not merely next login. External MCP AI client cannot exploit model suggestions to bypass permission or charge someone else's credits.
