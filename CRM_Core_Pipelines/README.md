# TrueCRM CRM Core + Pipelines — Codex Pack

This pack is designed to be copied into the TrueCRM backend repository and used directly by Codex or another coding agent.

It covers:

- **Module 03 — CRM Core Records**
- **Module 04 — Pipelines & Stages**

The pack intentionally follows the same repository-first, specification-plus-contract-tests approach as the earlier Auth Module Codex Pack.

## Start here

The coding agent must read:

```text
Agent.md
```

before doing any work.

Then give it a goal, for example:

```text
Complete CRM Core
Complete Leads
Complete Contacts
Complete CRM Companies
Complete Deals
Complete Lead Conversion
Complete Pipelines
Complete Stages
Complete CRM Core + Pipelines
```

The agent is instructed to:

- inspect the real repository before editing anything
- inspect the existing Prisma schema and applied migrations
- load the matching specification files in this pack
- preserve tenant isolation and existing repository conventions
- implement the requested goal completely
- create/adapt/wire the executable contract tests
- run targeted tests and the full regression suite
- never weaken tests merely to obtain green output
- never execute production migrations automatically
- only report `FINISHED` when the full acceptance gate in `Agent.md` passes

## Important product decisions encoded here

This pack is authoritative for Modules 03 and 04 when it intentionally differs from older TrueCRM documents.

Notable decisions include:

- Leads **and** Deals support multiple pipelines.
- Lead and Deal pipelines are isolated by pipeline `entityType`.
- Lead stage success does not automatically convert the Lead.
- Lead conversion is an explicit atomic command.
- Deals can have one Company plus multiple Contacts, with one primary Contact when Contacts exist.
- Contact ↔ CRM Company is many-to-many, with relationship-specific job title/department.
- CRM communications support PHONE, EMAIL, WEB and IM.
- Sensitive actions use dedicated command endpoints rather than ordinary PATCH.
- CRM lists use cursor pagination, not the page/limit contract from the previous Auth pack.
- Archive and soft delete are separate lifecycle operations.
- Cross-Workspace UUID probing must not reveal resource existence.
- Optimistic concurrency and idempotency are part of the public backend contract.
- Pipeline/stage history is preserved; destructive configuration changes use deactivation/migration.

## Pack structure

```text
Agent.md
README.md
manifest.json

CRM-Core/
  lead.md
  contact.md
  crm-company.md
  deal.md
  communications.md
  relationships.md
  lead-conversion.md
  crm-source.md
  crm-lifecycle.md

Pipelines/
  pipeline.md
  stage.md
  transition.md
  stage-history.md
  lost-reason.md
  pipeline-migration.md

Testing/
  README.md
  CRM-Core/...
  Pipelines/...
```

The `.spec.ts` and `.e2e-spec.ts` files under `Testing/` are intentionally failing contract tests until they are wired to the real repository. They must not be skipped, deleted, weakened, or converted to `todo` merely to claim completion.
