# Migrations, Lifecycle, Retention and Operational Repair

## Database migrations

Use versioned repository migrations for structural schema changes.

Rules:

- inspect existing schema/migrations first;
- never rewrite applied migrations;
- add indexes/constraints concurrently/safely according to repository deployment standard;
- plan backfills separately for large production tables;
- never automatically run production migration commands from the coding task unless explicitly requested by the human/release process.

## Custom-field business type migration

Changing a field from TEXT to INTEGER, etc. is **not** just a PostgreSQL migration.

It is workspace business-data migration and must use the explicit FieldMigration service/job described by this pack.

Required artifacts:

```text
migration id
workspace/field id
from type
to type
requested actor
preview counts
status
checkpoint/progress
failure samples/safe report
started/completed timestamps
schema version before/after
```

Do not silently cast failing values to null.

## Existing records after new required rule

No backfill is automatically required.

Existing records remain readable and incomplete. Enforcement occurs on next relevant save/transition.

A separate data-quality/backfill campaign may be created later; it is not implicitly part of rule creation.

## Soft deletion

### Custom field

Normal removal = deactivate. Historical values remain.

### Activity

Normal delete = soft-delete/recycle. Reminders are cancelled. Timeline/Audit evidence remains.

### Timeline comment

Normal delete = soft-delete. Audit remains. File binary is not deleted merely because comment attachment reference is removed.

## Restore

### Field

Reactivate only when:

- code identity is still reserved;
- type/data configuration remains valid;
- dependencies/requirements remain compatible.

### Activity

Restore before retention purge. Revalidate current type/binding/responsible state. Do not resend already-fired reminders.

### Comment

If product permits restore, preserve version/audit. If no restore endpoint is exposed, soft-deleted comment still remains in audit/retention backend until policy purge.

## Hard purge

This pack defines no fixed 30/45/90-day Activity purge.

Shared Platform retention policy decides eligible purge timing.

Hard purge must consider:

- legal/compliance/audit retention;
- active references;
- timeline presentation needs;
- file attachment ownership;
- provider/source reconciliation needs.

Never cascade-delete append-only Audit history solely because source object is purged.

## Orphan/reconciliation jobs

Operational jobs may detect:

- custom values referencing missing definitions due to legacy corruption;
- Activity adapter links pointing to missing specialist records;
- reminders stuck in scheduled state;
- Timeline projection lag/failures;
- schema/search mapping drift.

Repair jobs must:

- be idempotent;
- report rather than silently destroy ambiguous data;
- use controlled repair permissions/service identity;
- audit destructive corrections.

## Timeline rebuild

Rebuild projected entries from durable source/history events where available.

Do not delete user comments during rebuild.

Use projection version/checkpoints to avoid duplicates and make rebuild resumable.

## Deployment sequencing

For a new installation, recommended implementation order:

1. schema tables/constraints;
2. field type registry and entity adapters;
3. field CRUD/value validation;
4. required rules;
5. owning CRM integration;
6. Activity core;
7. bindings/communications/reminders;
8. specialist adapters;
9. Timeline projection/comments;
10. realtime/frontend;
11. backfills/indexing;
12. full regression/security suite.

For existing production systems, produce a migration/backfill plan and assess current data before enabling strict rules globally.
