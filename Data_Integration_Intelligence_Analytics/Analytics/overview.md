# Analytics, Reports & Dashboards — Module Specification

## Goal

Turn TrueCRM operational data into permission-aware, consistent and explainable management information using derived analytical models, a central Metric Registry, semantic report datasets, dashboards, drill-down, KPIs, scheduled reports and controlled BI access.

## Boundary

Analytics owns:
- analytical facts/dimensions/read models,
- metric definitions/versions,
- semantic dataset metadata,
- report definitions,
- dashboard definitions/widgets/layout,
- saved filter presets,
- KPI targets,
- scheduled report definitions/runs,
- analytics freshness metadata,
- BI connector credentials/metadata and approved dataset access.

Analytics does not own:
- CRM/customer mutation,
- invoice/payment truth,
- marketing-touch truth,
- import/export generic infrastructure,
- user permission source of truth.

## Core invariants

1. Transactional modules remain source of truth.
2. Analytics is derived and rebuildable.
3. Same metric key/version produces same formula semantics everywhere.
4. Every metric defines business date basis and currency basis.
5. Historical owner/stage/currency values are snapshotted where later changes would otherwise rewrite history.
6. Dashboard/report access never expands underlying source-module authorization.
7. Heavy queries/backfills/exports run asynchronously or through pre-aggregation.
8. Data freshness/lag is visible.
9. Normal users build reports from approved semantic datasets, not arbitrary production SQL.
10. Built-in dashboards are system-managed; users customize copies/custom dashboards.

## Initial dashboard families

- Executive / Business Overview
- Sales Overview
- Sales Funnel
- Pipeline Performance
- Sales Forecast
- Won/Lost Analysis
- Sales Cycle & Stage Duration
- Sales Rep / Department Performance
- Activities & Communication
- Customer / Lead Analytics
- Product Sales
- Estimates / Invoices / Payments
- Marketing & Attribution
- Data Quality
- Integration/Import Health where approved

## Dependencies

Consumes all relevant domains, especially:
- CRM,
- Pipelines/Stages,
- Activities,
- Products,
- Commercial documents/payments,
- Marketing,
- Data Quality,
- Sales Intelligence,
- Users/Departments/Permissions,
- Currency/time services,
- Jobs/Outbox,
- Files/Export,
- Entitlements.

## Acceptance summary

Finished only when:
- facts/dimensions can rebuild,
- metrics are versioned/reconcilable,
- semantic report builder enforces dataset/permission boundaries,
- filters/drill-down work consistently,
- built-in/custom dashboards render permission-aware values,
- scheduled reports re-check recipient authorization,
- KPI targets are first-class,
- BI access is scoped/revocable/audited,
- heavy reports do not block transactional APIs,
- freshness is measurable/visible.
