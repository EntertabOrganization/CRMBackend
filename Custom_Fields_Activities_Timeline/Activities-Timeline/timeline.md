# Timeline Projection and Comments

## Goal

Provide a unified, permission-aware chronological history for CRM records while keeping the original domain modules authoritative.

## Timeline entry model

Suggested logical fields:

```text
id UUID
workspaceId UUID
entityType
entityId UUID
category
sourceType
sourceId string/UUID
sourceEventId string/UUID
sourceVersion nullable
occurredAt timestamptz
actorType USER | SERVICE | SYSTEM | PROVIDER
actorUserId nullable
actorDisplaySnapshot nullable/sanitized
summaryCode/templateKey
summaryTextSnapshot nullable
presentationSnapshot JSONB validated/sanitized
correlationId nullable
projectionVersion integer
createdAt
```

Unique dedupe constraint should include a stable source event identity sufficient to prevent duplicate projection, for example:

```text
(workspace_id, entity_type, entity_id, source_event_id, projection_kind)
```

Choose the exact key to support one source event intentionally projecting to multiple bound CRM records without collision.

## Categories

Recommended stable categories:

```text
ACTIVITY
COMMUNICATION
CRM_CHANGE
STAGE_CHANGE
DOCUMENT
AUTOMATION
COMMERCIAL
PAYMENT
FORM
COMMENT
SYSTEM
```

The source module/event registry may extend categories; keep them stable for filtering.

## What belongs in Timeline

Meaningful business context, including examples:

- CRM record created/converted/merged summary where source module publishes it;
- stage changed;
- responsible user changed;
- Activity planned/rescheduled/reassigned/completed/cancelled/reopened;
- email/call/message interaction;
- document generated/sent where relevant;
- Estimate/Invoice/Payment events when those modules publish them;
- selected Automation outcomes;
- user Timeline comments.

Do not project infrastructure noise such as:

- cache invalidation;
- search reindex completion;
- internal retry attempt;
- sort-order changes unrelated to customer history;
- every field mutation by default.

## Presentation snapshot

Timeline stores only enough immutable/safe display information to remain readable if source changes.

Example stage change:

```json
{
  "fromStage": {"id": "s1", "name": "Qualification"},
  "toStage": {"id": "s2", "name": "Proposal"}
}
```

Example Activity completion:

```json
{
  "activityType": "CALL",
  "subject": "Follow up on proposal",
  "responsibleDisplayName": "Ahmed",
  "resultSummary": "Customer requested revised pricing"
}
```

Do not copy the entire Deal/Contact/Activity object into Timeline.

Sensitive values must be sanitized according to the actor/source module's projection policy.

## Projection process

```text
source domain transaction + outbox
→ event bus/worker
→ TimelineProjector receives durable event
→ determine CRM bindings/target entities
→ build sanitized presentation snapshot
→ upsert/insert with stable dedupe key
→ emit TIMELINE_ENTRY_PROJECTED/realtime hint
```

Projector retries must be idempotent.

## Multiple bindings

One Activity event may project into each bound CRM record's Timeline.

Each projection has independent entity target but shares source event identity/correlation.

If a binding is later removed:

- historical Timeline entry should normally remain on the record if it truthfully represented history at that time;
- do not rewrite past history merely because current binding changed;
- a specific move/rebinding business rule may add a new Timeline event instead.

## Permission at read time

Timeline is a derived cache/read model and cannot become an authorization bypass.

On read:

- authorize the CRM record itself;
- require `TIMELINE.READ`/applicable permission;
- apply current access restrictions to sensitive linked source details;
- do not disclose unauthorized binding/entity names from snapshots;
- snapshots must be designed to avoid storing secrets that cannot safely be filtered later.

If a user's permission changes, old cached Timeline results must not remain accessible through the API.

## Ordering

Primary: `occurredAt`.

Tie-break using stable `id`/sequence so pagination is deterministic.

Cursor must encode enough ordering state to avoid duplicates/gaps during forward pagination.

The API may choose newest-first for UI convenience while preserving deterministic semantics.

## Timeline comments

User comments are a user-authored Timeline object, not an Activity source-of-truth record.

Suggested model:

```text
id UUID
workspaceId
entityType
entityId
linkedActivityId nullable
authorUserId
body rich-text-safe/string
isDeleted/deletedAt
version
createdAt
updatedAt
```

Comment attachments use shared File references. Mentions use a normalized mention child table/reference.

## Comment create

Requirements:

- authorize target CRM record;
- require `TIMELINE.COMMENT`;
- body cannot be empty after normalization unless product explicitly supports file-only comments; this pack recommends allowing file-only only if frontend/Files conventions already support it safely, otherwise require text;
- validate file access;
- validate mention users within workspace and access policy;
- write comment + audit/outbox atomically;
- Notification consumes mention event.

## Comment update

- require `TIMELINE.COMMENT_EDIT` and ownership/scope policy;
- optimistic version check;
- preserve audit before/after summary;
- update files through attachment references without duplicating binaries;
- realtime refresh after commit.

## Comment delete

Soft delete only through normal API.

- require `TIMELINE.COMMENT_DELETE`;
- preserve audit;
- UI displays deleted state according to product policy rather than raw removed content;
- do not delete shared file binary solely because comment binding is removed.

## Mentions

- `@mention` parsing should resolve stable user IDs, not only free-text names;
- only mention eligible workspace users;
- Notification receives `TIMELINE_COMMENT_MENTIONED` or equivalent event;
- a mention does not grant the mentioned user access to a CRM record they cannot otherwise access.

## Grouping/collapse

Exact duplicate source events are prevented at storage/projection.

For noisy categories, UI/query may group/collapse adjacent related events for display. Grouping must not delete underlying durable entries or audit evidence.

## Rebuild

Provide an operational Timeline rebuild mechanism where durable source/history events exist.

Requirements:

- scoped by workspace/entity/date/module as operationally appropriate;
- idempotent;
- safe while normal projections continue, using projection version/checkpoint or controlled rebuild strategy;
- does not overwrite user comments;
- preserves/updates only rebuildable projected entries;
- reports failures/checkpoint state.

## Acceptance criteria

- Timeline query is deterministic and cursor-paginated.
- Duplicate source delivery does not duplicate entries.
- One Activity bound to multiple records appears on each authorized record Timeline.
- Timeline stores a small display snapshot, not full source state.
- Current authorization is applied at read time.
- Comments support files/mentions/edit/soft delete.
- Mention does not grant CRM access.
- Rebuild does not duplicate entries or remove user comments.
