# Source precedence, reference handling, operational configuration

Confirmed user decisions Q77–Q126 and prior Q1–Q76 take precedence over source documents; new source files do not silently override them. New project's updated BRD/PRD/System Architecture specify outcomes; existing repo governs technology details only where not contradictory. TrueAgent Auth reference ZIP governs **structural philosophy** and includes existing `Partner/partner.md` model, not authority to copy unrelated Auth details. Previous Commerce/Marketing/HR/Sites ZIP is a contract dependency, not a codebase.

## Must be supplied/configured before production activation, not product design questions

- Real Stripe/XPay merchant connections/webhook trust setup, taxes and currency/region, provider refund entitlement.
- Workspace/provider AI keys or platform-managed accounts, allowed classifications/regions, precise provider model rates and token prices.
- Plan catalog prices and quota values; commission rates and effective dates; Partner application review authority; payout legal payment requirements.
- Jurisdiction-specific retention durations, company privacy notices/legal holds, support emergency policy, production RPO/RTO.
- Existing source repo and migration/CI information. The agent must inspect rather than invent it.

## Values fixed by approved decisions

14-day initial trial, 15-day initial grace, 30-day Knowledge recycle recovery, 0..10000 integer basis points, safe configurable quotas, Workspace/Partner separation, article published revision pinning, high-risk AI confirmation every time, Provider allowlisted routing, credit plan-first expiry ordering, permission-aware search.

## Functional reference provenance

Bitrix24 Helpdesk Knowledge Base 2.0 (Oct 2026): https://helpdesk.bitrix24.com/open/25973127/ and https://helpdesk.bitrix24.com/open/25971079/ . These support feature comparison (spaces, article rights, archive vs recycle), not duplication of Bitrix24 implementation, source code, branding or exact internal APIs. System source: TrueCRM updated Google Docs BRD/PRD/Architecture supplied in Project. No external code copied.
