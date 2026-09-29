# Import & Export Specification

## Goal

Allow authorized users/integrations to move large datasets into and out of TrueCRM safely, with validation, preview, row-level outcome reporting, provenance, partial success and secure artifacts.

## Import lifecycle

Interactive import:

```text
UPLOAD/FILE REFERENCE
→ PARSING
→ MAPPING_REQUIRED / MAPPED
→ VALIDATING
→ PREVIEW_READY
→ QUEUED
→ RUNNING
→ COMPLETED | COMPLETED_WITH_ERRORS | FAILED | CANCELLED
→ optional SAFE_UNDO
```

Do not write business records before `PREVIEW_READY` and explicit start for normal user-driven imports.

Machine integrations may use an explicitly authorized non-interactive import mode that still performs the same validation and row outcome recording.

## Import job

Suggested fields:

```text
id
workspaceId
entityType
mode CREATE|UPDATE|UPSERT
fileId
fileFormat CSV|XLSX
status
mappingVersion
duplicatePolicy
relationshipPolicy
initiatedByType/userOrServiceId
totalRows
validRows
createdRows
updatedRows
skippedRows
warningRows
errorRows
checkpoint
startedAt
completedAt
correlationId
```

Do not store raw file bytes in the job table; reference the Files service.

## Mapping

Mapping supports:
- system fields,
- eligible custom fields,
- external ID columns,
- relationship reference columns,
- ignored columns,
- optional fixed/default values permitted by source module.

Each mapping entry records source column → target field plus transform/normalizer if explicitly supported.

Reject:
- field not available for target entity,
- hidden/read-only field not writable by actor,
- incompatible data type,
- cross-workspace reference,
- unsupported system/immutable field.

## Import modes

### CREATE
Create new records only under configured duplicate policy.

### UPDATE
Must identify an existing record using an approved stable matching key.

### UPSERT
Resolve existing record; update if found, create if absent, subject to duplicate policy.

Supported matching preference:
1. TrueCRM internal ID where import policy allows it;
2. provider/connection external ID mapping;
3. explicitly selected unique business key;
4. supported communication/duplicate resolution policy.

Never default to fuzzy name matching for destructive updates.

## Duplicate policy

Import must integrate with Data Quality/CRM duplicate resolution rather than implementing a second duplicate engine.

Possible policy enum:

```text
CREATE_ANYWAY
SKIP_DUPLICATE
UPDATE_MATCHED
USE_EXISTING
REQUIRE_REVIEW
```

Automatic merge is not an import-side hidden behavior unless the Data Quality automatic-merge policy explicitly permits it.

## Relationship resolution

For references such as Deal → Contact/Company:
- prefer internal ID or external mapping;
- allow explicitly configured unique field if supported;
- do not silently create missing related records by approximate name;
- row can fail, warn/skip relationship, or queue review according to explicit import policy.

All relationship targets must be in same workspace.

## Preview

Preview must contain:
- target entity,
- selected mode,
- mapping summary,
- row counts,
- predicted create/update/skip/error/warning counts,
- duplicate/conflict summary,
- relationship-resolution summary,
- sample errors/warnings with row number,
- whether import can start.

Preview is derived from the file version and mapping version. If either changes, old preview is invalid.

## Row processing

Each row produces one outcome:

```text
CREATED
UPDATED
SKIPPED
ERROR
WARNING_ONLY
CANCELLED_BEFORE_PROCESS
```

Record:
- source row number,
- stable row fingerprint,
- operation,
- target entity ID if any,
- match reason,
- external ID,
- warnings/errors with stable codes,
- before-change reference/evidence required for safe undo,
- processing timestamp.

One bad row does not roll back successful unrelated rows unless an explicitly supported atomic mode exists for a small import. Default bulk mode is partial success.

## Import provenance

Business record/history should be able to trace meaningful imported mutations to:
- import job,
- row number,
- actor/service,
- timestamp,
- external source ID.

Do not expose provenance to users lacking relevant permissions.

## Cancellation

Cancellation:
- stops claiming new rows at a safe checkpoint;
- does not roll back already committed rows automatically;
- marks remaining rows accordingly;
- is idempotent.

## Safe Undo Import

Undo is available only when server analysis proves reversal is safe.

Examples:
- delete a record created by this import only if no later protected business activity/dependency makes deletion unsafe;
- restore an updated field only if the field has not been changed after the import and restoring does not violate current business rules;
- relation changes require version/dependency checks.

Undo request returns an impact preview.

Unsafe rows are refused and reported; do not promise all-or-nothing reversal.

Suggested status:
```text
UNDO_PREVIEW_READY
UNDO_RUNNING
UNDO_PARTIAL
UNDO_COMPLETED
UNDO_REFUSED
```

## Import APIs

Expected:

```text
POST /api/v1/imports
GET  /api/v1/imports
GET  /api/v1/imports/:id

PUT  /api/v1/imports/:id/mapping
POST /api/v1/imports/:id/validate
GET  /api/v1/imports/:id/preview
POST /api/v1/imports/:id/start
POST /api/v1/imports/:id/cancel

GET  /api/v1/imports/:id/rows
POST /api/v1/imports/:id/undo-preview
POST /api/v1/imports/:id/undo
```

Use `Idempotency-Key` for start/undo side effects.

## Export

Regular entity export accepts:
- entity/resource type,
- source-module filters,
- selected fields,
- output format,
- optional supported related fields explicitly defined by that export adapter.

It does not permit arbitrary joins.

Suggested export states:

```text
QUEUED
RUNNING
READY
FAILED
CANCELLED
EXPIRED
```

### Export security

At export execution:
- re-check actor/service permission,
- enforce source record scope,
- enforce field-level restrictions,
- exclude secrets/internal-only fields.

Generated artifact:
- private object storage,
- default availability 24 hours,
- download requires authorization and/or short-lived signed access generated after authorization,
- artifact expiry deletes/inactivates object according to retention policy,
- job metadata may remain.

### Spreadsheet safety
When producing CSV/XLSX, neutralize spreadsheet formula injection for string values beginning with dangerous formula prefixes according to the platform export policy.

## Export APIs

```text
POST /api/v1/exports
GET  /api/v1/exports
GET  /api/v1/exports/:id
POST /api/v1/exports/:id/cancel
POST /api/v1/exports/:id/download
```

The download endpoint returns/redirects to a short-lived authorized artifact reference; do not publish permanent object URLs.

## Retention

Default:
- export artifact: 24 hours;
- import/export operational metadata: 180 days;
- source import file follows Files/retention policy.

Retention can be lengthened by policy/entitlement; legal hold may block purge.

## Audit

At minimum:
- import started,
- import cancelled,
- import undo executed/refused at meaningful aggregate level,
- export generated,
- sensitive export download if platform policy requires,
- mapping/config changes when reusable mappings are supported.

## Errors

Examples:
- `IMPORT_MAPPING_INVALID`
- `IMPORT_PREVIEW_REQUIRED`
- `IMPORT_ALREADY_STARTED`
- `IMPORT_UNDO_NOT_SAFE`
- `EXPORT_TOO_LARGE`
- `EXPORT_ARTIFACT_EXPIRED`
- `PERMISSION_DENIED`
- `FEATURE_NOT_ENTITLED`

## Acceptance criteria

- CSV and XLSX parse deterministically.
- Interactive import cannot start without current preview.
- Every processed row has one traceable outcome.
- Partial success accurately reconciles totals.
- UPSERT never uses fuzzy name matching implicitly.
- Relationships never link across workspace.
- Duplicate handling delegates to configured policy/Data Quality behavior.
- Cancellation does not duplicate or roll back committed rows unexpectedly.
- Undo refuses records changed afterward or with unsafe dependencies.
- Export omits unauthorized rows and fields.
- Expired artifacts cannot be downloaded.
- CSV/XLSX output is protected against formula injection.
