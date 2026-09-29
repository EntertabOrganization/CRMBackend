# KPI Targets, Scheduled Reports & BI Access Specification

## Goal

Provide first-class targets, safe scheduled report delivery and controlled external BI access over approved analytical datasets.

## KPI target

A KPI target is a business object, not just chart decoration.

Suggested fields:

```text
id
workspaceId
metricKey
metricVersionRef or compatible metric policy
periodType
periodStart
periodEnd
targetValue
currency nullable
subjectType WORKSPACE|USER|DEPARTMENT|TEAM|PIPELINE|SOURCE
subjectId nullable
ownerUserId
notes nullable
status
```

Validation:
- target unit compatible with metric;
- target currency required for monetary metric when needed;
- subject belongs to workspace;
- period valid/non-overlapping only if business rule requires uniqueness.

Dashboard may compute achievement:

```text
actual / target
```

with documented zero/null handling.

## KPI APIs

```text
GET    /api/v1/analytics/kpi-targets
POST   /api/v1/analytics/kpi-targets
GET    /api/v1/analytics/kpi-targets/:id
PATCH  /api/v1/analytics/kpi-targets/:id
POST   /api/v1/analytics/kpi-targets/:id/archive
```

## Scheduled reports

Schedule definition:

```text
id
workspaceId
reportId/dashboardId
ownerUserId
scheduleDefinition
timezone
deliveryChannels
recipientDefinitions
format/linkMode
filtersSnapshot/config
status
```

Use platform scheduler, not process-local timers.

### Delivery channels

Initial:
- in-app notification/link,
- email secure link,
- generated CSV,
- XLSX,
- PDF where report supports.

Future integration destinations should use Module 14 adapter/webhook framework rather than custom direct code in Analytics.

## Authorization at execution/delivery

Do not assume permission from schedule creation remains forever.

At execution:
- validate schedule owner/service execution policy;
- validate report still exists/active;
- generate using current permitted data according to chosen schedule authorization model.

At delivery:
- recipient must be authorized to receive the result.
- if recipient lost access, omit/refuse that delivery and record stable error.
- never email a broad artifact generated under admin scope to a user who lacks that scope.

Recommended safe model: generate recipient-specific or access-token-scoped result unless the recipients share an explicitly authorized service/reporting principal policy.

## Scheduled run

Record:
- schedule ID,
- execution time,
- status,
- effective filters,
- report/dashboard version,
- recipients attempted/succeeded/denied,
- artifact IDs,
- error summary,
- freshness.

Retries must not duplicate emails/artifacts uncontrollably; use delivery idempotency.

## Analytics export

Formats:
- CSV
- XLSX
- PDF

Use shared Export infrastructure for artifact storage/expiry.

Export requires explicit permission separate from view if the platform permission model supports it.

## BI access layer

External tools such as Power BI/Looker Studio connect through a controlled analytics endpoint/connector over approved datasets.

Never give customers direct production PostgreSQL credentials.

BI credential metadata:

```text
id
workspaceId
name
principal/serviceIdentityId
secretRef
allowedDatasets
status
expiresAt nullable
lastUsedAt
createdBy
```

Raw secret shown once at creation/rotation.

## BI query contract

The implementation may use REST/query connector/streaming format appropriate to repository architecture, but it must:
- expose dataset metadata/schema;
- scope every query to workspace;
- enforce allowed datasets;
- enforce current permissions/policy;
- impose row/query/rate limits;
- support revocation;
- audit credential lifecycle;
- log usage without secrets.

If BI tool requires a service principal with broader reporting scope, that scope must be explicit/administratively granted and not inferred from dashboard sharing.

## APIs

```text
GET/POST/PATCH /api/v1/analytics/schedules...
GET /api/v1/analytics/schedule-runs...
POST /api/v1/analytics/schedules/:id/run-now

GET/POST /api/v1/analytics/bi-credentials
POST /api/v1/analytics/bi-credentials/:id/rotate
POST /api/v1/analytics/bi-credentials/:id/revoke

GET /api/v1/analytics/bi/datasets
... connector/query endpoints according to implementation
```

## Entitlements

Scheduled reports and BI access may be entitlement-controlled.

Do not hard-code plan names.

## Audit

Audit:
- KPI create/update/archive,
- schedule create/update/disable,
- report-sharing/delivery-policy changes,
- BI credential create/rotate/revoke.

## Acceptance criteria

- Target remains reusable across multiple dashboards.
- Achievement uses same metric semantics as report.
- Schedule executes in configured timezone correctly.
- Recipient who loses permission does not receive protected report data.
- Retry does not duplicate delivery uncontrollably.
- CSV/XLSX/PDF artifacts use secure export storage/expiry.
- BI credential is workspace-scoped, revocable and never exposes production DB credentials.
- BI query cannot request an unapproved dataset or cross workspace.
