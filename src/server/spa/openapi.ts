import { z } from 'zod';
import { spaRouter } from './routes';
import { createType, updateType, typeAction, updateCapability, listTypes } from './dto';
import { createField, patchField, fieldDefinition, schemaSnapshot, fieldTypes, uniqueDefinition, relationDefinition, layoutDefinition } from './field-metadata';
import { createPipeline, changePipeline, createStage, changeStage } from './pipeline-service';
import { replacement } from './policy-service';
import { scheme } from './numbering-service';
import { spaCreateItemDto, patchItem, replaceItem, itemQuery } from './item-service';
import { createRule, ruleSettings } from './recurrence-service';
import { importInput, exportInput } from './transfer-service';
import { draftChanges } from './schema-service';
import { migrationMapping } from './migration-service';
import { uuid, version, pageQuery } from '../process-platform/dto';
type Schema = Record<string, any>;
const empty = z.strictObject({}), action = z.strictObject({ expectedVersion: version });
const target = z.strictObject({ pipelineId: uuid, stageId: uuid });
const filter = z.strictObject({ fieldCode: z.string().max(64), operator: z.enum(['EQ','NEQ','CONTAINS']), value: z.json() });
const view = z.strictObject({ viewType: z.enum(['LIST','KANBAN']), columns: z.array(z.string().max(64)).max(100),
  filters: z.array(filter).max(30), sort: z.strictObject({ fieldCode: z.string().max(64), direction: z.enum(['asc','desc']) }) });

/** Reuse executable DTOs so required keys, enums and bounds cannot drift from the API. */
export function spaRequestContract(method: string, path: string): { permission: string; body?: z.ZodType; query?: z.ZodType } {
  const get = method === 'GET';
  const p = path.replace('/api/v1/spa/types', '');
  if (!p) return { permission: get ? 'SPA.TYPE.READ' : 'SPA.TYPE.MANAGE', ...(get ? { query: listTypes } : { body: createType }) };
  if (p === '/:typeId') return { permission: get ? 'SPA.TYPE.READ' : 'SPA.TYPE.MANAGE', ...(!get ? { body: updateType } : {}) };
  if (/\/(activate|archive|restore)$/.test(p) && !p.includes('/items') && !p.includes('/pipelines')) return { permission: 'SPA.TYPE.MANAGE', body: typeAction };
  if (p.includes('/capabilities')) return { permission: get ? 'SPA.TYPE.READ' : 'SPA.TYPE.MANAGE', ...(!get ? { body: updateCapability } : {}) };
  if (p.includes('/permissions')) return { permission: p.endsWith('/me') ? 'SPA.ITEM.READ' : 'SPA.PERMISSION.MANAGE',
    ...(method === 'PUT' ? { body: replacement } : p.endsWith('/history') ? { query: pageQuery } : {}) };
  if (p.includes('/numbering')) return { permission: get ? 'SPA.TYPE.READ' : 'SPA.TYPE.MANAGE', ...(!get ? { body: scheme } : {}) };
  if (p.includes('/fields')) return { permission: get ? 'SPA.SCHEMA.READ' : 'SPA.SCHEMA.MANAGE',
    ...(!get ? { body: p.endsWith('/deactivate') ? action : method === 'PATCH' ? patchField : createField } : {}) };
  if (p.includes('/schema') || p.endsWith('/unique-constraints')) {
    if (p.endsWith('/migrations')) return { permission: 'SPA.SCHEMA.MANAGE', body: z.strictObject({ fieldId: uuid, targetType: z.enum(fieldTypes), mappingStrategy: migrationMapping }) };
    if (p.endsWith('/validate')) return { permission: 'SPA.SCHEMA.MANAGE', body: z.strictObject({ draftVersion: version }) };
    if (p.endsWith('/publish')) return { permission: 'SPA.SCHEMA.PUBLISH', body: z.strictObject({ expectedDraftVersion: version, migrationPlanId: uuid.optional() }) };
    if (p.endsWith('/unique-constraints')) return { permission: 'SPA.SCHEMA.MANAGE', body: uniqueDefinition.omit({ id: true }) };
    return { permission: get ? 'SPA.SCHEMA.READ' : 'SPA.SCHEMA.MANAGE', ...(!get ? { body: draftChanges } : p.endsWith('/versions') ? { query: pageQuery.omit({ search: true }) } : {}) };
  }
  if (p.includes('/recurrence')) return { permission: get ? 'SPA.RECURRENCE.READ' : 'SPA.RECURRENCE.MANAGE',
    ...(get ? { query: pageQuery } : { body: /\/(pause|resume)$/.test(p) ? empty : method === 'PATCH' ? z.strictObject({ expectedVersion: version, templatePayload: spaCreateItemDto.optional(), rule: ruleSettings.partial().optional() }) : createRule }) };
  if (p.includes('/relation-definitions')) return { permission: get ? 'SPA.SCHEMA.READ' : 'SPA.SCHEMA.MANAGE', ...(!get ? { body: relationDefinition.omit({ id: true }) } : {}) };
  if (p.includes('/layouts')) return { permission: get ? 'SPA.SCHEMA.READ' : 'SPA.SCHEMA.MANAGE', ...(get ? { query: z.strictObject({ context: layoutDefinition.shape.context.optional() }) }
    : { body: z.strictObject({ expectedVersion: version, sections: layoutDefinition.shape.sections }) }) };
  if (p.includes('/views')) return { permission: 'SPA.ITEM.READ', ...(!get ? { body: view } : {}) };
  if (p.includes('/imports')) return { permission: 'SPA.ITEM.IMPORT', ...(!get ? { body: p.endsWith('/cancel') ? empty : importInput } : {}) };
  if (p.includes('/exports')) return { permission: 'SPA.ITEM.EXPORT', ...(!get ? { body: exportInput } : {}) };
  if (p.endsWith('/trash')) return { permission: 'SPA.ITEM.RESTORE', query: pageQuery };
  if (p.endsWith('/purge')) return { permission: 'SPA.ITEM.HARD_DELETE', body: empty };
  if (p.endsWith('/kanban')) return { permission: 'SPA.ITEM.READ', query: z.strictObject({ pipelineId: uuid, page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20), search: z.string().max(160).optional(), filters: z.string().max(10000).optional() }) };
  if (p.endsWith('/transition')) return { permission: 'SPA.ITEM.STAGE_CHANGE', body: z.strictObject({ expectedVersion: version, targetPipelineId: uuid, targetStageId: uuid, reason: z.string().trim().max(2000).optional() }) };
  if (p.includes('/pipelines')) return { permission: get ? 'SPA.PIPELINE.READ' : p.includes('/stages') ? 'SPA.STAGE.MANAGE' : 'SPA.PIPELINE.MANAGE',
    ...(get ? p.endsWith('/pipelines') ? { query: pageQuery } : {} : { body: p.endsWith('/archive') ? p.includes('/stages') ? z.strictObject({ migrationTarget: target.optional() }) : action.extend({ migrationTarget: target.optional() })
      : method === 'PATCH' ? p.includes('/stages') ? changeStage : changePipeline : p.includes('/stages') ? createStage : createPipeline }) };
  if (p.includes('/relations')) return { permission: get ? 'SPA.ITEM.READ' : 'SPA.ITEM.UPDATE', ...(get ? { query: pageQuery.extend({ targetType: relationDefinition.shape.targetType.optional() }) }
    : { body: method === 'DELETE' ? empty : z.strictObject({ definitionId: uuid, targetType: relationDefinition.shape.targetType, targetId: uuid, isPrimary: z.boolean().default(false) }) }) };
  if (p.includes('/observers')) return { permission: 'SPA.ITEM.MANAGE_OBSERVERS', body: method === 'DELETE' ? empty : z.strictObject({ userId: uuid }) };
  if (p.endsWith('/assign')) return { permission: 'SPA.ITEM.ASSIGN', body: z.strictObject({ expectedVersion: version, responsibleUserId: uuid }) };
  if (p.endsWith('/history')) return { permission: 'SPA.ITEM.READ', query: pageQuery };
  if (p.endsWith('/restore')) return { permission: 'SPA.ITEM.RESTORE', body: action };
  if (get) return { permission: 'SPA.ITEM.READ', ...(p.endsWith('/items') ? { query: itemQuery } : {}) };
  return { permission: method === 'POST' ? 'SPA.ITEM.CREATE' : method === 'DELETE' ? 'SPA.ITEM.DELETE' : 'SPA.ITEM.UPDATE',
    body: method === 'POST' ? spaCreateItemDto : method === 'DELETE' ? action : method === 'PUT' ? replaceItem : patchItem };
}
function jsonSchema(dto: z.ZodType): Schema {
  const result = z.toJSONSchema(dto, { io: 'input', unrepresentable: 'any' }) as Schema;
  // z.json is arbitrary serializable JSON. Inline local definitions so refs resolve inside OpenAPI.
  const defs = result.$defs ?? {};
  const walk = (value: any, seen = new Set<string>()): any => {
    if (Array.isArray(value)) return value.map(v => walk(v, seen));
    if (!value || typeof value !== 'object') return value;
    if (value.$ref?.startsWith('#/$defs/')) { const key = value.$ref.slice(8); return seen.has(key) ? {} : walk(defs[key] ?? {}, new Set([...seen, key])); }
    return Object.fromEntries(Object.entries(value).filter(([k]) => !['$schema','$defs'].includes(k)).map(([k,v]) => [k, walk(v, seen)]));
  };
  return walk(result);
}
const resource: Schema = { type: 'object', description: 'Owning resource projection. Item fieldValues and related identities are redacted against current field and target permissions; schema snapshots preserve versioned metadata.',
  properties: { id: { type: 'string', format: 'uuid' }, version: { type: 'integer', minimum: 1 }, status: { type: 'string' },
    fieldValues: { type: 'object', additionalProperties: true }, permissions: { type: 'array', items: { type: 'string' } } } };
const job: Schema = { type: 'object', required: ['jobId','status','correlationId'], properties: { jobId: { type: 'string', format: 'uuid' }, status: { enum: ['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED'] }, correlationId: { type: 'string', format: 'uuid' },
  downloadFileId: { type: ['string','null'], format: 'uuid', description: 'Available only after success and before expiry. Get /files/{id}/download for a current, short-lived deliveryPath.' },
  reportFileId: { type: ['string','null'], format: 'uuid' }, errorCode: { type: ['string','null'] }, totals: { type: 'object' } } };
const id: Schema = { type: 'string', format: 'uuid' }, instant: Schema = { type: 'string', format: 'date-time' }, integer: Schema = { type: 'integer' };
const strings: Schema = { type: 'array', items: { type: 'string' } }, ids: Schema = { type: 'array', items: id };
const object = (properties: Schema, required: string[] = Object.keys(properties)): Schema => ({ type: 'object', properties, required });
const array = (items: Schema): Schema => ({ type: 'array', items });
const identity = { id, workspaceId: id, version: { ...integer, minimum: 1 } };
const itemResponse = object({ ...identity, createdAt: instant, updatedAt: instant, typeId: id, itemNumber: { type: 'string' }, title: { type: 'string' },
  assignedUserId: id, companyId: { ...id, type: ['string','null'] }, pipelineId: { ...id, type: ['string','null'] }, stageId: { ...id, type: ['string','null'] },
  status: { enum: ['ACTIVE','COMPLETED','TRASHED'] }, schemaVersion: integer, createdByUserId: id, updatedByUserId: id,
  closedAt: { ...instant, type: ['string','null'] }, trashedAt: { ...instant, type: ['string','null'] }, purgeAfter: { ...instant, type: ['string','null'] },
  legalHold: { type: 'boolean' }, fieldValues: { type: 'object', additionalProperties: true, description: 'Typed published values; hidden fields and inaccessible references are omitted.' }, contacts: ids, observers: ids });
const pipelineResponse = object({ ...identity, typeId: id, code: { type: 'string' }, name: { type: 'string' }, isDefault: { type: 'boolean' }, sortOrder: integer, status: { enum: ['ACTIVE','ARCHIVED'] } });
const stageResponse = object({ ...identity, pipelineId: id, code: { type: 'string' }, name: { type: 'string' }, semantic: { enum: ['PROGRESS','SUCCESS','FAILURE'] }, isDefault: { type: 'boolean' }, sortOrder: integer, status: { enum: ['ACTIVE','ARCHIVED'] }, requirements: strings, transitionRules: array(object({ targetStageId: id, allowedRoleIds: ids, condition: {} }, ['targetStageId'])) });
const historyResponse = object({ id, workspaceId: id, typeId: id, itemId: { ...id, type: ['string','null'] }, actorUserId: id, action: { type: 'string' }, changes: { type: 'object', description: 'Metadata-only immutable evidence, not hidden field values.' }, occurredAt: instant });
export function spaResponseContract(method: string, path: string): Schema {
  const get = method === 'GET', p = path.replace('/api/v1/spa/types', '');
  if (p.endsWith('/kanban')) return object({ pipelineId: id, columns: array(object({ stage: stageResponse, items: array(itemResponse), count: integer, meta: object({ page: integer, limit: integer, total: integer, totalPages: integer }) })) });
  if (p.endsWith('/permissions/me')) return object({ actions: strings, visibleFields: strings, editableFields: strings, transitions: array(object({ pipelineId: id, stageId: id })) });
  if (p.endsWith('/history')) return array(historyResponse);
  if (p.endsWith('/permissions')) return method === 'PUT' ? object({ version: integer }) : object({ version: integer,
    rolePolicies: array(object({ id, workspaceId: id, typeId: id, roleId: id, action: { type: 'string' }, scope: { enum: ['NONE','OWN','DEPARTMENT','DEPARTMENT_TREE','TEAM','ALL'] } })),
    stagePolicies: array(object({ id, workspaceId: id, typeId: id, roleId: id, pipelineId: id, stageId: id, action: { type: 'string' }, scope: { enum: ['NONE','OWN','DEPARTMENT','DEPARTMENT_TREE','TEAM','ALL'] } })),
    fieldPolicies: array(object({ id, workspaceId: id, typeId: id, fieldId: id, subjectType: { enum: ['ROLE','USER'] }, subjectId: id, canView: { type: 'boolean' }, canEdit: { type: 'boolean' } })) });
  if (p.includes('/imports')) return get ? object({ jobId: id, status: job.properties.status, totals: { type: 'object' }, errorCode: { type: ['string','null'] },
    reportFileId: { ...id, type: ['string','null'] }, cancelRequested: { type: 'boolean' }, correlationId: id, rows: array(object({ rowNumber: integer, status: { type: 'string' }, errorCodes: strings })) })
    : p.endsWith('/cancel') ? object({ jobId: id, status: { type: 'string' }, cancelRequested: { const: true } }) : job;
  if (p.includes('/exports')) return get ? object({ jobId: id, status: job.properties.status, expiresAt: instant, downloadFileId: job.properties.downloadFileId }) : job;
  if (p.endsWith('/purge') || p.endsWith('/migrations')) return job;
  if (p.endsWith('/validate')) return object({ valid: { type: 'boolean' }, issues: array(object({ code: { type: 'string' }, fieldId: id, message: { type: 'string' } }, ['code'])) });
  if (p.includes('/unique-constraints')) return { ...jsonSchema(uniqueDefinition), properties: { ...jsonSchema(uniqueDefinition).properties, draftVersion: integer, publicationRequired: { const: true } } };
  if (p.includes('/fields')) return get ? array(jsonSchema(fieldDefinition)) : jsonSchema(fieldDefinition);
  if (p.includes('/schema')) {
    const draft = object({ ...identity, updatedAt: instant, typeId: id, snapshot: jsonSchema(schemaSnapshot) });
    const publication = object({ id, workspaceId: id, typeId: id, versionNumber: integer, publishedAt: instant, publishedBy: id, snapshot: jsonSchema(schemaSnapshot), checksum: { type: 'string' } });
    return p.endsWith('/versions') ? array(publication) : p.endsWith('/publish') ? publication : draft;
  }
  if (p.includes('/numbering')) return object({ ...identity, typeId: id, prefixTemplate: { type: 'string' }, padding: integer, resetPolicy: { enum: ['NEVER','YEARLY','MONTHLY'] } });
  if (p.includes('/recurrence')) {
    if (p.endsWith('/instances')) return array(object({ id, workspaceId: id, ruleId: id, scheduledFor: instant, itemId: id, ruleVersion: integer, createdAt: instant }));
    const rule = object({ ...identity, typeId: id, ...jsonSchema(ruleSettings).properties, templatePayload: jsonSchema(spaCreateItemDto), isActive: { type: 'boolean' },
      nextScheduledFor: { ...instant, type: ['string','null'] }, nextRetryAt: { ...instant, type: ['string','null'] }, lastErrorCode: { type: ['string','null'] }, failureCount: integer, createdByUserId: id }, ['id','version','templatePayload','isActive']);
    return get ? array(rule) : rule;
  }
  if (p.includes('/layouts')) return get ? array(jsonSchema(layoutDefinition)) : { ...jsonSchema(layoutDefinition), properties: { ...jsonSchema(layoutDefinition).properties, draftVersion: integer, publicationRequired: { const: true } } };
  if (p.includes('/views')) { const response = object({ ...identity, typeId: id, userId: id, viewType: { enum: ['LIST','KANBAN'] }, preferences: jsonSchema(view) }); return get ? array(response) : response; }
  if (p.includes('/relation-definitions')) return get ? array(jsonSchema(relationDefinition)) : { ...jsonSchema(relationDefinition), properties: { ...jsonSchema(relationDefinition).properties, draftVersion: integer, publicationRequired: { const: true } } };
  if (p.includes('/relations')) { const response = object({ id, workspaceId: id, typeId: id, sourceItemId: id, definitionId: id, targetType: jsonSchema(relationDefinition).properties.targetType, targetId: id, isPrimary: { type: 'boolean' }, createdAt: instant }); return get ? array(response) : method === 'DELETE' ? object({ id, unlinked: { const: true } }) : response; }
  if (p.includes('/pipelines')) return get ? array(p.includes('/stages') ? stageResponse : pipelineResponse) : p.includes('/stages') ? stageResponse : pipelineResponse;
  if (p.includes('/observers')) return object({ userId: id, observing: { type: 'boolean' } });
  if (p.includes('/items')) return get && p.endsWith('/items') ? array(itemResponse) : method === 'DELETE' ? object({ id, status: { const: 'TRASHED' }, version: integer }) : itemResponse;
  if (p.endsWith('/trash')) return array(object({ id, title: { type: 'string' }, itemNumber: { type: 'string' }, status: { const: 'TRASHED' }, version: integer, trashedAt: instant, purgeAfter: instant }));
  if (p.includes('/capabilities')) return get ? array(object({ id, workspaceId: id, typeId: id, key: { type: 'string' }, enabled: { type: 'boolean' }, configuration: { type: 'object' } })) : object({ draftId: id, draftVersion: integer, publicationRequired: { const: true } });
  const type = object({ ...identity, code: { type: 'string' }, name: { type: 'string' }, pluralName: { type: 'string' }, placement: { enum: ['CRM','AUTOMATION'] }, status: { enum: ['DRAFT','ACTIVE','ARCHIVED','DELETION_PENDING'] }, schemaVersion: integer,
    description: { type: ['string','null'] }, createdByUserId: id, deletedAt: { ...instant, type: ['string','null'] }, capabilities: array(resource), permissions: strings,
    fieldPermissions: array(object({ code: { type: 'string' }, canView: { const: true }, canEdit: { type: 'boolean' } })) }, ['id','workspaceId','code','name','pluralName','status','version','schemaVersion']);
  return get && !p ? array(type) : type;
}
export function spaPaths() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const entry of spaRouter.entries) {
    const path = entry.path.replace('/api/v1', '').replace(/:(\w+)/g, '{$1}'), contract = spaRequestContract(entry.method, entry.path);
    const parameters: Schema[] = [{ name: 'X-Workspace-Id', in: 'header', required: true, schema: { type: 'string', format: 'uuid' } },
      ...[...entry.path.matchAll(/:(\w+)/g)].map(m => ({ name: m[1], in: 'path', required: true, schema: m[1] === 'key' ? { type: 'string' } : { type: 'string', format: 'uuid' } }))];
    if (entry.method === 'POST' && entry.path.endsWith('/items')) parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } });
    if (contract.query) { const query = jsonSchema(contract.query); for (const [name, schema] of Object.entries(query.properties ?? {})) parameters.push({ name, in: 'query', required: query.required?.includes(name) ?? false, schema }); }
    const response = spaResponseContract(entry.method, entry.path);
    const success = { type: 'object', required: ['success','data'], properties: { success: { const: true }, data: response,
      meta: { type: ['object','null'], properties: { page: { type: 'integer' }, limit: { type: 'integer', maximum: 100 }, total: { type: 'integer' }, totalPages: { type: 'integer' } } } } };
    const error = { type: 'object', required: ['success','error','requestId'], properties: { success: { const: false }, error: { type: 'object', required: ['code','message'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } }, requestId: { type: 'string', format: 'uuid' } } };
    const responses: Schema = { [entry.status]: { description: entry.status === 202 ? 'Durable job accepted; success is confirmed only by terminal job evidence.' : 'Authorized result committed or read.', content: { 'application/json': { schema: success } } } };
    for (const [code, description] of Object.entries({ 400: 'Strict DTO / identifier / idempotency validation failed.', 401: 'Missing, invalid, expired or revoked credential.', 403: 'Current membership, declared permission, scope, field, capability entitlement or external spa.read/spa.write scope denied.',
      404: 'Resource absent from the resolved Workspace.', 409: 'RESOURCE_VERSION_CONFLICT, conflicting lifecycle/cardinality or blocked retention; no partial mutation.', 410: 'Export or File capability expired.', 422: 'Schema validation, references, required stage fields, migration or quota constraint failed.', 429: 'Shared rate limit exceeded.', 503: 'Database or configured Files provider unavailable.' })) responses[code] = { description, content: { 'application/json': { schema: error } } };
    paths[path] ??= {}; paths[path][entry.method.toLowerCase()] = { tags: ['Smart Process Automation'], operationId: entry.controller + '_' + entry.method + '_' + path.replace(/[^a-zA-Z0-9]+/g, '_'),
      summary: entry.method + ' ' + path, description: 'Requires ' + contract.permission + '. Explicit Workspace grants intersect current Type/Stage scope and field rules. SaaS grants and external credentials never broaden domain authority. Optimistic mutations use expectedVersion; idempotent Item creation records the command and effect in one transaction.',
      'x-permission': contract.permission, security: [{ bearerAuth: [] }], parameters, responses,
      ...(contract.body ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(contract.body) } } } } : {}) };
  }
  return paths;
}
