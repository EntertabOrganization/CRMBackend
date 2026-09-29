# Duplicate Detection Specification

## Goal

Detect likely duplicate Leads, Contacts and Companies using deterministic normalization, configurable rule evidence and limited fuzzy matching, while keeping detection separate from merge.

## Supported entities

Default built-in entity types:

```text
LEAD
CONTACT
COMPANY
```

Do not treat `DEAL` as a duplicate-customer entity.

Future Smart Process/entity support must be opt-in through an explicit duplicate capability/rule adapter.

## Normalization profiles

Normalization produces comparison keys; it does not silently rewrite visible CRM values except where the separately approved non-destructive normalization policy explicitly does so.

### Phone
- trim whitespace;
- remove formatting characters;
- normalize country/local format using the platform's phone/country configuration where available;
- preserve extension separately if supported;
- reject/flag impossible values according to phone validation policy;
- duplicate comparison should ignore presentation differences.

### Email
- trim;
- lowercase the domain and, by default, the complete address for duplicate-key comparison;
- validate syntactic form;
- do not invent provider-specific alias collapsing unless explicitly configured.

### Name / company name
- Unicode normalize;
- trim/collapse repeated whitespace;
- case-fold for comparison;
- optional punctuation/legal-suffix normalization for company matching;
- retain original display value.

### Domain
- lowercase;
- strip scheme;
- strip trailing slash/path where a domain field is expected;
- optionally normalize leading `www.` according to rule configuration.

### Tax/registration identifiers
- trim/case-normalize and apply country-specific normalization only through explicit preset/adapter rules.
- never use fuzzy matching for legal/tax IDs.

### External IDs
- provider/source namespace + external ID must be considered together.
- do not compare unrelated provider namespaces as equal.

## Duplicate rule model

Suggested fields:

```text
id
workspaceId
name
entityType
code
isSystem
isEnabled
matchMode
autoMergeEligible
priority
version
created/changed metadata according to repository conventions
```

A rule has one or more conditions/evidence clauses.

Suggested condition fields:

```text
fieldCode
normalizer
operator
weight
required
fuzzyThreshold nullable
```

### Match tiers

The engine exposes evidence tiers:

```text
EXACT
STRONG
PROBABLE
FUZZY
```

Examples:

- EXACT: same normalized phone/email/tax ID/external ID.
- STRONG: exact name + exact phone, or exact company domain + strong company name.
- PROBABLE: company/domain/name combination with sufficient evidence.
- FUZZY: similar names or company names.

A candidate result must contain:
- rule ID/version,
- evidence tier,
- score/confidence,
- evidence items,
- source record IDs,
- evaluated timestamp/source version.

Fuzzy-only evidence is never sufficient for automatic merge.

## Default matching fields

### Lead
- normalized phone,
- normalized email,
- name,
- company name,
- external IDs,
- eligible custom fields.

### Contact
- normalized phone,
- normalized email,
- name,
- external IDs,
- eligible custom fields.

### Company
- normalized phone,
- normalized email,
- company name,
- normalized domain,
- tax/registration IDs,
- external IDs,
- eligible custom fields.

Administrators with `duplicate.configure` can enable/configure eligible fields and weights. System-protected rules may be non-deletable but can expose supported settings.

## Custom fields

A custom field may participate only if:
- the Custom Field definition marks it eligible for duplicate/search use,
- its type has a deterministic normalizer/comparator,
- the actor configuring the rule can access the field,
- it does not expose restricted data to users who cannot view the field.

Reference fields and multi-value fields require explicit comparator behavior.

## Duplicate key storage

Suggested conceptual row:

```text
id
workspaceId
entityType
entityId
fieldCode
normalizedValueHash / normalizedValue
normalizerVersion
sourceFieldVersion
```

Security rule:
- if a normalized value is sensitive, prefer a keyed hash plus separately protected diagnostic representation rather than exposing it in logs.

Unique/index strategy should support:
- workspace + entity type + field + normalized key lookup,
- entity key replacement when record fields change.

## Realtime candidate processing

On relevant CRM create/update:
1. validate workspace/entity;
2. compute affected keys;
3. upsert/remove stale keys;
4. look up matching keys/rules;
5. calculate candidate evidence;
6. respect active exclusions;
7. create/update candidate/group;
8. emit derived event after commit.

This processing may be synchronous for cheap exact checks and queue heavier fuzzy/group recomputation.

## Candidate/group model

A candidate pair must have deterministic ordering so the same pair is not stored twice.

Suggested candidate fields:

```text
workspaceId
entityType
leftEntityId
rightEntityId
ruleId
ruleVersion
tier
score
status
evidenceJson
firstDetectedAt
lastDetectedAt
```

Candidate statuses:

```text
OPEN
EXCLUDED
MERGED
STALE
RESOLVED
```

Group is a derived convenience around connected candidate pairs. Group rebuilding must not lose pair-level evidence.

## Cross-type identity warnings

The system may compare a Lead to existing Contact/Company identity evidence.

Output:
- "possible existing customer" warning,
- matched record ID/type,
- reason/evidence subject to permission.

Rules:
- no cross-type merge;
- no automatic conversion;
- user may invoke normal Lead Conversion flow if authorized;
- if the matched Contact/Company is outside actor scope, do not leak inaccessible fields or existence beyond what platform policy permits.

## Exclusions — Not a duplicate

Endpoint behavior creates an auditable pair exclusion.

Suggested fields:

```text
workspaceId
entityType
leftEntityId
rightEntityId
ruleId nullable
reasonCode
comment nullable
createdBy
createdAt
leftIdentityVersion
rightIdentityVersion
```

An exclusion suppresses the same materially equivalent pair.

If relevant identity fields change enough that the identity version changes, the engine may create a new candidate and mark the old exclusion superseded/stale rather than silently ignoring new evidence forever.

Users can remove an exclusion only with permission.

## Scan jobs

Supported scan modes:

```text
FULL
ENTITY_TYPE
RECORD_SET
RULE
```

Manual and scheduled full scans use background jobs with checkpoints.

Default policy may schedule daily full/reconciliation scans, but workspace settings may disable/change the schedule subject to entitlement/platform policy.

A scan result records:
- processed count,
- candidate count,
- groups created/updated,
- exclusions respected,
- errors,
- checkpoint,
- completion status.

Retries must not duplicate candidates.

## APIs

Use repository naming conventions. Expected capabilities:

```text
GET    /api/v1/data-quality/duplicate-rules
POST   /api/v1/data-quality/duplicate-rules
GET    /api/v1/data-quality/duplicate-rules/:id
PATCH  /api/v1/data-quality/duplicate-rules/:id
POST   /api/v1/data-quality/duplicate-rules/:id/archive

POST   /api/v1/data-quality/duplicate-scans
GET    /api/v1/data-quality/duplicate-scans
GET    /api/v1/data-quality/duplicate-scans/:id
POST   /api/v1/data-quality/duplicate-scans/:id/cancel

GET    /api/v1/data-quality/duplicates
GET    /api/v1/data-quality/duplicate-groups/:id

POST   /api/v1/data-quality/duplicate-exclusions
DELETE /api/v1/data-quality/duplicate-exclusions/:id
```

### Example scan request

```json
{
  "entityType": "CONTACT",
  "mode": "ENTITY_TYPE",
  "ruleIds": null
}
```

Response should return the job resource, not hold the HTTP request until completion.

## Validation

Reject:
- unsupported entity type,
- rule referencing inaccessible/unsupported field,
- cross-workspace entity IDs,
- self-pair exclusions,
- duplicate exclusion pair rows,
- fuzzy threshold outside allowed range,
- exact legal-ID rule configured as fuzzy.

## Audit

Audit:
- rule created/updated/archived,
- scan manually started/cancelled where operationally meaningful,
- exclusion created/removed.

Automatic candidate creation is operational history/event data, not necessarily one central audit record per candidate unless platform audit policy requires it.

## Acceptance criteria

- Phone/email presentation differences detect the same identity where normalization permits.
- Same normalized key in another workspace never becomes a candidate.
- Deal records are not treated as duplicate customers.
- Fuzzy name-only evidence cannot trigger automatic merge.
- Candidate explains rule/evidence without leaking restricted fields.
- Cross-type warning never becomes a cross-type merge.
- Excluded pair stays suppressed until exclusion removed or identity materially changes.
- Full scan can restart from checkpoint without duplicating candidates.
- Candidate/group state converges after source-record identity fields are changed.
