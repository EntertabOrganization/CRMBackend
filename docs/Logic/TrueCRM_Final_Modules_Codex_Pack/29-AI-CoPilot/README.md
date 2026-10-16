# 29-AI-CoPilot — module map

One shared AI gateway, scenarios, controlled tool actions, provider routing, conversations, MCP, usage and evaluation.

## Read order

First `../Agent.md`, all `../Shared-Contracts`, then these specs in numbered order:

- [`01-provider-connections-and-model-routing.md`](01-provider-connections-and-model-routing.md) — Provider connections, model catalog and secure routing (Core V1).
- [`02-scenarios-prompts-and-assistants.md`](02-scenarios-prompts-and-assistants.md) — AI scenario registry, prompt versions and assistants (Core V1).
- [`03-conversations-messages-and-retention.md`](03-conversations-messages-and-retention.md) — AI conversations, messages, privacy and retention (Core V1).
- [`04-context-builder-retrieval-and-citations.md`](04-context-builder-retrieval-and-citations.md) — Permission-aware context, RAG and citations (Core V1).
- [`05-tool-registry-approvals-and-actions.md`](05-tool-registry-approvals-and-actions.md) — AI tool registry, approvals and business actions (Core V1).
- [`06-async-runs-and-fallback.md`](06-async-runs-and-fallback.md) — Asynchronous AI runs, retries and cancellation (Core V1).
- [`07-model-usage-costs-and-credits.md`](07-model-usage-costs-and-credits.md) — AI token accounting, BYOK and credit consumption (Core V1).
- [`08-external-mcp-and-oauth.md`](08-external-mcp-and-oauth.md) — External AI clients, OAuth and MCP tool exposure (Advanced after core AI tool safety).
- [`09-governance-evaluation-and-feedback.md`](09-governance-evaluation-and-feedback.md) — AI safety, evaluations, feedback and governance (Core V1).
- [`10-domain-assistance-and-media.md`](10-domain-assistance-and-media.md) — Domain assistants, extraction and media generation (Core V1).

Tests: `../Testing/29-AI-CoPilot`. Dependencies crossing module boundaries are in the contracts, not owned tables.
