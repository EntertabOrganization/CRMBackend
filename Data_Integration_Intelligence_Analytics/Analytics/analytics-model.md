# Analytics Data Model, Metric Registry & Freshness Specification

## Goal

Define rebuildable analytical facts/dimensions and centrally governed metrics so dashboards/reports return consistent, historically stable values.

## Ingestion architecture

Preferred pipeline:

```text
domain transaction
→ outbox/domain event
→ analytics consumer
→ idempotent fact/dimension projection
→ aggregate/materialized view refresh
→ permission-aware query
```

Controlled incremental reads/backfills may repair/rebuild when events are unavailable/incomplete.

Analytics mutation endpoints must not become a backdoor to change source business state.

## Facts

Create facts according to real source domains and query needs, for example:
- deal lifecycle/outcomes,
- deal stage transitions/durations,
- activities,
- forms/submissions,
- products/line revenue,
- invoices,
- payments,
- marketing costs,
- attribution allocations,
- data-quality findings/scores,
- integration/import health.

Avoid one giant denormalized "everything" table.

Each fact row should carry:
- workspace key,
- source entity key(s),
- business event dates,
- relevant historical dimension keys,
- numeric measures,
- source version/event ID,
- projection version.

## Dimensions

Likely:
- date/time,
- user,
- department,
- team,
- pipeline,
- stage,
- product/category,
- source,
- campaign,
- currency,
- workspace.

Historical dimensions may use snapshot/surrogate semantics where source reassignment should not rewrite past reporting.

## Deal stage fact

Must support:
- enteredAt,
- exitedAt,
- duration,
- pipeline/stage at that time,
- actor/responsible snapshot as required,
- terminal outcome.

This is essential for stage duration/conversion analytics.

## Currency

Facts with monetary measures store:
- original amount/currency where useful,
- reporting amount/currency,
- historical FX snapshot/version/date.

Use NUMERIC.

Changing today's FX rate does not rewrite old normalized values unless an explicit backfill/version policy is invoked.

## Metric Registry

Suggested model:

```text
metric_definitions
- id
- key
- name
- description
- category
- dataType
- unit

metric_versions
- id
- metricId
- version
- dataset/grain
- formulaDefinition
- eventDateField
- inclusionRules
- exclusionRules
- currencyBasis
- nullPolicy
- parametersSchema
- publishedAt
- status
```

Published metric version is immutable.

New formula semantics require a new version.

## Required initial metric examples

The coding agent should derive exact formulas from source fields but include at least the families required by the PRD:

- Created Leads/Deals
- Won Deals
- Lost Deals
- Win/Conversion Rate
- Won Revenue
- Paid/Collected Revenue
- Average Deal Size
- Sales Cycle Duration
- Stage Duration
- Stage-to-stage conversion
- Activity count/completion/overdue rate
- Invoice totals/balance/payment rate
- Product revenue/quantity
- Marketing cost
- Attributed Won Revenue
- Attributed Paid Revenue
- ROI/ROAS
- Data Quality Score
- Open quality findings
- Import success/error rates
- Integration health/conflict metrics where exposed

Every formula must document denominator, exclusions and zero/null behavior.

## Date semantics

Examples:
- Created Deals → deal `createdAt`.
- Won Revenue → deal won/closed-success timestamp.
- Paid Revenue → payment settlement/allocation timestamp.
- Stage Duration → entry/exit timestamps.
- Activity Completion → completion timestamp.
- Marketing cost → cost period/date.
- Attribution → business outcome date stored on result.

A report may offer alternate supported time dimensions, but metric default remains explicit.

## Freshness

Maintain freshness metadata per projection/dataset:
- last source event/time processed,
- last successful projection,
- lag duration,
- rebuild/backfill state.

Operational target:
- normal CRM analytics generally near realtime, target approximately ≤60 seconds under normal load;
- heavier aggregates/provider imports/backfills may lag several minutes.


Dashboard/report displays meaningful "data updated/freshness" status.

## Idempotency

Each event projection must dedupe by event/source version.

Reprocessing the same event does not double-count facts.

## Rebuild/backfill

Support:
- dataset rebuild,
- date-range backfill,
- metric/materialized-view recalculation,
- attribution projection refresh.

Large operations are checkpointed jobs.

Backfill must not block normal writes indefinitely.

## Analytics APIs

Metadata/operations:

```text
GET /api/v1/analytics/freshness
GET /api/v1/analytics/metrics
GET /api/v1/analytics/metrics/:key
POST /api/v1/analytics/rebuilds
GET /api/v1/analytics/rebuilds/:id
```

Metric-definition administration may be platform-only or authorized admin depending product policy. System metric definitions should not be casually editable by workspace users.

## Permission model

Facts may contain rows beyond a user's scope; query layer must apply authorization filters derived from source-domain access.

Do not rely only on dashboard visibility.

Field-level restricted data must not be emitted into reports unless allowed.

## Acceptance criteria

- Replaying same domain event does not duplicate fact.
- Rebuild produces reconciled totals from authoritative source.
- Metric version is immutable after publication.
- Two dashboards using same metric version return consistent totals for equivalent filters.
- Won and paid revenue use their distinct date/revenue semantics.
- FX history keeps historical numbers stable.
- Freshness indicates lag/rebuild state.
- Unauthorized source rows never appear in query result.
