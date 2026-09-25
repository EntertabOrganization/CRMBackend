import { AUTOMATION_CATALOG_ROWS, AUTOMATION_CATALOG_TAGS } from './openapi-automation-catalog';
/**
 * OpenAPI paths for Custom & Required Fields, Activities and Timeline. Each row is [path, method, tag, summary, extras].
 * Request bodies are described in prose (the payload contracts live in the Custom_Fields_Activities_Timeline pack).
 */
export type Row = [path: string, method: 'get' | 'post' | 'put' | 'patch' | 'delete', tag: string, summary: string, extras?: { query?: string[]; cursor?: boolean; sse?: boolean; jobToken?: boolean; integrationKey?: boolean }];

export const CRM_EXTENSION_TAGS = [
  { name: 'Custom Fields' },
  { name: 'Required Fields' },
  { name: 'Field Schema' },
  { name: 'Activity Types' },
  { name: 'Activities' },
  { name: 'Timeline' },
  { name: 'Realtime' },
  { name: 'Operations' },
  ...AUTOMATION_CATALOG_TAGS,
];

const ROWS: Row[] = [
  ['/crm/custom-fields', 'post', 'Custom Fields', 'Create a custom field (with options and field restrictions). Requires custom_fields.manage.'],
  ['/crm/custom-fields', 'get', 'Custom Fields', 'List custom field definitions (page/limit).', { query: ['search', 'entityType', 'fieldType', 'isActive', 'isMultiple', 'searchable', 'filterable', 'availableInApi', 'sortBy', 'sortOrder', 'page', 'limit'] }],
  ['/crm/custom-fields/reorder', 'post', 'Custom Fields', 'Atomically reorder the fields of one entity type (expectedSchemaVersion required).'],
  ['/crm/custom-fields/{fieldId}', 'get', 'Custom Fields', 'Get a custom field definition.'],
  ['/crm/custom-fields/{fieldId}', 'patch', 'Custom Fields', 'Update a field (version required; code/entityType immutable; type change with data needs a migration).'],
  ['/crm/custom-fields/{fieldId}/activate', 'post', 'Custom Fields', 'Reactivate a deactivated field.'],
  ['/crm/custom-fields/{fieldId}/deactivate', 'post', 'Custom Fields', 'Deactivate a field (blocked while active dependencies exist; values are preserved).'],
  ['/crm/custom-fields/{fieldId}/hard', 'delete', 'Custom Fields', 'Hard delete an unused, dependency-free, inactive field.'],
  ['/crm/custom-fields/{fieldId}/dependencies', 'get', 'Custom Fields', 'Dependency impact report grouped by module.'],
  ['/crm/custom-fields/{fieldId}/options', 'post', 'Custom Fields', 'Add a list option.'],
  ['/crm/custom-fields/{fieldId}/options', 'get', 'Custom Fields', 'List options (with in-use flag).'],
  ['/crm/custom-fields/{fieldId}/options/reorder', 'post', 'Custom Fields', 'Atomically reorder options (expectedSchemaVersion required).'],
  ['/crm/custom-fields/{fieldId}/options/{optionId}', 'patch', 'Custom Fields', 'Rename an option (identity is immutable).'],
  ['/crm/custom-fields/{fieldId}/options/{optionId}/activate', 'post', 'Custom Fields', 'Reactivate an option.'],
  ['/crm/custom-fields/{fieldId}/options/{optionId}/deactivate', 'post', 'Custom Fields', 'Deactivate an option; stored values are preserved.'],
  ['/crm/custom-fields/{fieldId}/type-migration/preview', 'post', 'Custom Fields', 'Preview a type migration without changing data.'],
  ['/crm/custom-fields/{fieldId}/type-migration', 'post', 'Custom Fields', 'Start an all-or-nothing type migration.'],
  ['/crm/custom-fields/{fieldId}/type-migration/{migrationId}', 'get', 'Custom Fields', 'Get migration status and report.'],
  ['/crm/field-requirements', 'post', 'Required Fields', 'Create a required-field rule (system or custom target, pipeline/stage scope, declarative ALL/ANY conditions).'],
  ['/crm/field-requirements', 'get', 'Required Fields', 'List requirement rules.', { query: ['entityType', 'targetFieldId', 'pipelineId', 'stageId', 'isActive', 'sortBy', 'sortOrder', 'page', 'limit'] }],
  ['/crm/field-requirements/system-fields', 'get', 'Required Fields', 'Supported system field descriptors and operators for an entity type.', { query: ['entityType'] }],
  ['/crm/field-requirements/{ruleId}', 'get', 'Required Fields', 'Get a requirement rule.'],
  ['/crm/field-requirements/{ruleId}', 'patch', 'Required Fields', 'Update a rule (version required).'],
  ['/crm/field-requirements/{ruleId}', 'delete', 'Required Fields', 'Delete a rule (audit history is kept).'],
  ['/crm/field-requirements/{ruleId}/activate', 'post', 'Required Fields', 'Activate a rule.'],
  ['/crm/field-requirements/{ruleId}/deactivate', 'post', 'Required Fields', 'Deactivate a rule.'],
  ['/crm/field-schema/{entityType}', 'get', 'Field Schema', 'Authorized schema (visible active fields, options, defaults, requiredNow) for create/list.', { query: ['surface', 'pipelineId', 'stageId', 'activityTypeId'] }],
  ['/crm/field-schema/{entityType}/{entityId}', 'get', 'Field Schema', 'Authorized schema for one record (editability and required-now resolved).', { query: ['surface', 'pipelineId', 'stageId'] }],
  ['/crm/activity-types', 'post', 'Activity Types', 'Create a workspace custom Activity type. Requires activity.manage_types.'],
  ['/crm/activity-types', 'get', 'Activity Types', 'List built-in and custom Activity types.'],
  ['/crm/activity-types/{typeId}', 'get', 'Activity Types', 'Get a custom Activity type.'],
  ['/crm/activity-types/{typeId}', 'patch', 'Activity Types', 'Update a custom Activity type (version required).'],
  ['/crm/activity-types/{typeId}/enable', 'post', 'Activity Types', 'Enable a type.'],
  ['/crm/activity-types/{typeId}/disable', 'post', 'Activity Types', 'Disable a type (blocks new Activities; history is kept).'],
  ['/crm/activities', 'post', 'Activities', 'Create an Activity (bindings, participants, communications, reminders, custom fields). Supports Idempotency-Key.'],
  ['/crm/activities', 'get', 'Activities', 'List Activities (cursor). Default view is My Open Activities, overdue/urgent first.', { cursor: true, query: ['view', 'status', 'priority', 'typeCode', 'responsibleUserId', 'participantUserId', 'bindingEntityType', 'bindingEntityId', 'overdue', 'deadlineFrom', 'deadlineTo', 'createdFrom', 'createdTo', 'includeDeleted', 'search', 'sort'] }],
  ['/crm/activities/bulk', 'post', 'Activities', 'Bulk REASSIGN / COMPLETE / CANCEL / SOFT_DELETE with per-item results.'],
  ['/crm/activities/{activityId}', 'get', 'Activities', 'Get an Activity (unauthorized bindings and hidden custom fields are omitted).'],
  ['/crm/activities/{activityId}', 'patch', 'Activities', 'Update editable fields (expectedVersion required; status cannot be patched).'],
  ['/crm/activities/{activityId}', 'delete', 'Activities', 'Soft delete an Activity.'],
  ['/crm/activities/{activityId}/restore', 'post', 'Activities', 'Restore a soft-deleted Activity.'],
  ['/crm/activities/{activityId}/start', 'post', 'Activities', 'PLANNED -> IN_PROGRESS.'],
  ['/crm/activities/{activityId}/complete', 'post', 'Activities', 'Complete with optional result and outcome custom fields (idempotent).'],
  ['/crm/activities/{activityId}/cancel', 'post', 'Activities', 'Cancel with optional reason.'],
  ['/crm/activities/{activityId}/reopen', 'post', 'Activities', 'COMPLETED -> IN_PROGRESS, CANCELLED -> PLANNED.'],
  ['/crm/activities/{activityId}/bindings', 'get', 'Activities', 'List authorized bindings.'],
  ['/crm/activities/{activityId}/bindings', 'post', 'Activities', 'Bind to a CRM record (target authorized separately).'],
  ['/crm/activities/{activityId}/bindings/{bindingId}', 'delete', 'Activities', 'Remove a binding.'],
  ['/crm/activities/{activityId}/reminders', 'get', 'Activities', 'List reminders.'],
  ['/crm/activities/{activityId}/reminders', 'post', 'Activities', 'Add a relative or absolute reminder.'],
  ['/crm/activities/{activityId}/reminders/{reminderId}', 'patch', 'Activities', 'Change a reminder.'],
  ['/crm/activities/{activityId}/reminders/{reminderId}', 'delete', 'Activities', 'Remove a future reminder.'],
  ['/crm/{entityType}/{entityId}/timeline', 'get', 'Timeline', 'Timeline of a CRM record (cursor, newest first). Requires timeline.read and record access.', { cursor: true, query: ['category', 'actorUserId', 'from', 'to', 'sourceType', 'group'] }],
  ['/crm/{entityType}/{entityId}/timeline/comments', 'post', 'Timeline', 'Create a comment with stable mention ids and file references. Supports Idempotency-Key.'],
  ['/crm/timeline/comments/{commentId}', 'get', 'Timeline', 'Get a comment.'],
  ['/crm/timeline/comments/{commentId}', 'patch', 'Timeline', 'Edit a comment (expectedVersion required).'],
  ['/crm/timeline/comments/{commentId}', 'delete', 'Timeline', 'Soft delete a comment.'],
  ['/crm/leads/{id}', 'get', 'CRM Leads', 'Get a lead with authorized custom fields.'],
  ['/crm/leads/{id}', 'patch', 'CRM Leads', 'Update a lead and its custom fields atomically (expectedVersion required).'],
  ['/crm/deals/{id}', 'get', 'CRM Deals', 'Get a deal with authorized custom fields.'],
  ['/crm/deals/{id}', 'patch', 'CRM Deals', 'Update a deal and its custom fields atomically (expectedVersion required).'],
  ['/crm/contacts/{id}', 'get', 'CRM Contacts', 'Get a contact with authorized custom fields.'],
  ['/crm/contacts/{id}', 'patch', 'CRM Contacts', 'Update a contact and its custom fields atomically (expectedVersion required).'],
  ['/crm/companies/{id}', 'get', 'CRM Companies', 'Get a company with authorized custom fields.'],
  ['/crm/companies/{id}', 'patch', 'CRM Companies', 'Update a company and its custom fields atomically (expectedVersion required).'],
  ['/crm/realtime', 'get', 'Realtime', 'Server-Sent Events stream of advisory invalidation hints (ids/versions only). REST stays authoritative.', { sse: true }],
  ['/internal/crm/jobs/{job}', 'post', 'Operations', 'Scheduler jobs: overdue, reminders, timeline-project, timeline-rebuild, automation-ingest, automation-run. Requires the x-internal-job-token header.', { jobToken: true }],
];

function operation([path, , tag, summary, extras]: Row) {
  const parameters: unknown[] = [];
  for (const [, name] of path.matchAll(/\{(\w+)\}/g)) parameters.push({ name, in: 'path', required: true, schema: { type: 'string' } });
  for (const name of extras?.query ?? []) parameters.push({ name, in: 'query', schema: { type: 'string' } });
  if (extras?.cursor) parameters.push({ name: 'cursor', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } });
  if (extras?.integrationKey) parameters.push({ name: 'x-automation-integration-key', in: 'header', required: true, schema: { type: 'string' } });
  else if (!extras?.jobToken) parameters.push({ name: 'X-Workspace-Id', in: 'header', required: true, schema: { type: 'string', format: 'uuid' } });
  else parameters.push({ name: 'x-internal-job-token', in: 'header', required: true, schema: { type: 'string' } });
  const error = { description: 'Error response.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } };
  return {
    tags: [tag],
    summary,
    security: extras?.jobToken || extras?.integrationKey ? [] : [{ bearerAuth: [] }],
    parameters,
    responses: {
      '200': extras?.sse
        ? { description: 'Event stream.', content: { 'text/event-stream': { schema: { type: 'string' } } } }
        : { description: 'Successful response.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean', const: true }, data: {}, meta: { nullable: true } } } } } },
      '400': error,
      '401': error,
      '403': error,
      '404': error,
      '409': error,
      '429': error,
    },
  };
}

export function crmExtensionPaths(): Record<string, Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const row of [...ROWS, ...AUTOMATION_CATALOG_ROWS]) {
    paths[row[0]] ??= {};
    paths[row[0]][row[1]] = operation(row);
  }
  return paths;
}
