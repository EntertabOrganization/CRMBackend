# Custom & Required Fields — Module Overview

## Goal

Provide one reusable metadata-driven field engine that lets each workspace extend supported business entities without deployment, while keeping validation, permissions, required-field rules, search exposure and historical values safe.

The first implementation must register these entity types:

```text
LEAD
CONTACT
COMPANY
DEAL
```

The engine must not hard-code itself to those four. Future modules such as Estimate, Invoice, Smart Process, Activities, Forms and other field-capable entities must be able to register through a narrow contract without modifying the core field engine.

## Module responsibilities

This module owns:

- custom field definitions;
- field machine codes and human labels;
- field type configuration;
- field options for list/multi-list fields;
- typed field values;
- multiple-value ordering;
- default values;
- type-specific validation configuration;
- visibility/edit restrictions;
- external exposure/search/filter/sort configuration;
- required-field rules;
- conditional requirement conditions;
- field-definition lifecycle and safe type migration orchestration;
- authorized schema projection for rendering/editing;
- field-value validation helpers used by owning entity services.

This module does **not** own:

- physical/system fields on CRM Core tables;
- Deal stage transition itself;
- full CRM page-layout designer;
- Forms, Import, Search, Automation or Analytics implementations;
- generic user/department authorization;
- file binaries;
- arbitrary formula/expression execution.

## Key design principles

1. Physical high-value fields remain columns in the owning module.
2. Dynamic fields use metadata + typed values.
3. Field codes are stable API identities and become immutable after creation.
4. Labels/order/exposure may change without changing stored identity.
5. Backend validation is authoritative.
6. Field-level permissions may narrow record access but never expand it.
7. Required-field resolution is shared by UI, API, Forms, Import and Automation.
8. Historical values survive field deactivation.
9. Unsafe type changes require an explicit migration flow.
10. Search/index projections are derived and rebuildable.

## Core services

Suggested logical components; adapt names to repository conventions:

```text
CustomFieldDefinitionService
CustomFieldRegistry
CustomFieldSchemaService
CustomFieldValueService
FieldTypeRegistry
FieldValidationService
FieldOptionService
FieldPermissionService
FieldRequirementService
FieldRequirementEvaluator
FieldMigrationService
FieldDependencyService
FieldSchemaCache
```

## Field-capable entity contract

Provide a registry/adapter contract similar to:

```ts
interface FieldCapableEntityAdapter {
  readonly entityType: FieldEntityType;

  getRecordContext(args: {
    workspaceId: string;
    entityId: string;
    actor: ActorContext;
  }): Promise<FieldRecordContext>;

  assertCanCreate(actor: ActorContext): Promise<void>;
  assertCanRead(actor: ActorContext, entityId: string): Promise<void>;
  assertCanUpdate(actor: ActorContext, entityId: string): Promise<void>;

  getSystemFieldDescriptors(): SystemFieldDescriptor[];
}
```

The exact interface may differ, but the engine must not switch on CRM table names throughout its core logic.

## Primary workflows

### Create field

```text
Admin opens Custom Fields
→ selects entity type and field type
→ enters label/code/configuration
→ server validates permission + code uniqueness + type settings
→ create field definition (+ options if applicable)
→ increment schema version
→ write audit + outbox event
→ invalidate schema cache
→ realtime refresh authorized clients
```

### Save entity with custom values

```text
Owning CRM service loads authorized field schema
→ resolve defaults on create only
→ normalize customFields payload
→ validate type/options/references/multiplicity/edit permissions
→ resolve required-field rules against complete post-write record state
→ save system + custom values atomically
→ create owning-domain outbox event
→ search/analytics projections update asynchronously
```

### Stage transition

```text
Pipeline service prepares target transition
→ custom-field module resolves target-stage requirements
→ validate system + custom field values
→ if invalid: return field-level errors, no transition
→ if valid: pipeline commits transition + history + outbox
```

### Deactivate field

```text
Admin requests deactivate
→ dependency impact report
→ if active dependencies exist: require explicit resolution
→ deactivate field
→ preserve all stored values/history
→ increment schema version
→ audit/outbox/cache invalidation/realtime
```

## Acceptance criteria

- A workspace admin with permission can add a supported custom field and it appears without deployment.
- Lead/Contact/Company/Deal can save custom values atomically with system fields.
- Cross-workspace field/value/reference IDs are rejected.
- Hidden fields are not disclosed through record or schema APIs.
- Read-only fields cannot be changed by unauthorized users, including API callers.
- Required custom/system fields block applicable create/update/stage transition requests.
- Conditional requirements evaluate deterministically.
- Existing records are not destroyed when a new required rule is introduced.
- Deactivating a field preserves historical values.
- Used list options can be deactivated without corrupting stored values.
- Existing-value type changes cannot happen through ordinary PATCH.
- Search/filter/sort exposure is explicit and only supported fields are indexed/projected.
- Schema changes invalidate caches and can update open clients through realtime.
