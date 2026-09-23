# CRM Core + Pipelines Contract Coverage Audit

This file maps the placeholder scenarios in `CRM_Core_Pipelines/Testing` to executable Jest coverage under `tests/`.

## Pipeline Contracts

| Placeholder contract | Executable evidence |
| --- | --- |
| `intra pipeline transition` | `tests/crm-pipelines.spec.ts` |
| `cross pipeline explicit target` | `tests/crm-pipelines.spec.ts` |
| `transition entity type isolation` | `tests/crm-pipelines.spec.ts` |
| `stage pipeline membership` | `tests/crm-pipelines.spec.ts` |
| `transition graph` | `tests/crm-pipelines.spec.ts` |
| `transition override boundary` | `tests/crm-pipelines.spec.ts`, `tests/crm-stage-permissions.spec.ts` |
| `stage required fields` | `tests/crm-pipelines.spec.ts` |
| `failure lost reason` | `tests/crm-pipelines.spec.ts` |
| `transition atomic side effects` | `tests/crm-pipelines.spec.ts`, `tests/crm-idempotency-concurrency.spec.ts` |
| `stage stable identity` | `tests/crm-pipelines.spec.ts` |
| `default stage invariant` | `tests/crm-pipelines.spec.ts`, `tests/crm-pipeline-migration.spec.ts` |
| `single success stage` | `tests/crm-pipelines.spec.ts` |
| `minimum stage semantics` | `tests/crm-pipelines.spec.ts` |
| `historical stage resolution` | `tests/crm-pipelines.spec.ts`, `tests/crm-pipeline-migration.spec.ts` |
| `stage leave permission` | `tests/crm-stage-permissions.spec.ts` |
| `stage enter permission` | `tests/crm-stage-permissions.spec.ts` |
| `override does not bypass stage permission` | `tests/crm-stage-permissions.spec.ts` |
| `stage permission composition` | `tests/crm-stage-permissions.spec.ts` |
| `separate stage history tables` | Implemented as unified `crmStageHistory` in this repo; covered by `tests/crm-pipelines.spec.ts`, `tests/crm-pipeline-migration.spec.ts` |
| `stage history fields` | `tests/crm-pipelines.spec.ts`, `tests/crm-pipeline-migration.spec.ts` |
| `cross pipeline history` | `tests/crm-pipelines.spec.ts`, `tests/crm-pipeline-migration.spec.ts` |
| `stage history idempotency` | `tests/crm-idempotency-concurrency.spec.ts` |
| `multiple pipeline entity types` | `tests/crm-pipelines.spec.ts` |
| `default pipeline uniqueness` | `tests/crm-pipelines.spec.ts` |
| `pipeline name uniqueness` | `tests/crm-pipelines.spec.ts` |
| `pipeline namespace by entity type` | `tests/crm-pipelines.spec.ts` |
| `pipeline bootstrap` | `tests/crm-pipelines.spec.ts`, `tests/crm-legacy-backfill.spec.ts` |
| `pipeline semantic structure` | `tests/crm-pipelines.spec.ts` |
| `stage migration required` | `tests/crm-pipeline-migration.spec.ts` |
| `pipeline migration all-or-nothing validation` | `tests/crm-pipeline-migration.spec.ts` |
| `pipeline migration history integrity` | `tests/crm-pipeline-migration.spec.ts` |
| `pipeline migration default protection` | `tests/crm-pipeline-migration.spec.ts` |
| `pipeline migration rollback` | `tests/crm-pipeline-migration.spec.ts` |
| `existing workspace pipeline bootstrap` | `tests/crm-legacy-backfill.spec.ts` |
| `legacy empty stage backfill` | `tests/crm-legacy-backfill.spec.ts` |
| `legacy status mapping` | `tests/crm-legacy-backfill.spec.ts` |
| `legacy unknown status safety` | `tests/crm-legacy-backfill.spec.ts` |
| `expand backfill validate enforce` | `tests/crm-legacy-backfill.spec.ts`, `prisma/migrations/*crm*` |
| `failure stage versus lost reason` | `tests/crm-pipelines.spec.ts` |
| `lost reason required` | `tests/crm-pipelines.spec.ts` |
| `lost reason deactivation` | `tests/crm-pipelines.spec.ts` |
| `lost reason historical retention` | `tests/crm-pipelines.spec.ts` |
| `lost reason reopen behavior` | `tests/crm-pipelines.spec.ts` |

## CRM Core Contracts

| Placeholder contract | Executable evidence |
| --- | --- |
| `lead cross-tenant probing protection` | `tests/crm-core.spec.ts`, `tests/crm-leads.spec.ts` |
| `deal cross-tenant probing protection` | `tests/crm-core.spec.ts`, `tests/crm-authorization.spec.ts` |
| `crm cross-workspace foreign key protection` | `tests/crm-core.spec.ts`, `tests/crm-leads.spec.ts` |
| `authorized cursor pagination` | `tests/crm-lifecycle-source.spec.ts` |
| `lead default pipeline and stage` | `tests/crm-leads.spec.ts`, `tests/crm-pipelines.spec.ts` |
| `lead pipeline entity type isolation` | `tests/crm-pipelines.spec.ts` |
| `lead default responsible user` | `tests/crm-leads.spec.ts` |
| `lead commercial and acquisition fields` | `tests/crm-leads.spec.ts`, `tests/crm-lifecycle-source.spec.ts` |
| `returning customer lead` | `tests/crm-leads.spec.ts` |
| `lead success is not conversion` | `tests/crm-leads.spec.ts` |
| `lead optimistic concurrency` | `tests/crm-pipelines.spec.ts`, `tests/crm-idempotency-concurrency.spec.ts` |
| `company workspace distinction` | `tests/crm-core.spec.ts` |
| `company contacts` | `tests/crm-core.spec.ts` |
| `company deals` | `tests/crm-core.spec.ts` |
| `company reference delete protection` | `tests/crm-core.spec.ts` |
| `contact company workspace isolation` | `tests/crm-core.spec.ts` |
| `contact company relation uniqueness` | `tests/crm-idempotency-concurrency.spec.ts`, `tests/crm-core.spec.ts` |
| `deal contact relation uniqueness` | `tests/crm-lifecycle-source.spec.ts` |
| `primary relation replacement` | `tests/crm-core.spec.ts`, `tests/crm-lifecycle-source.spec.ts` |
| `relationship command auditing` | `tests/crm-lifecycle-source.spec.ts`, `tests/crm-idempotency-concurrency.spec.ts` |
| `lead conversion contact only` | `tests/crm-leads.spec.ts` |
| `lead conversion company only` | `tests/crm-leads.spec.ts` |
| `lead conversion mixed outputs` | `tests/crm-leads.spec.ts` |
| `lead conversion duplicate intent` | `tests/crm-leads.spec.ts` |
| `lead conversion atomic rollback` | `tests/crm-leads.spec.ts` |
| `lead conversion history` | `tests/crm-leads.spec.ts` |
| `lead conversion one-time` | `tests/crm-leads.spec.ts` |
| `lead conversion idempotency` | `tests/crm-leads.spec.ts` |
| `contact communications` | `tests/crm-core.spec.ts` |
| `contact company many-to-many` | `tests/crm-core.spec.ts` |
| `contact primary company` | `tests/crm-core.spec.ts` |
| `contact primary replacement` | `tests/crm-core.spec.ts` |
| `contact ownership semantics` | `tests/crm-authorization.spec.ts`, `tests/crm-lifecycle-source.spec.ts` |
| `deal customer required` | `tests/crm-pipelines.spec.ts`, `tests/crm-core.spec.ts` |
| `deal combined customer model` | `tests/crm-core.spec.ts` |
| `deal primary contact` | `tests/crm-core.spec.ts` |
| `deal semantic status` | `tests/crm-pipelines.spec.ts` |
| `deal commercial fields and observers` | `tests/crm-lifecycle-source.spec.ts`, `tests/crm-authorization.spec.ts` |
| `deal sensitive command boundary` | `tests/crm-pipelines.spec.ts` |
| `idempotency key reuse conflict` | `tests/crm-idempotency-concurrency.spec.ts`, `tests/crm-leads.spec.ts` |
| `idempotency tenant isolation` | `tests/crm-idempotency-concurrency.spec.ts` |
| `idempotency retention` | `tests/crm-idempotency-concurrency.spec.ts` |
| `optimistic concurrency` | `tests/crm-idempotency-concurrency.spec.ts`, `tests/crm-pipelines.spec.ts` |
| `crm archive delete separation` | `tests/crm-lifecycle-source.spec.ts` |
| `crm lifecycle restore` | `tests/crm-lifecycle-source.spec.ts` |
| `crm active reference protection` | `tests/crm-lifecycle-source.spec.ts`, `tests/crm-core.spec.ts` |
| `crm hard delete audit retention` | `tests/crm-lifecycle-source.spec.ts` |
| `responsible user offboarding` | `tests/crm-lifecycle-source.spec.ts` |
| `multiple communication values` | `tests/crm-core.spec.ts` |
| `communication primary uniqueness` | `tests/crm-core.spec.ts` |
| `communication workspace isolation` | `tests/crm-core.spec.ts` |
| `communication duplicate normalization` | `tests/crm-core.spec.ts` |
| `cursor response metadata` | `tests/crm-lifecycle-source.spec.ts` |
| `cursor stable ordering` | `tests/crm-lifecycle-source.spec.ts` |
| `crm query whitelist` | `tests/crm-lifecycle-source.spec.ts` |
| `crm query input hardening` | `tests/crm-lifecycle-source.spec.ts` |
| `crm OWN scope` | `tests/crm-authorization.spec.ts` |
| `crm assignment permission` | `tests/crm-authorization.spec.ts`, `tests/crm-idempotency-concurrency.spec.ts` |
| `observer read-only access source` | `tests/crm-authorization.spec.ts` |
| `relationship-derived limited visibility` | `tests/crm-authorization.spec.ts` |

## Verification

Run:

```text
npm.cmd run typecheck
npm.cmd run prisma:validate
npm.cmd test -- --runInBand
```

