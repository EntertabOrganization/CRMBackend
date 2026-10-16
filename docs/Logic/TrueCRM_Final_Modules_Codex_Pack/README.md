# TrueCRM Final Modules — Codex/Claude implementation pack

**Scope:** 28 Knowledge Base, 29 AI & CoPilot, 30 Platform Services, 31 Subscription & Billing, 32 Partner Program. Built from the user's approved Shared Understanding Report and decisions Q77–Q126, inheriting shared Q1–Q76. Source-backed, implementation-oriented, no application code provided.

## Start here

1. Agent MUST read **`Agent.md`** completely before doing any work.
2. Inspect real Next.js/NestJS repository and current schema/migrations; note dependencies already present.
3. Read all `Shared-Contracts/*.md` then the targeted module `README.md` and its specifications.
4. Wire the intentionally fail-closed TypeScript tests to real repository fixtures; implement backend/frontend/services/data, run migrations and tests, and show exact execution evidence.
5. For complete project use order **30 -> 31 -> 32 -> 28 -> 29**, integrating with preexisting Auth/Workspace/CRM/Files/Workflow and previous Commerce/Marketing/HR/Sites pack.

## Sample coding-agent instructions

`Complete 30-Platform-Services` — implement all Platform specifications and matching tests, retaining existing platform services.

`Complete 32-Partner-Program` — implement all Partner specifications and tests without creating Workspace ownership or implicit membership.

`Complete the whole final pack` — follow Agent.md, implement all 5 modules in dependency order, run targeted and full regression, report blockers honestly.

## Inventory

- 48 detailed functional Markdown specifications across 5 modules, each with logical entities, API/DTO operations, transitions, validations, explicit access, audit, recovery and testable ACs.
- 14 shared cross-module contracts, role-specific `Agents` instructions, decision trace, README and manifest.
- Test harness plus one `.spec.ts` per specification, one `.e2e-spec.ts` per module, and cross-module E2E matrix. Tests fail until wired to actual application; do not skip/delete.

## Source boundaries

TrueCRM updated BRD/PRD/Architecture are sources for WHAT; earlier Authentication reference ZIP's `Partner/partner.md` is precedent, not duplicate implementation; earlier four-module ZIP is integrated by seam contracts only. The Bitrix24 API/helpdesk are capability references, not source for database internals. No repository was supplied; actual paths/ORM/CI are determined by coding agent by inspection.

## Testing instructions

See `Testing/README.md` and `Testing/_harness/`. The harness checks a repository adapter has executed assertions; this alone is not proof that tests have been wired correctly—QA agent must review adapters and execution evidence against actual DB/API observations. E2E cannot pass using mock-only adaptors. Treat contract failures as unfinished work. Do not report green tests that were not executed.
