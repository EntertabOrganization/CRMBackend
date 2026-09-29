# Semantic Datasets & Report Builder Specification

## Goal

Allow users to build flexible reports over approved analytical datasets/dimensions/measures without exposing arbitrary production SQL or bypassing permissions.

## Semantic datasets

Initial dataset families should include as available:
- Deals
- Deal Stage History
- Leads
- Contacts/Companies aggregates where privacy allows
- Activities
- Forms/Submissions
- Products/Product Rows
- Estimates
- Invoices
- Payments
- Marketing Costs
- Attribution Touches/Results
- Data Quality
- Integration/Import operational metrics

Each dataset declares:
- stable key/name,
- description,
- grain,
- source projection/fact,
- dimensions,
- measures,
- supported filters,
- supported joins/blends,
- required source permissions,
- field classification/sensitivity,
- default date field.

## Dataset joins/blending

Only predefined semantic relationships are allowed.

Examples:
- Deal ↔ Product Rows
- Deal ↔ Activities
- Campaign ↔ Marketing Costs ↔ Attribution Results
- User ↔ Department dimension

Prevent accidental many-to-many double counting by:
- explicit grain metadata,
- approved join cardinality,
- aggregation rules,
- validation warnings/errors.

Normal users do not submit arbitrary SQL.

## Custom fields

Eligible CRM custom fields flow into dataset metadata if:
- field marked reportable/searchable as appropriate,
- type supported,
- actor authorized,
- field not restricted from reporting.

Type behavior:
- text/list → dimension/filter;
- boolean → dimension/filter;
- date/datetime → time dimension/filter;
- numeric/money → measure and/or dimension according to config;
- user/reference → resolved dimension with permission;
- multi-value → explicit explode/contains semantics, never silently duplicate unrelated measures.

Custom-field schema changes trigger analytics metadata refresh.

## Report definition

Suggested:

```text
id
workspaceId
name
description
datasetKey
metricVersionRefs
selectedDimensions
selectedMeasures
filters
sort
grouping
visualization/tableConfig
ownerUserId
visibility
version
status
```

Keep report definition separate from execution result.

## Filters

Dashboard/report-level filter types:
- date range,
- enum/list,
- user,
- department/team,
- pipeline/stage,
- source/campaign,
- product,
- numeric range,
- boolean,
- supported custom field.

All filters are validated against dataset metadata.

No arbitrary field/operator injection.

## Global vs local filters

For dashboard use:
- global filter applies to compatible widgets;
- widget may define visible local override/additional filter;
- incompatible global filter is ignored only according to explicit compatibility rule and UI should indicate scope.

Report definition may have saved filter presets.

## Drill-down

A metric/table cell may declare a drill target.

Preferred drill:
- open permission-filtered source record list with equivalent business filters;
- or open a detail analytical breakdown if direct source list is not meaningful.

Drill-down never returns raw fact rows containing data the actor could not access from source module.

## Query execution

Report query service:
1. resolve workspace/actor;
2. validate dataset/report access;
3. resolve current source permissions/scopes;
4. compile safe semantic query;
5. apply filters/date/currency context;
6. query materialized/preaggregated facts;
7. return result + metric versions + freshness.

Heavy query:
- use background report execution job where threshold exceeded;
- cache by permission/filter-safe key;
- never share cached result across incompatible permission contexts.

## Saved reports APIs

```text
GET    /api/v1/analytics/reports
POST   /api/v1/analytics/reports
GET    /api/v1/analytics/reports/:id
PUT    /api/v1/analytics/reports/:id
PATCH  /api/v1/analytics/reports/:id
POST   /api/v1/analytics/reports/:id/archive
POST   /api/v1/analytics/reports/:id/run
POST   /api/v1/analytics/reports/:id/export
```

Export delegates artifact generation to shared Export service.

## Visualization

Report builder may support:
- table,
- KPI/single value,
- bar/column,
- line/time series,
- pie/donut where appropriate,
- funnel,
- stacked variants,
- other visualizations supported by frontend chart library.

Specification does not mandate a specific frontend chart package.

## Security

- no arbitrary SQL;
- no production DB credential exposure;
- report definition sharing does not widen data scope;
- output fields obey field permissions;
- filters cannot infer hidden rows via unrestricted counts if source policy forbids aggregation disclosure.

## Acceptance criteria

- Dataset grain/join validation prevents obvious double count.
- Custom fields appear only when reportable and authorized.
- Unsupported filter/operator fails.
- Equivalent filters/metric version reconcile across report/dashboard.
- Drill-down matches the displayed metric result within documented grain semantics.
- Shared report returns different results for users with different source scopes.
- Heavy report runs asynchronously rather than blocking transactional API.
