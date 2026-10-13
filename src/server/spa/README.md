# SPA schema, access and transfer behavior

Schema changes remain in the draft until publication. Publication takes the same Type lock as Item mutations and rechecks live values: persisted nulls count as missing required values, tightened scalar validation cannot invalidate existing values, and a staged uniqueness rule is checked again against values written after its initial preview. Migration conversions are included in that final check. A failure rolls back the new version and its audit/outbox effects.

Uniqueness uses one normalization function for schema previews and Item writes. Nullable values are ignored by default; explicit case and null policies are supported. Trashed Items do not reserve live unique keys, but restoration revalidates them before committing. Field deactivation retains historical values and emits both draft-change and field-deactivation evidence.

The confirmed TEAM scope uses published PROJECT relation bindings to non-archived, non-deleted shared Projects or Workgroups. Their owning membership rule recognizes the owner or an ACTIVE member. TEAM intersects current role and Type/Stage scope; Workspace visibility and observer status do not grant TEAM membership. Without a qualifying binding, TEAM denies access. Authentication and worker principal resolution include current Workspace entitlements; a disabled SPA plan denies SPA operations before effects.

Imports commit each row through the owning Item service and keep durable row outcomes across retries. After row processing, Files scans and publishes a private CSV report containing row number, status, Item identity and sanitized error codes. Report identity, totals and terminal job evidence commit together under the current lease. Processing/publication failures retain existing row outcomes; retry does not duplicate Items. Prepared bytes are discarded when publication fails or loses its fence.

Generated immutable artifacts use the supported `<workspace>/objects/artifacts/<id>` storage namespace. Production processing uses the existing `FILE_PROCESSOR_URL` and `FILE_PROCESSOR_TOKEN` configuration. Tests use a deterministic scanner at that external boundary and real private storage/database effects.

Export workers create private Files artifacts using current Item and field permissions. The export-status API withholds the download identity after job expiry. The full review of download authorization/expiry and remaining transfer contracts is tracked in the root implementation record; this checkpoint does not declare the entire SPA module complete.

Focused verification lives in:

- `tests/modules/SPA_Workflows_Inventory_Commerce/Smart-Process-Automation/spa-fields-schema-versions.spec.ts`
- `tests/modules/SPA_Workflows_Inventory_Commerce/Smart-Process-Automation/spa-fields-schema-versions.e2e-spec.ts`
- `tests/spa-team-scope.spec.ts`
- `tests/spa-transfers.spec.ts`
