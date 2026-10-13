# Import, Export, API & Integrations — Module Specification

## Goal

Provide controlled bulk data movement and external-system connectivity without bypassing TrueCRM's domain validation, authorization, tenant boundaries, audit or business workflows.

## Boundary

This module owns:
- import/export jobs,
- import mapping/row outcomes/provenance,
- generic public API application/credential metadata,
- service/integration identities as defined by the authorization system,
- provider/integration connections,
- external entity mappings,
- sync state/runs/conflicts,
- outgoing webhook subscriptions/deliveries,
- incoming provider-event persistence/verification workflow,
- integration health/operational logs.

It does not own:
- arbitrary writes into CRM/domain tables,
- provider-specific business truth,
- Analytics report definitions,
- user authentication core.

Imports/API/sync must call the normal owning-domain services.

## Supported initial file formats

Import:
- CSV
- XLSX

Export:
- CSV
- XLSX

Analytics module additionally supports report PDF export.

## Core invariants

1. Workspace context comes from trusted authentication/connection metadata, never imported rows/provider payload.
2. API scope never exceeds user/service permission.
3. Long imports/exports/sync/retries are background jobs.
4. Every import row has a deterministic outcome.
5. External mapping is stable and namespaced by provider/connection.
6. Provider events are verified, persisted and processed idempotently.
7. Outgoing webhooks are signed, retryable and replayable where safe.
8. Integration credentials are stored in the secure credential layer.
9. Sync conflicts are visible; unresolved conflicts are never silently overwritten.
10. Provider adapters own provider protocol mapping; domain services own business validation.

## Suggested entities

- `import_jobs`
- `import_rows`
- `import_row_errors`
- `import_mappings`
- `import_undo_records` or equivalent change provenance
- `export_jobs`
- `export_artifacts`
- `api_applications`
- `api_credentials_metadata`
- `integration_connections`
- `integration_mappings`
- `external_entity_links`
- `sync_runs`
- `sync_states`
- `sync_conflicts`
- `webhook_subscriptions`
- `webhook_deliveries`
- `provider_events`
- `integration_health_records`

## Permissions

Suggested families:

```text
import.read
import.create
import.cancel
import.undo

export.read
export.create
export.download

api_app.read
api_app.manage
api_credential.manage

integration.read
integration.manage
integration.sync
integration.conflict.resolve

webhook.read
webhook.manage
webhook.replay
```

Source-module permissions still apply to imported/exported/synchronized records.

## Acceptance summary

This module is not finished until:
- imports preview before normal interactive write,
- row-level partial success/errors are traceable,
- upsert/matching and duplicate policies work deterministically,
- unsafe undo is refused,
- exports contain only authorized fields/rows,
- API v1 enforces scope + permission + rate/idempotency,
- credentials rotate/revoke securely,
- webhooks verify/sign/retry/replay safely,
- sync mappings/checkpoints/conflicts work,
- operational support can inspect failures without secret leakage,
- targeted and cross-module tests pass.
