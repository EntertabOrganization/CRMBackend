# Dashboards Specification

## Goal

Provide upgradeable built-in dashboards and configurable user dashboards composed of permission-aware report widgets and consistent filters.

## Dashboard types

```text
SYSTEM_BUILT_IN
USER_CUSTOM
USER_COPY_OF_BUILT_IN
```

Built-in dashboard definitions are system-managed/versioned.

Editing a built-in should create a customizable copy rather than mutating the system template, unless product UX explicitly supports a non-destructive overlay.

## Suggested dashboard model

```text
dashboards
- id
- workspaceId nullable for global template
- type
- systemTemplateKey nullable
- name
- description
- ownerUserId nullable
- visibility
- status
- layoutVersion
- version

dashboard_widgets
- id
- dashboardId
- widgetType
- reportId or metric/dataset configuration
- position/size
- localFilters
- displayConfig
```

## Initial built-in dashboards

Implement as product templates where underlying source modules exist:

1. Executive / Business Overview
2. Sales Overview
3. Sales Funnel
4. Pipeline Performance
5. Sales Forecast
6. Won/Lost Analysis
7. Sales Cycle & Stage Duration
8. Sales Rep / Department Performance
9. Activities & Communication
10. Customer / Lead Analytics
11. Product Sales
12. Estimates / Invoices / Payments
13. Marketing & Attribution
14. Data Quality
15. Integration / Import Health

If a dependent source module is not implemented in the current repository, the coding agent should implement the dashboard template wiring that is possible without fabricating source data and document the dependency.

## Visibility/share

Dashboard visibility examples:

```text
PRIVATE
SELECTED_USERS
DEPARTMENT
TEAM
WORKSPACE
```

A viewer must pass:
1. dashboard visibility;
2. underlying report/dataset access;
3. source row/field authorization.

A shared dashboard never changes source permissions.

## Filters

Global dashboard filters:
- date range,
- pipeline,
- stage,
- owner,
- department,
- team,
- source,
- campaign,
- product,
- other dataset-compatible fields.

Filter application metadata indicates which widgets accepted/ignored the filter.

Support saved filter presets associated with user/dashboard.

## Widget local filters

Widget can:
- inherit global filter;
- add local restriction;
- use an explicitly documented override where allowed.

UI/API definition must expose local filter so users can explain differences between widgets.

## Freshness

Dashboard response includes:
- latest relevant dataset freshness,
- optionally per-widget freshness if sources differ,
- stale/rebuild indicator.

Do not hide stale analytical state.

## API

```text
GET    /api/v1/analytics/dashboards
POST   /api/v1/analytics/dashboards
GET    /api/v1/analytics/dashboards/:id
PUT    /api/v1/analytics/dashboards/:id
PATCH  /api/v1/analytics/dashboards/:id
POST   /api/v1/analytics/dashboards/:id/archive
POST   /api/v1/analytics/dashboards/:id/copy
POST   /api/v1/analytics/dashboards/:id/run
```

Widget management may be nested.

## Caching

Cache only if key includes all security-relevant context or result is safely row-policy independent.

Permission/version changes must invalidate or bypass stale unauthorized cache.

## Audit

Audit:
- visibility/share changes,
- ownership transfer if supported,
- system-relevant customization changes where policy requires.

Routine layout edits may use normal history rather than immutable audit unless security relevant.

## Acceptance criteria

- Editing built-in cannot corrupt system template.
- User with dashboard visibility but no source permission sees only authorized/empty content.
- Global filters produce consistent compatible widget results.
- Local widget filter is visible in definition/result metadata.
- Freshness is displayed.
- Cached result never leaks another user's broader scope.
- Copy of built-in is independently editable.
