# TrueCRM Modules 13–16 — Codex/Claude Specification Pack

This pack is an implementation contract for four TrueCRM modules:

1. Duplicates, Merge & Data Quality
2. Import, Export, API & Integrations
3. Sales Intelligence & Attribution
4. Analytics, Reports & Dashboards

It is designed to be copied into the TrueCRM repository and given directly to Codex, Claude Code, or another coding agent.

## Start here

The coding agent must read:

```text
Agent.md
```

before changing code.

Then give it a goal such as:

```text
Complete Data Quality
Complete Import and Export
Complete API and Integrations
Complete Sales Intelligence
Complete Analytics
Complete Modules 13-16
```

The agent is required to inspect the real repository, load the matching specification and executable test contracts, implement the goal, run/fix targeted tests, run the full regression suite, and report FINISHED only when the definition of done in `Agent.md` is satisfied.

## Important implementation principle

The pack defines product behavior and implementation boundaries but does not assume an ORM or invent repository state. Existing repository conventions should be reused unless they conflict with a confirmed business/security decision.

Bitrix24 is used as the primary product-behavior reference, while TrueCRM's approved BRD/PRD/System Architecture and the confirmed design decisions are authoritative for TrueCRM.

## Specification organization

```text
Agent.md
README.md
manifest.json
Sources/
Coverage/
DataQuality/
Integrations/
SalesIntelligence/
Analytics/
CrossModule/
tests/modules/Data_Integration_Intelligence_Analytics/
```

### DataQuality
Duplicate detection, merge safety, exclusions, normalization, quality rules/findings/scores.

### Integrations
CSV/XLSX import, export, public REST API conventions, credentials/apps, webhooks, provider connections, mappings, synchronization and conflict handling.

### SalesIntelligence
Source registry, visitor/session tracking, UTM/referrer resolution, tracking links/numbers/emails, marketing-cost ingestion and multi-model revenue attribution.

### Analytics
Derived facts/dimensions, Metric Registry, semantic datasets, report builder, dashboards, drill-down, KPIs, scheduled reports, exports and BI access.

### CrossModule
Shared event/job/idempotency/security/audit/retention contracts and dependencies among the four modules.

## Testing

The files under `tests/modules/Data_Integration_Intelligence_Analytics/` are intentionally executable contract scaffolds that fail until a coding agent wires them to the actual repository. They must not be skipped or deleted merely to obtain a green test run.

The expected flow is:

```text
read specification
→ inspect repository
→ wire contract tests
→ implement
→ run targeted tests
→ fix
→ run full regression suite
→ review diff
→ report FINISHED
```

## Implementing one module

Read:
1. `Agent.md`
2. the module's `overview.md`
3. every sub-specification named in `manifest.json`
4. matching `tests/modules/Data_Integration_Intelligence_Analytics/<Module>/...` files
5. relevant files under `CrossModule/`

Then execute the implementation completely.

## Implementing all four modules

Read the entire pack before coding because the modules intentionally interlock:

```text
Data Quality ↔ Import/API
Import/Integrations → CRM/domain services
Tracking/Attribution → Analytics
All four → Audit/Jobs/Permissions/Entitlements
```

Do not implement duplicate local infrastructure where the platform already provides jobs, outbox, files, audit, authorization, notifications, secret storage or entitlements.

