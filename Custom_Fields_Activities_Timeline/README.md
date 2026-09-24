# TrueCRM Custom Fields + Activities & Timeline — Codex Pack

This pack is an implementation-ready specification for two connected TrueCRM capabilities:

1. **Custom & Required Fields**
2. **Activities & Timeline**

It is designed to be copied into a repository and handed to Codex, Claude Code, or another autonomous coding agent.

## Start here

The coding agent must read:

```text
Agent.md
```

first.

Then it must inspect the real repository before changing anything.

Example goals:

```text
Complete Custom & Required Fields
Complete Activities & Timeline
Complete the entire TrueCRM Custom Fields + Activities pack
```

## What this pack locks

The pack locks the agreed business behavior for:

- generic metadata-driven custom fields;
- supported field types and typed storage;
- custom-field validation, options, defaults and lifecycle;
- field visibility/edit permissions and external exposure;
- global, stage/pipeline and conditional required fields;
- field-capable entity registration;
- Activity model, types, lifecycle, permissions and custom types;
- CRM multi-bindings and communication participants;
- reminders and overdue processing;
- specialist adapters for Calendar, Tasks, Communication and Files;
- Timeline projection, comments, filtering, deduplication and snapshots;
- API contracts, idempotency, concurrency, domain events and realtime;
- frontend administration and CRM/global Activities surfaces;
- testing and definition of done.

## Source basis

The specification was derived from:

- `TrueCRM - Product Requirements Document (PRD)` — especially sections 05 and 06 plus related pipeline, permissions and platform sections;
- `TrueCRM - Business Requirements Document (BRD)` — especially sections 05 and 06;
- `TrueCRM - System Architecture Document - Complete` — especially sections 02, 05, 06 and 30;
- official Bitrix24 API documentation referenced by the project source (`https://apidocs.bitrix24.com/`) as behavioral inspiration for configurable fields, activities, bindings and timeline comments;
- the supplied reference Codex Pack for structural and testing philosophy only;
- the confirmed 90-question design interview, recorded in `Decision-Register.md`.

TrueCRM decisions always override Bitrix behavior.

## Specification organization

```text
Agent.md
README.md
manifest.json
Decision-Register.md

Custom-Required-Fields/
├── overview.md
├── field-definitions.md
├── field-types-values.md
├── validation-options-lifecycle.md
├── permissions-exposure.md
├── required-fields.md
├── api.md
└── frontend.md

Activities-Timeline/
├── overview.md
├── activity-model.md
├── activity-types-adapters.md
├── bindings-communications-reminders.md
├── lifecycle-permissions.md
├── timeline.md
├── api.md
└── frontend.md

Shared/
├── data-model.md
├── authorization-security.md
├── errors-idempotency-concurrency.md
├── domain-events-realtime.md
├── migrations-retention.md
└── requirement-traceability.md

Testing/
├── README.md
├── coverage-matrix.md
├── Custom-Required-Fields/
├── Activities-Timeline/
└── Frontend/
```

## Implementing one module

For example, to implement Custom & Required Fields:

1. Read `Agent.md`.
2. Read every Markdown file in `Custom-Required-Fields/`.
3. Read applicable `Shared/` files.
4. Read the matching contracts under `Testing/Custom-Required-Fields/` and `Testing/Frontend/`.
5. Inspect the existing CRM Core, Permissions, Pipelines, Search, Files and event/outbox contracts in the repository.
6. Implement repository adaptations without changing the locked behavior.
7. Wire tests and run targeted + regression suites.

For Activities & Timeline, follow the same process and inspect Calendar, Tasks, Communication, Files, Notifications, Automation and Platform Events before implementing specialist adapters.

## Implementing the entire pack

Implement dependency-safe foundations first:

```text
Shared contracts/security/events
        ↓
Custom field schema/types/values
        ↓
Required-field resolver
        ↓
CRM entity integration + frontend field rendering
        ↓
Activity core/types/bindings/reminders
        ↓
Specialist adapters
        ↓
Timeline projection/comments
        ↓
Frontend Activities/Timeline
        ↓
Realtime + full regression tests
```

Do not implement cross-module writes by directly updating another module's tables.

## Testing expectations

The `.spec.ts` / `.e2e-spec.ts` files under `Testing/` are intentionally failing contract tests until they are wired to the real implementation. They are not placeholders to delete.

The final implementation must cover:

- happy paths;
- invalid input;
- custom-field type validation;
- conditional requirement logic;
- hidden/read-only fields;
- authorization and tenant isolation;
- schema concurrency;
- field migration/deactivation;
- Activity state transitions;
- multi-binding disclosure rules;
- reminders/overdue behavior;
- provider idempotency;
- Timeline ordering/deduplication/rebuild behavior;
- soft delete/restore;
- realtime duplicate prevention;
- frontend permission and validation behavior;
- integration-adapter failures and safe retries.

## Important scope boundary

This pack does not re-specify the full CRM Core, Pipelines, Calendar, Tasks, Contact Center/Communication, Files, Automation, Notifications or Audit modules. It defines the contracts these two capabilities require from them. The coding agent must integrate with those modules rather than cloning them.
