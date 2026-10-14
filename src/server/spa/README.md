# SPA schema, access and transfer behavior

Schema changes remain in the draft until publication. Publication takes the same Type lock as Item mutations and rechecks live values: persisted nulls count as missing required values, tightened scalar validation cannot invalidate existing values, and a staged uniqueness rule is checked again against values written after its initial preview. Migration conversions are included in that final check. A failure rolls back the new version and its audit/outbox effects.

Uniqueness uses one normalization function for schema previews and Item writes. Nullable values are ignored by default; explicit case and null policies are supported. Trashed Items do not reserve live unique keys, but restoration revalidates them before committing. Field deactivation retains historical values and emits both draft-change and field-deactivation evidence.

The confirmed TEAM scope uses published PROJECT relation bindings to non-archived, non-deleted shared Projects or Workgroups. Their owning membership rule recognizes the owner or an ACTIVE member. TEAM intersects current role and Type/Stage scope; Workspace visibility and observer status do not grant TEAM membership. Without a qualifying binding, TEAM denies access. Authentication and worker principal resolution include current Workspace entitlements; a disabled SPA plan denies SPA operations before effects.

Imports commit each row through the owning Item service and keep durable row outcomes across retries. After row processing, Files scans and publishes a private CSV report containing row number, status, Item identity and sanitized error codes. Report identity, totals and terminal job evidence commit together under the current lease. Processing/publication failures retain existing row outcomes; retry does not duplicate Items. Prepared bytes are discarded when publication fails or loses its fence.

Generated immutable artifacts use the supported `<workspace>/objects/artifacts/<id>` storage namespace. Production processing uses the existing `FILE_PROCESSOR_URL` and `FILE_PROCESSOR_TOKEN` configuration. Tests use a deterministic scanner at that external boundary and real private storage/database effects.

Export workers create private Files artifacts using current Item and field permissions and retain the exact exported Item identities. Both status and byte delivery recheck the current field, filter and Item scope. Expiry, revoked grants, disabled Workspace SPA entitlement, inactive membership and later Item access changes invalidate cached download paths. Legacy artifacts conservatively recheck their entire original scope.

Files retains immutable object-to-job provenance independently of File metadata. File/folder copies reuse that protected object, so removing the original File cannot remove its authority or expiry. Direct public links, folder public delivery, editor access and template repurposing reject private transfer artifacts. Import reports require current IMPORT authority plus own-job or Workspace-wide job access. Byte reads recheck owning authority after storage I/O; failed delivery leaves the grant unconsumed. The additive `202610140002_spa_file_artifact_authority` migration backfills retained transfer objects and enforces immutable provenance and same-Workspace owners. It must be deployed before using these paths; implementation tests apply it only to disposable databases.

Focused verification lives in:

- `tests/modules/SPA_Workflows_Inventory_Commerce/Smart-Process-Automation/spa-fields-schema-versions.spec.ts`
- `tests/modules/SPA_Workflows_Inventory_Commerce/Smart-Process-Automation/spa-fields-schema-versions.e2e-spec.ts`
- `tests/spa-team-scope.spec.ts`
- `tests/spa-transfers.spec.ts`
