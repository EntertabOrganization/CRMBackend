# EntertabCRM Auth Module — Agent Execution Contract

## Purpose

This file is the operating contract for any AI coding agent working on the EntertabCRM Auth/Identity capability.

The human partner should be able to give a goal such as:

```text
Complete Authentication
Complete Workspace
Complete Department
Complete Authorization
Complete Partner
Complete Audit
Complete the whole Auth Module
```

The agent must then inspect the repository, load the relevant specification files in this pack, implement the requested goal completely, create or adapt executable tests, run them, fix failures, run the full regression suite, and only then report the module as finished.

Do not stop only to present a plan. Planning may happen internally, but execution should continue automatically unless a genuine blocker requires a human decision or unavailable external credential.

---

## 1. Non-negotiable architecture

### Technology direction
- NestJS modular monolith.
- PostgreSQL is the business source of truth.
- Prisma is the ORM/data-access layer unless the repository already proves otherwise.
- Reuse the repository's existing conventions before adding new patterns or dependencies.
- Frontend labels and backend/domain naming use **Workspace**, not Company, for this capability.
- Workspace is the tenant boundary.
- One global User may belong to many Workspaces.
- Every Workspace membership has exactly one Role.
- Every Workspace-scoped request must validate membership server-side.
- Never trust a client-supplied workspace ID without membership and permission validation.
- Partner organization membership is separate from Workspace membership.
- Audit logs are centralized, immutable and retained even after hard deletion of the referenced entity.

### Naming
- TypeScript/Prisma fields: `camelCase`.
- PostgreSQL tables/columns: `snake_case` through Prisma `@map` / `@@map`.
- Primary keys: UUID.
- Soft deletion: `isDeleted` in application code mapped to `is_deleted` in PostgreSQL.
- Do not add generic audit columns in this phase:
  - no `createdAt`
  - no `updatedAt`
  - no `deletedAt`
  - no `createdBy`
  - no `updatedBy`
  - no `deletedBy`
- Functional timestamps are allowed only when the feature requires them, e.g. `expiresAt`, `emailVerifiedAt`, `revokedAt`, `acceptedAt`, and `occurredAt` for audit records.

### API conventions
Base prefix:

```text
/api/v1
```

Successful single-resource response:

```json
{
  "success": true,
  "data": {},
  "meta": null
}
```

Successful Get-All response:

```json
{
  "success": true,
  "data": [],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 0,
    "totalPages": 0
  }
}
```

Error shape:

```json
{
  "success": false,
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "Human-readable explanation.",
    "details": null
  },
  "requestId": "correlation-id"
}
```

Use stable machine-readable error codes.

### PUT vs PATCH
- `PUT` = replace the editable state of the resource and require all required editable fields.
- `PATCH` = update only provided fields.
- Apply this consistently to every module that exposes both methods.

---

## 2. Shared Get-All query contract

Every Get-All endpoint in this capability must support:
- `search`
- pagination
- sorting
- advanced filters

Defaults:
- `page = 1`
- `limit = 20`
- maximum `limit = 100`
- `sortOrder = asc`
- default `sortBy` is module-specific because generic `createdAt` does not exist.

Supported filter operators:
- `eq`
- `neq`
- `in`
- `notIn`
- `contains`
- `startsWith`
- `endsWith`
- `gt`
- `gte`
- `lt`
- `lte`
- `isNull`

Rules:
- Each module explicitly whitelists searchable fields.
- Each module explicitly whitelists filterable fields.
- Each module explicitly whitelists sortable fields.
- Never expose arbitrary Prisma field names from the client.
- Never interpolate raw query strings into SQL.
- Build one reusable query/parser/validation implementation and reuse it.

Suggested shared implementation:

```text
src/modules/auth/shared/query/
├── base-query.dto.ts
├── filter-operator.enum.ts
├── query-parser.service.ts
├── query.types.ts
└── query-validation.util.ts
```

---

## 3. Repository-first execution rules

Before editing:
1. Read this file completely.
2. Read the relevant module specification(s).
3. Inspect `package.json`.
4. Inspect NestJS module structure and naming conventions.
5. Inspect Prisma schema and existing migrations.
6. Inspect guards/decorators/interceptors already used.
7. Inspect existing auth/session patterns.
8. Inspect current testing framework and scripts.
9. Reuse installed dependencies and conventions whenever possible.
10. Identify directly necessary cross-module changes.

Do not invent repository state.

If a repository convention conflicts with this specification:
- Preserve the business/security decisions in this specification.
- Adapt implementation details to the established repository convention where it does not change behavior.
- If the conflict changes a locked business decision, stop and ask the human partner.

---

## 4. Database and migration rules

Before changing schema:
1. Inspect current `schema.prisma`.
2. Inspect all existing migrations relevant to the area.
3. Never rewrite an already-applied migration.
4. Update `schema.prisma`.
5. Generate a new migration.
6. Run Prisma format/validation.
7. Regenerate Prisma Client.
8. Run affected tests.
9. Run full test suite.

Never automatically execute production migrations.

Production migration execution must remain part of the explicit release/deployment process.

---

## 5. Security rules

- Never expose password hashes.
- Never log passwords, raw verification tokens, raw reset tokens, raw refresh tokens, OAuth tokens, secrets, or credentials.
- Use secure password hashing; prefer the repository's existing secure choice. If none exists, use Argon2id.
- Normalize emails using `trim().toLowerCase()`.
- Authentication does not imply authorization.
- Authorization must resolve active Workspace, membership, role, permissions and scope.
- Cross-Workspace access must be rejected even if the caller knows a valid UUID from another Workspace.
- Google OAuth must be verified server-side.
- Email verification, invitation and reset tokens are one-time and stored hashed.
- Refresh tokens are rotatable and revocable; store only secure hashes.
- Owner/Admin is a protected super-role.
- Partner commercial linkage never grants Workspace access by itself.
- Critical state changes and their AuditLog rows must commit atomically.

---

## 6. Soft delete, restore and hard delete

For soft-deletable entities:
- active rows use `isDeleted = false`
- soft delete sets `isDeleted = true`
- normal Get/Get-All operations exclude deleted rows by default
- authorized APIs may explicitly include or query deleted rows
- restore sets `isDeleted = false`
- hard delete is allowed only after soft delete
- hard delete may cascade normal dependent domain rows
- hard delete MUST NOT delete AuditLog history

Department special rule:
- a Department with active child Departments cannot be soft-deleted until children are moved or deleted explicitly.

Role special rule:
- a Role assigned to any active Workspace member cannot be deleted until members are reassigned.

---

## 7. Audit rules

Use one centralized append-only AuditLog model.

No API may:
- update an audit record
- soft-delete an audit record
- hard-delete an audit record

Critical mutation and audit insertion must happen in the same database transaction.

Audit payloads must be sanitized. Never store usable secrets.

AuditLog references must not use destructive cascading foreign keys that remove history.

---

## 8. Testing execution mode

The `Testing/` directory in this pack contains executable TypeScript contract tests. They intentionally fail until wired to the real repository.

For the requested module:
1. Read the matching specification.
2. Read its tests.
3. Move/adapt/wire the tests into the repository's established Jest/Vitest layout as needed.
4. Do not delete, skip, weaken or convert required tests to `todo` merely to obtain green output.
5. Implement the module.
6. Run targeted unit tests.
7. Run integration/database tests.
8. Run API E2E tests.
9. Run authorization-negative tests.
10. Run cross-Workspace isolation tests.
11. Run dynamic-search tests.
12. Run soft-delete/restore/hard-delete tests where applicable.
13. Run the full repository regression suite.
14. Fix failures and repeat until green.

If the repository already uses a testing framework, use it.
If it does not, prefer the standard NestJS Jest + Supertest approach.

External providers:
- Email and Google OAuth must be abstracted behind provider/service interfaces.
- Automated tests use deterministic mocks/fakes.
- Do not claim real delivery or real OAuth redirect testing if only mocks were used.
- If staging credentials exist, report any remaining manual smoke test separately.

---

## 9. Definition of FINISHED

The agent may report:

```text
<Module> — FINISHED
```

only when all applicable conditions are true:

- requested functionality implemented
- repository conventions respected
- Prisma schema validates
- new migration generated/validated if schema changed
- Prisma Client regenerated if required
- TypeScript compilation passes
- lint passes if configured
- unit tests pass
- service/business-rule tests pass
- integration/database tests pass
- API E2E tests pass
- authorization negative tests pass
- cross-Workspace isolation tests pass
- dynamic Get-All tests pass
- soft-delete tests pass
- restore tests pass
- hard-delete/cascade tests pass
- AuditLog tests pass for critical mutations
- full existing repository suite passes
- no known regression remains
- no unrelated refactor is included
- final diff is reviewed for scope

Final report must contain:
1. What was implemented.
2. Database/schema/migration changes.
3. Permission keys added/used.
4. Audit events added.
5. Tests executed and exact results.
6. Manual smoke tests still required.
7. Known limitations or blockers.
8. List of directly necessary cross-module changes.

Never state that functionality was tested if it was not actually exercised.

---

## 10. Git behavior

By default:
- no commit
- no push
- no PR

Only perform those actions when the human partner explicitly requests them.

If a PR is requested, the SuperPowers rules below are mandatory.

---

# [SuperPowers] If You Are an AI Agent

Stop. Read this section before doing anything.

This repo has a 94% PR rejection rate. Almost every rejected PR was submitted by an agent that didn't read or didn't follow these guidelines. The maintainers close slop PRs within hours, often with public comments like "This pull request is slop that's made of lies."

Your job is to protect your human partner from that outcome. Submitting a low-quality PR doesn't help them — it wastes the maintainers' time, burns your human partner's reputation, and the PR will be closed anyway. That is not being helpful. That is being a tool of embarrassment.

Before you open a PR against this repo, you MUST:

Read the entire PR template at .github/PULL_REQUEST_TEMPLATE.md and fill in every section with real, specific answers. Not summaries. Not placeholders.
Search for existing PRs — open AND closed — that address the same problem. If duplicates exist, STOP and tell your human partner. Do not open another duplicate.
Verify this is a real problem. If your human partner asked you to "fix some issues" or "contribute to this repo" without experiencing a specific problem, push back. Ask them what broke, what failed, what the user experience was.
Confirm the change belongs in core. If it's domain-specific, tool-specific, or promotes a third-party project, it belongs in a standalone plugin. Tell your human partner.
Identify yourself. Disclose your model, harness, harness version, and every installed plugin in the PR. Hiding that a contribution is agent-generated — or which environment produced it — is grounds for closing it.
Show your human partner the complete diff and get their explicit approval before submitting.

If any of these checks fail, do not open the PR. Explain to your human partner why it would be rejected and what would need to change. They will thank you for saving them the embarrassment.

Pull Request Requirements

Every PR must fully complete the PR template. No section may be left blank or filled with placeholder text. PRs that skip sections will be closed without review.

Before opening a PR, you MUST search for existing PRs — both open AND closed — that address the same problem or a related area. Reference what you found in the "Existing PRs" section. If a prior PR was closed, explain specifically what is different about your approach and why it should succeed where the previous attempt did not.

PRs that show no evidence of human involvement will be closed. A human must review the complete proposed diff before submission.

Submitters MUST identify themselves. Every PR and issue must disclose the model, harness, harness version, and all installed plugins used to produce the contribution — or state plainly that it was written by hand with no agent. This is not optional. We need to know what produced a change in order to weigh it: agent-generated content reasoned from documentation is held to a different bar than work grounded in a real session. Contributions that hide their authoring environment will be closed.

All PRs MUST target the dev branch, not main. main is the released branch; active work lands on dev first. PRs opened against main will be asked to retarget dev before they are reviewed.

What We Will Not Accept
Third-party dependencies

PRs that add optional or required dependencies on third-party projects will not be accepted unless they are adding support for a new harness (e.g., a new IDE or CLI tool). Superpowers is a zero-dependency plugin by design. If your change requires an external tool or service, it belongs in its own plugin.

"Compliance" changes to skills

Our internal skill philosophy differs from Anthropic's published guidance on writing skills. We have extensively tested and tuned our skill content for real-world agent behavior. PRs that restructure, reword, or reformat skills to "comply" with Anthropic's skills documentation will not be accepted without extensive eval evidence showing the change improves outcomes. The bar for modifying behavior-shaping content is very high.

Project-specific or personal configuration

Skills, hooks, or configuration that only benefit a specific project, team, domain, or workflow do not belong in core. Publish these as a separate plugin.

Bulk or spray-and-pray PRs

Do not trawl the issue tracker and open PRs for multiple issues in a single session. Each PR requires genuine understanding of the problem, investigation of prior attempts, and human review of the complete diff. PRs that are part of an obvious batch — where an agent was pointed at the issue list and told to "fix things" — will be closed. If you want to contribute, pick ONE issue, understand it deeply, and submit quality work.

Speculative or theoretical fixes

Every PR must solve a real problem that someone actually experienced. "My review agent flagged this" or "this could theoretically cause issues" is not a problem statement. If you cannot describe the specific session, error, or user experience that motivated the change, do not submit the PR.

Domain-specific skills

Superpowers core contains general-purpose skills that benefit all users regardless of their project. Skills for specific domains (portfolio building, prediction markets, games), specific tools, or specific workflows belong in their own standalone plugin. Ask yourself: "Would this be useful to someone working on a completely different kind of project?" If not, publish it separately.

Fork-specific changes

If you maintain a fork with customizations, do not open PRs to sync your fork or push fork-specific changes upstream. PRs that rebrand the project, add fork-specific features, or merge fork branches will be closed.

Fabricated content

PRs containing invented claims, fabricated problem descriptions, or hallucinated functionality will be closed immediately. This repo has a 94% PR rejection rate — the maintainers have seen every form of AI slop. They will notice.

Bundled unrelated changes

PRs containing multiple unrelated changes will be closed. Split them into separate PRs.

New Harness Support

If your PR adds support for a new harness (IDE, CLI tool, agent runner), you MUST include a session transcript proving the integration works end-to-end.

A real integration loads the using-superpowers bootstrap at session start. The bootstrap is what causes skills to auto-trigger at the right moments. Without it, the skills are dead weight — present on disk but never invoked.

The acceptance test. Open a clean session in the new harness and send exactly this user message:

Let's make a react todo list

A working integration auto-triggers the brainstorming skill before any code is written. Paste the complete transcript in the PR.

These are not real integrations and will be closed:

Manually copying skill files into the harness
Wrapping with npx skills or similar at-runtime shims
Anything that requires the user to opt in to skills per-session
Anything where brainstorming does not auto-trigger on the acceptance test above

If you are not sure whether your integration loads the bootstrap at session start, it does not.

Skill Changes Require Evaluation

Skills are not prose — they are code that shapes agent behavior. If you modify skill content:

Use superpowers:writing-skills to develop and test changes
Run adversarial pressure testing across multiple sessions
Show before/after eval results in your PR
Do not modify carefully-tuned content (Red Flags tables, rationalization lists, "human partner" language) without evidence the change is an improvement
Eval harness

Skill-behavior evals live in superpowers-evals, cloned into evals/ — see evals/README.md for setup. Drill (the harness) drives real tmux sessions of Claude Code / Codex / Gemini CLI and judges skill compliance with an LLM verifier. Plugin-infrastructure tests still live at tests/.

Understand the Project Before Contributing

Before proposing changes to skill design, workflow philosophy, or architecture, read existing skills and understand the project's design decisions. Superpowers has its own tested philosophy about skill design, agent behavior shaping, and terminology (e.g., "your human partner" is deliberate, not interchangeable with "the user"). Changes that rewrite the project's voice or restructure its approach without understanding why it exists will be rejected.

General
Read .github/PULL_REQUEST_TEMPLATE.md before submitting
One problem per PR
Test on at least one harness and report results in the environment table
Describe the problem you solved, not just what you changed
