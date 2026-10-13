# Automation API Contract

Use repository response conventions while preserving these resource semantics.

## Rule administration

Recommended routes:

```text
GET    /api/v1/crm/automation/rules
POST   /api/v1/crm/automation/rules
GET    /api/v1/crm/automation/rules/:ruleId
PATCH  /api/v1/crm/automation/rules/:ruleId
DELETE /api/v1/crm/automation/rules/:ruleId              # only safe unused Draft hard delete or archive semantics

GET    /api/v1/crm/automation/rules/:ruleId/revisions
GET    /api/v1/crm/automation/rules/:ruleId/revisions/:revisionId
POST   /api/v1/crm/automation/rules/:ruleId/publish
POST   /api/v1/crm/automation/rules/:ruleId/pause
POST   /api/v1/crm/automation/rules/:ruleId/enable
POST   /api/v1/crm/automation/rules/:ruleId/dry-run
POST   /api/v1/crm/automation/rules/:ruleId/execute
```

Use command endpoints for lifecycle operations rather than allowing arbitrary `state` mutation via generic PATCH.

## Execution/log APIs

```text
GET  /api/v1/crm/automation/executions
GET  /api/v1/crm/automation/executions/:executionId
POST /api/v1/crm/automation/executions/:executionId/retry
POST /api/v1/crm/automation/jobs/:jobId/cancel
```

High-growth execution collections should use cursor pagination.

Useful filters:

- Rule ID;
- target type/ID;
- status;
- event type;
- date range;
- correlation ID.

## Metadata APIs

```text
GET /api/v1/crm/automation/targets
GET /api/v1/crm/automation/trigger-types
GET /api/v1/crm/automation/action-types
GET /api/v1/crm/automation/condition-metadata
```

Return only types available to the Workspace/current user/feature entitlement.

## Custom extensions

Administrative routes may be:

```text
GET    /api/v1/crm/automation/extensions
POST   /api/v1/crm/automation/extensions
PATCH  /api/v1/crm/automation/extensions/:extensionId
POST   /api/v1/crm/automation/extensions/:extensionId/disable
DELETE /api/v1/crm/automation/extensions/:extensionId    # only safe unused definitions; otherwise disable/archive
```

External trigger invocation may live under Integration API according to repository conventions; see `triggers-events.md`.

## Rule create/update DTO

Must validate:

- target exists in registry;
- trigger type supports target;
- condition tree schema/depth/operators;
- Action types/configuration/order;
- timing configuration;
- priority bounds;
- field references;
- service/execution policy;
- extension availability.

Draft may temporarily contain incomplete configuration if the UI requires progressive editing, but **Publish** performs complete validation and refuses invalid Rules.

## Dry-run response

Return safe evaluation details such as:

```json
{
  "matched": true,
  "conditionResults": [],
  "resolvedActions": [
    { "order": 1, "actionCode": "crm.update_fields", "valid": true }
  ],
  "sideEffectsExecuted": false
}
```

Never expose secrets in resolved config.

## Stable errors

Define repository-equivalent codes including:

```text
AUTOMATION_RULE_NOT_FOUND
AUTOMATION_RULE_VERSION_CONFLICT
AUTOMATION_RULE_NOT_PUBLISHABLE
AUTOMATION_TARGET_NOT_FOUND
AUTOMATION_TRIGGER_NOT_SUPPORTED
AUTOMATION_ACTION_NOT_SUPPORTED
AUTOMATION_CONDITION_INVALID
AUTOMATION_EXECUTION_NOT_RETRYABLE
AUTOMATION_JOB_NOT_CANCELLABLE
AUTOMATION_LOOP_LIMIT_EXCEEDED
AUTOMATION_EXTENSION_DISABLED
PERMISSION_DENIED
WORKSPACE_SCOPE_VIOLATION
```
