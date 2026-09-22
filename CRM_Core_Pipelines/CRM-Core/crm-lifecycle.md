# CRM Lifecycle Specification

## Goal

Define responsibility, archive, soft delete, restore, hard delete, reference protection, optimistic concurrency and idempotent mutation behavior shared by CRM Core.

## Responsibility

Exactly one current responsible user per Lead, Contact, CRM Company and Deal.

If omitted at create, default to authenticated user.

Assignment is a dedicated command and requires `crm.<entity>.assign`.

New responsible user must be an active eligible member of the same Workspace.

When a member is removed/deactivated, their current CRM records must be explicitly reassigned before membership removal completes.

## Archive

Archive is a business state distinct from deletion.

Fields:

```text
isArchived
archivedAt
archivedByUserId
```

Archive is reversible and preserves all relationships/history.

## Soft delete

Fields:

```text
isDeleted
deletedAt
deletedByUserId
```

Normal queries exclude deleted records.

Restore clears current deleted state according to repository conventions while retaining audit evidence.

## Reference protection

Do not soft-delete Contact/Company if protected active/business relationships require them.

Return a stable conflict such as `CRM_ACTIVE_REFERENCES_EXIST` with safe details describing the blocking relationship categories.

Never rewrite Deal customer identity or Lead conversion outputs silently.

## Hard delete

Exceptional only.

- normally requires prior soft delete
- never deletes centralized audit evidence
- blocked if retained domain/history references require the record
- no automatic historical rewrites

## Optimistic concurrency

Use `version` or repository equivalent.

Stale write:

```text
409 CRM_VERSION_CONFLICT
```

Applies to aggregate update, assignment, transition and relationship changes where current aggregate version matters.

## Idempotency

Use 24-hour Workspace/operation-scoped Idempotency-Key handling for non-idempotent commands.

## Cross-tenant hiding

Other-Workspace UUID and nonexistent UUID return the same not-found behavior.

## Acceptance criteria

- archive and delete are distinguishable
- archive restore works
- soft-delete restore works
- protected references block delete
- hard delete never removes AuditLog
- stale writes are rejected
- idempotent retries do not duplicate effects
