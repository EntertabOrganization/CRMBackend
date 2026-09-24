# Automation Rules, Revisions & Publication

## Rule vs Revision

`AutomationRule` is the stable logical identity and operational container.

`AutomationRuleRevision` is immutable configuration after publication.

Suggested states:

```text
DRAFT
PUBLISHED
SUPERSEDED
```

The Rule itself also has operational state:

```text
ACTIVE
PAUSED
DISABLED
```

Adapt exact enums to repository conventions while preserving semantics.

## Rule fields

At minimum:

- `id`
- `workspaceId`
- `name`
- `description?`
- `targetType`
- optional target subtype/pipeline context
- `priority`
- `state`
- `activeRevisionId?`
- `draftRevisionId?`
- `version` for optimistic concurrency
- creator/last editor references according to repository audit conventions

## Revision fields

At minimum:

- `id`
- `workspaceId`
- `ruleId`
- monotonically increasing `revisionNumber`
- complete Trigger configuration
- condition tree root/version
- ordered Actions
- execution timing/configuration
- execution identity policy reference
- creation/publish metadata
- immutable published checksum/config hash where useful

## Editing

- Editing a never-published Rule updates its Draft revision using optimistic concurrency.
- Editing a published Rule creates/uses a new Draft revision.
- Active published configuration remains unchanged until Publish succeeds.
- Publishing atomically marks the new revision published, updates `activeRevisionId`, supersedes prior active revision for future matching, emits configuration event and invalidates caches.
- Existing jobs/executions keep their original `ruleRevisionId`.

## Pause/disable

`PAUSED` prevents new automatic executions but preserves definitions and history. Existing scheduled jobs follow an explicit policy:

- default: paused/disabled Rule causes pending jobs to re-check Rule operational state before side effects and mark themselves skipped/cancelled according to implementation status semantics;
- never silently delete execution history.

A human-authorized retry may require the Rule/revision to be executable under current policy.

## Deletion

Published/used Rules should be deactivated/archived rather than hard-deleted. A never-published unused Rule may be hard-deleted after dependency checks.

## Priority and ordering

For one incoming event:

1. collect eligible active Rules;
2. order by explicit priority/order value;
3. apply stable secondary key (`id` or equivalent);
4. create independent executions.

Do not assume Rule 2 is rolled back if Rule 1 fails or vice versa.

## Concurrency

Use optimistic concurrency for configuration edits. Stale updates return a stable conflict such as:

```text
AUTOMATION_RULE_VERSION_CONFLICT
```

Publishing must be atomic and safe under concurrent publish attempts.

## Acceptance criteria

- Published revision content cannot be mutated in place.
- A delayed job scheduled under revision 3 still uses revision 3 after revision 4 is published.
- Two admins editing the same Draft cannot silently overwrite each other.
- Pausing a Rule prevents new automatic execution without erasing history.
- Priority ordering is deterministic.
