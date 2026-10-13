# Validation, Options and Field Lifecycle

## Type-specific validation configuration

The exact validation object is type-specific and schema-validated by the backend.

Examples:

### TEXT / TEXTAREA

```text
minLength
maxLength
pattern/regex (safe regular expression limits)
trim policy
```

### INTEGER / DECIMAL

```text
minimum
maximum
precision/scale where appropriate
```

### PHONE / EMAIL / URL

Use normalizers/validators appropriate to the existing platform. Do not promise deliverability or phone ownership merely because syntax is valid.

### FILE

```text
allowedMimeTypes
allowedExtensions (secondary check only)
maxFileCount
maxFileSize per file if the Files module exposes this capability
```

Global Files security/quarantine rules still apply.

### CRM_REFERENCE

```text
allowedEntityTypes
```

### USER_REFERENCE

Optional constraints may restrict selectable users to active workspace members if supported by the product authorization layer.

## Safe regex behavior

If regex/pattern validation is supported:

- use a safe engine or enforce length/complexity/time limits;
- do not accept arbitrary code;
- invalid regex configuration is rejected when the admin saves the field definition, not deferred to record writes.

## List option model

Suggested fields:

```text
id UUID
workspaceId UUID
fieldId UUID
code string or stable generated key
label string
sortOrder integer
isActive boolean
version integer optional
createdAt
updatedAt
```

Option identity is stable. Stored values reference option ID/code, not label text.

### Option rules

- option IDs are immutable;
- option labels may change;
- sorting may change atomically;
- used options may be deactivated;
- a deactivated option remains displayable for existing records;
- new writes cannot select a deactivated option unless preserving an existing unchanged value;
- hard deletion is allowed only for an unused, dependency-free option if the repository implements that cleanup path;
- duplicate labels may be disallowed for UX clarity, but do not use label as database identity.

## Validation execution order

For an owning-entity create/update:

1. resolve current workspace and actor;
2. load authorized schema;
3. reject unknown field codes when `availableInApi`/surface rules do not permit them;
4. apply create-only defaults for omitted fields;
5. check edit permission for supplied fields;
6. normalize each supplied value;
7. validate type constraints;
8. validate option membership/reference/file access;
9. form the complete post-write record state including existing unchanged values;
10. evaluate global/stage/pipeline/conditional requirements;
11. if any violations exist, return all safe field-level errors;
12. if valid, persist the owning record + custom values atomically.

## Validation error model

Return every safe field error in one response.

Example:

```json
{
  "success": false,
  "error": {
    "code": "FIELD_VALIDATION_FAILED",
    "message": "One or more fields are invalid.",
    "details": {
      "fields": {
        "contract_number": [
          {"code": "REQUIRED", "message": "Contract Number is required."}
        ],
        "estimated_users": [
          {"code": "MAX_VALUE", "message": "Maximum allowed value is 100000."}
        ]
      }
    }
  }
}
```

Do not include hidden field names/messages in an error returned to an actor who cannot view that field. A configuration that makes an invisible field required for an actor must be prevented or flagged as invalid configuration.

## Field deactivation

Deactivation is the normal removal behavior.

Before deactivation:

1. load dependencies;
2. report active requirement conditions/rules;
3. report Forms/Import mappings when integration metadata is available;
4. report Automation/Search dependencies when registered;
5. require the admin to resolve/disable/migrate active dependencies;
6. then deactivate.

Deactivation:

- does not delete stored values;
- removes the field from normal active schema/rendering/new writes;
- preserves historical reporting/export only where the caller uses an authorized include-inactive/history pathway;
- emits schema-change events.

## Hard delete

Allowed only when all are true:

- field is already inactive or repository policy requires an equivalent lifecycle state;
- no stored values ever existed or current policy proves there is no business history to preserve;
- no active/inactive requirement rule depends on it;
- no list options with business history depend on it;
- no registered external mapping/dependency remains;
- caller has `CUSTOM_FIELDS.MANAGE` and destructive-action authority if the platform distinguishes it;
- operation is audited.

Otherwise return a stable dependency/in-use error.

## Type changes

### No stored values

A compatible type change may be allowed through a controlled admin operation if:

- no stored values exist;
- defaults/options/requirements are compatible or explicitly migrated;
- dependency analysis passes;
- schema version is current.

### Stored values exist

Ordinary PATCH must reject with `FIELD_TYPE_MIGRATION_REQUIRED`.

Required migration flow:

```text
request migration preview
→ analyze every affected value/default/option/rule/dependency
→ report convertible/non-convertible counts and examples
→ admin explicitly starts migration
→ background job if dataset is large
→ migrate with checkpoint/idempotency
→ if policy is all-or-nothing, roll back on validation failure; otherwise use a versioned migration plan that leaves the original field authoritative until cutover
→ atomically activate new type/schema version at cutover
→ retain migration report/audit
→ update search mappings/reindex
```

The implementation must choose a safe transactional/versioned approach appropriate to repository size. It must never silently coerce failed values to null.

## Optimistic concurrency

Configuration update DTOs should carry `version` / `If-Match` equivalent.

Stale writes return:

```text
409 CONFIGURATION_VERSION_CONFLICT
```

The response may include current version metadata but must not leak restricted configuration.

## Acceptance criteria

- Invalid type configuration is rejected before it reaches record writes.
- Used options deactivate without value corruption.
- New writes cannot select inactive options.
- Deactivation cannot silently break active requirement/automation dependencies.
- Hard delete cannot remove historical business data.
- Existing-value type changes require explicit migration.
- Stale admin edits return conflict rather than last-write-wins.
