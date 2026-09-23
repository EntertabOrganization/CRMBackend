# CRM Core + Pipelines Test Scenario Matrix

Status legend:

- `PASSING` means an executable Jest test currently covers the scenario.
- `PARTIAL` means related tests exist, but the full contract scenario still needs deeper coverage.
- `TODO` means the placeholder contract scenario still needs to be wired.

## CRM Core Records

| Area | Scenario | Status | Executable coverage |
| --- | --- | --- | --- |
| Leads | Default pipeline/stage, responsible user, metadata, existing customer links | PASSING | `tests/crm-leads.spec.ts` |
| Leads | SUCCESS stage does not convert lead | PASSING | `tests/crm-leads.spec.ts` |
| Leads | Duplicate communication detection and force-create path | PASSING | `tests/crm-leads.spec.ts`, `tests/crm-core.spec.ts` |
| Contacts | Multiple communications and one primary per type | PASSING | `tests/crm-core.spec.ts` |
| Contacts | Contact-company many-to-many with primary replacement | PASSING | `tests/crm-core.spec.ts` |
| Companies | CRM Company distinct from Workspace, communications, protected delete | PASSING | `tests/crm-core.spec.ts` |
| Deals | Customer required, company plus multiple contacts, primary contact | PASSING | `tests/crm-core.spec.ts`, `tests/crm-pipelines.spec.ts` |
| Relationships | Cross-workspace relationship IDs hidden as not found | PASSING | `tests/crm-core.spec.ts` |
| Sources | Source catalog, deactivation, inactive source rejection | PASSING | `tests/crm-lifecycle-source.spec.ts` |
| Lifecycle | Archive/restore/soft delete separation | PASSING | `tests/crm-lifecycle-source.spec.ts` |
| Lifecycle | Hard delete audit retention and offboarding responsibility | PASSING | `tests/crm-lifecycle-source.spec.ts` |
| Authorization | OWN scope, assignment permission, observer read-only access | PASSING | `tests/crm-authorization.spec.ts` |
| Visibility | Relationship-derived limited customer summary | PASSING | `tests/crm-authorization.spec.ts` |
| Lead conversion | Contact/company/deal outputs, one-time conversion, atomic rollback, idempotent replay | PASSING | `tests/crm-leads.spec.ts` |
| Cursor queries | Stable cursor metadata, whitelisted sort/filter/search | PASSING | `tests/crm-lifecycle-source.spec.ts` |
| Idempotency | Create, conversion, transition, assignment, relationship replay and key reuse conflict | PASSING | `tests/crm-leads.spec.ts`, `tests/crm-idempotency-concurrency.spec.ts` |

## Pipelines And Stages

| Area | Scenario | Status | Executable coverage |
| --- | --- | --- | --- |
| Bootstrap | Default lead/deal pipelines and stage semantics | PASSING | `tests/crm-pipelines.spec.ts` |
| Pipeline invariants | Multiple pipelines, default uniqueness, case-insensitive names, entity namespace | PASSING | `tests/crm-pipelines.spec.ts` |
| Stage invariants | Default PROGRESS, exactly one SUCCESS, min PROGRESS/FAILURE | PASSING | `tests/crm-pipelines.spec.ts` |
| Transitions | Intra-pipeline and cross-pipeline explicit transitions | PASSING | `tests/crm-pipelines.spec.ts` |
| Transitions | Entity type isolation and target-stage membership | PASSING | `tests/crm-pipelines.spec.ts` |
| Transitions | Transition graph and override boundary | PASSING | `tests/crm-pipelines.spec.ts`, `tests/crm-stage-permissions.spec.ts` |
| Transitions | Required-field resolver boundary | PASSING | `tests/crm-pipelines.spec.ts` |
| Lost reasons | Required on FAILURE, retained historically, cleared on reopen | PASSING | `tests/crm-pipelines.spec.ts`, `tests/crm-lifecycle-source.spec.ts` |
| Stage permissions | View/enter/leave role policy and override does not bypass policy | PASSING | `tests/crm-stage-permissions.spec.ts` |
| Stage history | Creation, transition, cross-pipeline movement history | PASSING | `tests/crm-pipelines.spec.ts`, `tests/crm-pipeline-migration.spec.ts` |
| Stage migration | Stage deactivation requires replacement and migrates current records | PASSING | `tests/crm-pipeline-migration.spec.ts` |
| Pipeline migration | All-or-nothing stage mapping, default protection, history integrity | PASSING | `tests/crm-pipeline-migration.spec.ts` |
| Legacy backfill | Bootstrap existing workspaces, explicit unknown legacy mapping safety | PASSING | `tests/crm-legacy-backfill.spec.ts` |

## Current Verification Commands

```text
npm.cmd run typecheck
npm.cmd test -- --runInBand
```

