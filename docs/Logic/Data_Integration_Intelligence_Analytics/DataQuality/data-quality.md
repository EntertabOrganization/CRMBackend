# Data Quality Rules, Findings & Scores Specification

## Goal

Detect incomplete, invalid, inconsistent, stale or otherwise poor-quality CRM data; optionally apply safe normalization; let authorized users resolve/ignore findings; and produce versioned quality scores.

## Rule types

Support:
- system-provided rules,
- workspace administrator-defined rules.

Suggested categories:

```text
COMPLETENESS
VALIDITY
CONSISTENCY
DUPLICATE_RISK
REACHABILITY
STALE_DATA
CUSTOM
```

Suggested severities:

```text
INFO
LOW
MEDIUM
HIGH
CRITICAL
```

Quality severity is informational unless another owning-domain validation rule explicitly blocks a business operation.

## Example built-in rules

- missing email where configured as desirable,
- invalid email format,
- invalid/unreachable phone where validation provider/policy exists,
- missing Contact name,
- missing Company name/domain,
- malformed tax identifier under a country preset,
- duplicate communication value risk,
- missing owner/responsible user,
- missing configured custom field,
- stale/uncontacted record,
- obvious whitespace/casing normalization issue.

Do not hard-code all examples as universally required. System rules must expose applicability/configuration appropriate to entity/workspace.

## Rule model

Suggested fields:

```text
id
workspaceId nullable for global system template
code
name
entityType
category
severity
isSystem
isEnabled
version
conditionDefinition
autoFixPolicy
scopeDefinition
```

Admin-defined rule expressions must use a safe declarative DSL/validated condition model. Never allow arbitrary tenant SQL or executable code.

## Automatic normalization

Allowed automatically when non-destructive, deterministic and approved by rule policy, e.g.:
- trim/collapse whitespace,
- canonical presentation of phone,
- normalized email casing,
- normalized domain presentation.

Do not automatically change:
- business ownership,
- legal/tax identity based on fuzzy guess,
- customer/company name to a different semantic value,
- deal amount/currency,
- substantive custom-field content.

Every automatic change goes through the owning CRM service and produces normal history/audit/event behavior appropriate to that field.

## Findings

Suggested fields:

```text
id
workspaceId
ruleId
ruleVersion
entityType
entityId
status
severity
fingerprint
evidenceJson
detectedAt
lastSeenAt
resolvedAt nullable
resolvedBy nullable
resolutionCode nullable
ignoredUntil nullable
comment nullable
```

Statuses:

```text
OPEN
RESOLVED
IGNORED
STALE
```

Fingerprint prevents duplicate findings for the same rule/entity/evidence version.

If source data changes so the issue no longer applies, mark/close the finding through deterministic reconciliation.

## Resolution and ignore

### Resolve
User confirms the issue was fixed or performs a supported fix.
Server re-evaluates rule before finalizing where practical.

### Ignore
Requires `quality.ignore`.
Store reason/comment and actor.
Ignore may be permanent or have `ignoredUntil` if platform supports temporary ignore.

Rule changes may supersede prior findings rather than mutating their historical meaning.

## Scoring

Provide:
- record-level score,
- entity-level aggregate,
- workspace-level aggregate.

Suggested dimensions:
- completeness,
- validity,
- duplicate risk,
- consistency,
- reachability.

A score result stores:
- score version,
- rule-set version/hash,
- calculatedAt,
- dimension values,
- overall value,
- source/freshness marker.

Score algorithm is centrally versioned.

Do not retroactively change what an old stored score version meant.

## APIs

```text
GET    /api/v1/data-quality/rules
POST   /api/v1/data-quality/rules
GET    /api/v1/data-quality/rules/:id
PATCH  /api/v1/data-quality/rules/:id
POST   /api/v1/data-quality/rules/:id/archive

GET    /api/v1/data-quality/findings
GET    /api/v1/data-quality/findings/:id
POST   /api/v1/data-quality/findings/:id/resolve
POST   /api/v1/data-quality/findings/:id/ignore

GET    /api/v1/data-quality/scores
GET    /api/v1/data-quality/scores/:entityType/:entityId

POST   /api/v1/data-quality/scans
```

List endpoints must support cursor pagination, whitelisted filters and authorization scope.

## Jobs

Quality full scans/recalculations use the shared job system.

Jobs are checkpointable and idempotent.

A rule configuration/version change may enqueue a targeted recalculation rather than recalculating everything synchronously.

## Permissions

```text
quality.read
quality.resolve
quality.ignore
quality.configure
```

Record scope applies to findings/scores.

A user who cannot view the underlying CRM record cannot use Data Quality to infer its protected data.

## Analytics integration

Data Quality publishes derived metrics suitable for the Analytics module:
- open findings count,
- findings by severity/category,
- duplicate-risk rate,
- average quality score,
- completeness trend,
- resolution trend.

Analytics consumes these through events/read models, not direct ownership of Data Quality source tables.

## Audit

Audit:
- rule create/update/archive,
- manual resolve/ignore,
- manual auto-fix override or bulk operation where applicable.

Automatic routine finding detection is operational history, not necessarily one audit row per detection.

## Acceptance criteria

- Rule engine rejects arbitrary SQL/code.
- Same issue does not create duplicate open findings.
- Source fix resolves/reconciles the finding deterministically.
- Ignore is permission-controlled and auditable.
- Safe normalization uses CRM services and cannot cross workspace.
- Score versions are stable/explainable.
- User cannot infer inaccessible CRM records through finding counts/details.
- Large scans run asynchronously and resume safely.
