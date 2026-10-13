# Custom & Required Fields — API Contract

## General

Base:

```text
/api/v1/crm
```

Use the repository's standard response envelope/correlation IDs. The route families below are locked; minor nested naming changes require preserving semantics and updating this pack/tests.

## Custom field administration

```text
POST   /api/v1/crm/custom-fields
GET    /api/v1/crm/custom-fields
GET    /api/v1/crm/custom-fields/:fieldId
PATCH  /api/v1/crm/custom-fields/:fieldId
POST   /api/v1/crm/custom-fields/:fieldId/activate
POST   /api/v1/crm/custom-fields/:fieldId/deactivate
DELETE /api/v1/crm/custom-fields/:fieldId/hard
POST   /api/v1/crm/custom-fields/reorder
```

If repository REST conventions strongly prefer PATCH for activate/deactivate, adapt transport while preserving dedicated lifecycle semantics.

### Create request

Conceptual DTO:

```json
{
  "entityType": "DEAL",
  "code": "customer_industry",
  "label": "Customer Industry",
  "helpText": "Primary industry for this opportunity.",
  "fieldType": "LIST",
  "isMultiple": false,
  "staticDefaultValue": null,
  "validationConfig": {},
  "showOnCreate": true,
  "showOnEdit": true,
  "showOnDetail": true,
  "availableAsListColumn": true,
  "searchable": true,
  "filterable": true,
  "sortable": false,
  "availableInForms": true,
  "availableInImport": true,
  "availableInExport": true,
  "availableInApi": true,
  "options": [
    {"code": "FINANCE", "label": "Finance", "sortOrder": 100},
    {"code": "HEALTHCARE", "label": "Healthcare", "sortOrder": 200}
  ]
}
```

`code` may be omitted to request generation.

### Update request

- include `version` or use repository `If-Match` equivalent;
- cannot change code/entity/workspace;
- changing type with values returns `FIELD_TYPE_MIGRATION_REQUIRED`;
- changing multiplicity/reference configuration may also require compatibility/migration.

## Field options

```text
POST   /api/v1/crm/custom-fields/:fieldId/options
GET    /api/v1/crm/custom-fields/:fieldId/options
PATCH  /api/v1/crm/custom-fields/:fieldId/options/:optionId
POST   /api/v1/crm/custom-fields/:fieldId/options/:optionId/activate
POST   /api/v1/crm/custom-fields/:fieldId/options/:optionId/deactivate
POST   /api/v1/crm/custom-fields/:fieldId/options/reorder
```

Hard delete may be exposed only for unused options if implemented; do not make destructive delete the default endpoint behavior.

## Field migration

Recommended dedicated commands:

```text
POST /api/v1/crm/custom-fields/:fieldId/type-migration/preview
POST /api/v1/crm/custom-fields/:fieldId/type-migration
GET  /api/v1/crm/custom-fields/:fieldId/type-migration/:migrationId
```

Large migrations are async jobs. Preview must not mutate business values.

## Field dependency impact

Recommended:

```text
GET /api/v1/crm/custom-fields/:fieldId/dependencies
```

Returns only dependencies the admin is authorized to inspect, grouped by module/type with stable identifiers and remediation hints.

## Required-field rules

```text
POST   /api/v1/crm/field-requirements
GET    /api/v1/crm/field-requirements
GET    /api/v1/crm/field-requirements/:ruleId
PATCH  /api/v1/crm/field-requirements/:ruleId
POST   /api/v1/crm/field-requirements/:ruleId/activate
POST   /api/v1/crm/field-requirements/:ruleId/deactivate
DELETE /api/v1/crm/field-requirements/:ruleId
```

A hard delete may be implemented only when history/dependencies permit; otherwise DELETE should mean safe config removal/deactivation according to repository policy. Audit history remains.

### Rule create example

```json
{
  "entityType": "DEAL",
  "target": {"kind": "CUSTOM", "fieldId": "field-uuid"},
  "pipelineId": "pipeline-uuid",
  "stageId": "stage-uuid",
  "conditions": {
    "operator": "ALL",
    "children": [
      {
        "type": "PREDICATE",
        "field": {"kind": "SYSTEM", "key": "amount"},
        "operator": "GTE",
        "value": "100000"
      }
    ]
  }
}
```

## Authorized schema endpoints

The exact route may integrate with existing CRM metadata APIs. If none exists, provide a route such as:

```text
GET /api/v1/crm/field-schema/:entityType
GET /api/v1/crm/field-schema/:entityType/:entityId
```

Query/surface example:

```text
?surface=create
?surface=edit
?surface=detail
?surface=list
```

Response returns only authorized active fields for normal clients and includes `schemaVersion`.

Admin schema endpoints are the `/custom-fields` collection and may include inactive/configuration metadata.

## Entity CRUD integration

Owning entity endpoints accept:

```json
{
  "title": "Enterprise Deal",
  "amount": "50000.00",
  "customFields": {
    "customer_industry": "option-uuid",
    "estimated_users": 400
  }
}
```

Unknown or non-API-exposed custom-field codes are rejected, not silently ignored.

Responses include only custom fields the actor may view.

## Admin list queries

Support bounded page/limit pagination plus allowlisted:

```text
search
entityType
fieldType
isActive
isMultiple
searchable
filterable
availableInApi
sortBy
sortOrder
```

Do not expose arbitrary database filters.

## Stable errors

At minimum:

```text
CUSTOM_FIELD_NOT_FOUND
CUSTOM_FIELD_CODE_CONFLICT
CUSTOM_FIELD_INACTIVE
CUSTOM_FIELD_TYPE_UNSUPPORTED
CUSTOM_FIELD_TYPE_MIGRATION_REQUIRED
CUSTOM_FIELD_DEPENDENCIES_EXIST
CUSTOM_FIELD_IN_USE
FIELD_OPTION_NOT_FOUND
FIELD_OPTION_INACTIVE
FIELD_OPTION_IN_USE
FIELD_EDIT_FORBIDDEN
FIELD_HIDDEN
FIELD_VALIDATION_FAILED
FIELD_REFERENCE_INVALID
FIELD_REFERENCE_FORBIDDEN
FIELD_REQUIREMENT_NOT_FOUND
FIELD_REQUIREMENT_INVALID
FIELD_REQUIREMENT_CONFIGURATION_CONFLICT
CONFIGURATION_VERSION_CONFLICT
ENTITY_TYPE_NOT_FIELD_CAPABLE
WORKSPACE_SCOPE_VIOLATION
```

Prefer 404 over permission-revealing errors when repository security policy masks inaccessible resources.

## HTTP status guidance

```text
400 invalid DTO/operator/type settings
401 unauthenticated
403 authenticated but forbidden where disclosure is safe
404 missing/inaccessible masked resource
409 code conflict/version conflict/dependency conflict/type migration required where appropriate
422 valid request shape but field/business validation failed (or repository-standard 400)
```

Preserve repository-wide status conventions if already established.

## Acceptance criteria

- Route authorization uses active workspace context.
- Admin endpoints require configuration permissions.
- Normal entity CRUD persists system + custom values atomically.
- Errors return all safe field violations.
- Stale config versions return conflict.
- Cross-workspace IDs never create relationships.
