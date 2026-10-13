# CRM Merge Specification

## Goal

Safely merge multiple same-type Lead, Contact or Company records into one surviving CRM record while preserving valid relationships, stable history, auditability and redirects.

## Terminology

- **Source records**: all records selected for merge.
- **Survivor**: record that remains addressable as the active CRM record.
- **Merged-away record**: source record retired by merge.
- **Field decision**: chosen resulting value for one field.
- **Relation rebind**: moving a mutable relationship to the survivor.
- **Redirect**: lookup mapping from old merged ID to survivor for supported internal/API behavior.
- **Snapshot**: immutable evidence of source state at merge time.

## Eligibility

Merge is allowed only when:
- all records belong to same workspace;
- all records have same supported entity type;
- actor has `duplicate.merge`;
- actor has required CRM update/delete/merge rights over every source;
- records are active/mergeable under CRM lifecycle policy;
- no incompatible merge/transition lock exists;
- source versions still equal versions used for preview.

Reject cross-type merge even if duplicate detector produced an identity warning.

Lead Conversion remains separate.

## Automatic merge policy

Automatic merge may run only when:
- candidate evidence meets an exact/strong rule explicitly marked auto-merge eligible;
- no meaningful field conflict remains unresolved;
- relationship rebind is safe;
- no source contains protected conflicting state requiring review;
- service identity is explicitly authorized for automatic cleanup.

Default survivor for automatic merge: oldest/original stable record ID according to creation/source ordering available in CRM.

Fuzzy-only matches cannot auto-merge.

## Manual merge preview

`POST /api/v1/data-quality/merges/preview`

Conceptual request:

```json
{
  "entityType": "CONTACT",
  "sourceIds": ["uuid-a", "uuid-b"],
  "preferredSurvivorId": "uuid-a"
}
```

Preview response must include:
- source summary,
- proposed survivor,
- source version tokens,
- field conflicts,
- multi-value unions,
- relationships to rebind by type/count,
- protected/immutable references that will not be rewritten,
- warnings,
- required decisions,
- whether operation is currently executable.

Preview performs no source mutation.

## Field-decision rules

### Scalar fields
If only one non-empty value exists, use it.
If values normalize equal, preserve survivor display value unless policy chooses better canonical formatting.
If meaningful conflict exists, manual merge requires an explicit decision unless the configured safe policy defines it.

### Multi-value communication fields
Preserve all distinct valid normalized values.

Example:
- source A phone P1/email E1
- source B phone P2/email E2
→ survivor contains P1, P2, E1, E2 without normalized duplicates.

### Ownership/responsibility
Do not silently combine multiple owners.
Default to survivor owner unless manual policy/decision changes it and actor has permission.

### Custom fields
Use field metadata/type to determine equality/union behavior.
Hidden/restricted fields must not be displayed to actors lacking field access; such a record may make manual merge unavailable to that actor.

## Relation-rebind matrix

The coding agent must inspect actual CRM relationships and implement a matrix. At minimum:

### Rebind to survivor where mutable and valid
- Deal customer/contact/company relationships,
- activities and activity bindings,
- CRM Form submission bindings,
- customer communication/conversation identity bindings,
- file attachments that reference the customer entity,
- tags/segments where domain semantics support rebinding,
- external entity links when uniqueness permits,
- timeline projection source links only through owning service/projector policy.

### Do not merge/rewrite underlying business object
- Deal itself,
- Invoice,
- Payment,
- Estimate,
- issued/generated document snapshot,
- historical legal/requisite snapshot,
- immutable provider transaction,
- audit record.

### Requisites
Requisites remain separate records unless the Requisites module itself exposes an explicit merge/selection operation. A customer merge may rebind ownership/reference according to Requisites domain rules but must not collapse distinct requisites automatically.

## Transaction

Execution should use the owning CRM/domain services inside one controlled transaction as far as local relational changes permit.

Required sequence:
1. load source records and version tokens;
2. acquire deterministic locks/version checks;
3. re-authorize current actor;
4. revalidate same workspace/type;
5. recompute/validate preview decisions;
6. update survivor fields;
7. rebind supported relationships;
8. retire/mark merged-away sources according to CRM merge lifecycle;
9. create merge operation/source/field/relation evidence;
10. create redirects;
11. create audit evidence;
12. write outbox event(s);
13. commit;
14. downstream refresh search/duplicate/analytics projections asynchronously.

If any required local mutation fails, rollback the merge transaction.

## Merge evidence

Suggested operation fields:

```text
id
workspaceId
entityType
survivorId
mode MANUAL|AUTOMATIC
status
actorType/userOrServiceId
previewHash
startedAt
completedAt
correlationId
```

Store:
- every source ID and source version,
- sanitized source snapshots needed for investigation,
- field decisions,
- relation-rebind before/after IDs,
- warnings/override decisions,
- errors if failed.

Never store reusable secrets.

## Redirect behavior

`crm_merge_redirects` concept:

```text
workspaceId
entityType
oldEntityId
survivorEntityId
mergeOperationId
createdAt
```

Rules:
- internal record lookup may resolve old IDs to survivor if the endpoint supports redirects;
- API behavior must be documented and deterministic;
- avoid redirect loops by flattening chains to the current survivor;
- a merged ID must never redirect across workspace/type;
- redirects are retained with merge evidence.

## Recovery / undo

V1 does not provide a universal `unmerge`.

An administrative recovery tool may be implemented later using merge evidence only when safe.

This pack requires:
- complete evidence,
- ability to inspect the operation,
- no promise that subsequent business activity can be automatically separated.

If an `/undo` capability is added, it must refuse when post-merge state makes reversal unsafe and return `MERGE_NOT_REVERSIBLE`.

## Concurrent changes

Preview becomes stale if a source version changes.

Execution must fail with `MERGE_CONCURRENT_MODIFICATION` or equivalent rather than applying old decisions to new data.

Concurrent merge attempts involving overlapping records must serialize or one must fail/retry safely.

## APIs

Expected:

```text
POST /api/v1/data-quality/merges/preview
POST /api/v1/data-quality/merges
GET  /api/v1/data-quality/merges
GET  /api/v1/data-quality/merges/:id
```

Execution request references preview/version decisions:

```json
{
  "entityType": "CONTACT",
  "sourceIds": ["uuid-a", "uuid-b"],
  "survivorId": "uuid-a",
  "sourceVersions": {
    "uuid-a": "version-token-a",
    "uuid-b": "version-token-b"
  },
  "fieldDecisions": [
    {
      "field": "jobTitle",
      "sourceId": "uuid-b"
    }
  ]
}
```

Server recomputes safety; it never trusts preview output blindly.

## Audit events

At minimum:
- `CRM_MERGE.PREVIEW_CONFIRMED` where useful,
- `CRM_MERGE.EXECUTED`,
- `CRM_MERGE.AUTO_EXECUTED`,
- future recovery actions if any.

Audit contains IDs/decision summary, not sensitive unrestricted snapshots.

## Errors

Expected:
- `MERGE_TYPE_MISMATCH`
- `MERGE_PERMISSION_DENIED`
- `MERGE_GROUP_STALE`
- `MERGE_CONCURRENT_MODIFICATION`
- `RESOURCE_CONFLICT`
- `VALIDATION_FAILED`

## Acceptance criteria

- Cross-type or cross-workspace merge fails.
- Manual merge preview exposes all required decisions the user is authorized to see.
- Automatic merge refuses conflicting/fuzzy-only candidates.
- Multi-value communications preserve distinct valid values.
- Related Deals are rebound but never collapsed.
- Historical invoice/payment/document values are unchanged.
- Failed relation update rolls back local merge state.
- Old supported IDs resolve through a non-looping redirect.
- Overlapping concurrent merges cannot corrupt records.
- Merge operation is reconstructable from evidence/audit without relying on logs.
