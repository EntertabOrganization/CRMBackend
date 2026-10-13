# Attribution Engine Specification

## Goal

Allocate qualifying Deal/revenue outcomes across historical marketing touches using explicit versioned models and a selectable revenue basis.

## Attribution setting

Workspace configuration:

```text
attributionWindowDays default 28
enabledModels
defaultModel
defaultRevenueBasis
timezone
reportingCurrency reference
```

Supported attribution window range should be validated, e.g. 1–365 days, unless platform configuration defines another safe range.

Changing the window affects future/recalculated derived results; it must not mutate raw touches.

## Initial attribution models

Required:

```text
FIRST_TOUCH
LAST_TOUCH
LINEAR
POSITION_BASED
TIME_DECAY
```

### First Touch
100% to earliest qualifying touch.

### Last Touch
100% to latest qualifying touch before the qualifying business outcome.

### Linear
Equal allocation across qualifying touches.

### Position-Based / U-shaped
Default configurable weights may assign larger percentages to first/last and distribute remainder across middle touches. Exact weights must be stored in model-version parameters rather than hard-coded invisibly.

### Time Decay
Weights increase as touches approach the business outcome. Decay function/half-life parameters belong to model version.

## Model definitions and versions

Suggested:

```text
attribution_models
- id
- workspaceId nullable for system model
- code
- name
- isSystem
- status

attribution_model_versions
- id
- modelId
- version
- algorithmCode
- parametersJson
- effectiveFrom
- immutable once used/published
```

A result always references a model version.

If algorithm/weights change, publish new version; do not rewrite what an old version meant.

## Qualifying touches

A touch qualifies if:
- same workspace,
- linked to the relevant customer/Deal under deterministic identity,
- occurred within configured window relative to outcome/date basis,
- source is attribution-eligible,
- not excluded by privacy/quality policy,
- timestamp/order is valid.

Do not include future touches after the business outcome.

Duplicate provider events/touches must be deduplicated before attribution.

## Customer and Deal relationship

Attribution calculation is typically Deal/outcome-centric.

Customer touch history may feed multiple Deals if each Deal's attribution window/outcome makes those touches eligible.

Do not permanently consume a touch after one Deal.

## Revenue bases

Required:

```text
WON_DEAL
PAID_COLLECTED
```

### WON_DEAL
Revenue amount/basis comes from the Deal's won/closed outcome snapshot according to Analytics metric policy.

### PAID_COLLECTED
Revenue comes from successful settled payment allocations/revenue facts linked to the Deal/customer according to commercial-domain rules.

Do not treat pending/failed payment as collected revenue.

## Currency

Attribution calculation stores:
- original outcome currency/value,
- reporting-currency normalized value if required,
- FX source/rate/version/date used.

Use historical/period-specific conversion, not today's rate.

## Result model

Suggested:

```text
attribution_results
- id
- workspaceId
- subjectType DEAL|PAYMENT_OUTCOME etc
- subjectId
- customerId
- modelVersionId
- revenueBasis
- attributionWindowDays
- outcomeAt
- originalRevenue
- originalCurrency
- reportingRevenue
- reportingCurrency
- fxSnapshotRef
- calculationVersion
- calculatedAt
- sourceDataVersion/hash
- status
```

Allocations:

```text
resultId
touchId
sourceId
campaign/ad refs
weight
allocatedOriginalRevenue
allocatedReportingRevenue
```

Weight totals must reconcile to 1 (within decimal tolerance) for results with at least one qualifying touch.

## Source override

Manual acquisition/opportunity source override is not automatically equivalent to adding/removing historical touches.

If product policy allows manual touch creation, it must be explicit (`MANUAL_SOURCE`) and auditable.

## Recalculation

Trigger when:
- Deal becomes won/reopens/changes relevant revenue snapshot,
- payment settles/refunds affecting paid basis,
- identity link changes,
- relevant touch corrected,
- model/settings version changes and authorized backfill requested,
- marketing source mapping corrected where policy permits historical recalculation.

Use background jobs for large recalculation.

A recalculation writes new/current derived result version; preserve old result history where required for audit/explainability rather than mutating model meaning.

## APIs

```text
GET    /api/v1/sales-intelligence/attribution/settings
PATCH  /api/v1/sales-intelligence/attribution/settings

GET    /api/v1/sales-intelligence/attribution/models
POST   /api/v1/sales-intelligence/attribution/models
POST   /api/v1/sales-intelligence/attribution/models/:id/versions

GET    /api/v1/sales-intelligence/attribution/results
GET    /api/v1/sales-intelligence/attribution/results/:id

POST   /api/v1/sales-intelligence/attribution/recalculate
```

Recalculate is permission-controlled, background, idempotent and returns job ID.

## Explainability

Result detail should expose, subject to permission:
- model/version,
- revenue basis,
- window,
- qualifying touches,
- excluded touch reason summary where safe,
- each allocation weight/amount,
- calculation timestamp/freshness.

## Events

Consume:
- CRM Deal created/source changed/won/lost/reopened,
- customer identified/merged,
- payment settled/refunded,
- attribution touch recorded/changed,
- marketing source config change.

Publish:
- `DEAL_ATTRIBUTION_UPDATED`
- `REVENUE_ATTRIBUTION_UPDATED`

## Merge interaction

If CRM customer records merge:
- touches/identity links should rebind/resolve to survivor according to Merge contracts;
- historical attribution result versions remain interpretable;
- recalculation may be scheduled for current reporting views;
- do not collapse Deals.

## Acceptance criteria

- First/Last/Linear calculations produce exact expected weights.
- Position-based weights reconcile to 100%.
- Time-decay parameters are versioned and reproducible.
- Touch outside window is excluded.
- Touch after outcome is excluded.
- Same customer may have different Deal opportunity sources.
- Won and Paid bases produce independently explainable results.
- Paid basis excludes pending/failed payment and adjusts safely for refunds according to metric policy.
- Currency normalization uses historical FX reference.
- Recalculation is idempotent and does not duplicate allocations.
- Historical result can identify model version used.
