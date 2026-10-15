import { z } from 'zod';
import { code, name, uuid, version } from '../process-platform/dto';

export const entityType = z.enum(['CONTACT','COMPANY','LEAD','DEAL','SPA_ITEM','TASK','PROJECT','EVENT','FILE','DOCUMENT','PRODUCT','INVENTORY_DOCUMENT','ORDER']);
export const concurrency = z.enum(['ONE_PER_DEFINITION_PER_ENTITY','ALLOW_PARALLEL','ONE_WORKFLOW_PER_ENTITY','CUSTOM_KEY']);
export const executionIdentity = z.union([z.literal('STARTER'), z.strictObject({ type: z.literal('SERVICE_ACCOUNT'), userId: uuid })]);
export const createDefinition = z.strictObject({ name, code, type: z.enum(['SEQUENTIAL','STATUS_DRIVEN']), boundEntityType: entityType,
  boundEntityTypeId: uuid.optional(), concurrencyMode: concurrency.default('ONE_PER_DEFINITION_PER_ENTITY'), runAs: executionIdentity.default('STARTER') });
export const parameterDefinition = z.strictObject({ code, datatype: z.enum(['TEXT','NUMBER','MONEY','BOOLEAN','DATE','DATETIME','USER','ENTITY_REF','JSON_TYPED']),
  required: z.boolean().default(false), validation: z.record(z.string(), z.json()).default({}), defaultValue: z.json().optional(),
  classification: z.enum(['PUBLIC','BUSINESS','SENSITIVE','SECRET']).default('BUSINESS') });
export const startCondition = z.strictObject({ eventType: z.string().regex(/^[A-Z][A-Z0-9_.]{1,100}$/), condition: z.string().max(4000).optional(),
  enabled: z.boolean().default(true), priority: z.number().int().min(0).max(1000).default(0) });
export const patchDefinition = z.strictObject({ expectedVersion: version, name: name.optional(), concurrencyMode: concurrency.optional(),
  startConditions: z.array(startCondition).max(100).optional(), runAs: executionIdentity.optional() });
export const nodeKinds = ['START','END','ACTION','CONDITION','SWITCH','PARALLEL_SPLIT','PARALLEL_JOIN','EVENT_RACE','WAIT_EVENT','TIMER',
  'WHILE','FOR_EACH','SET_VARIABLE','APPROVAL','REQUEST_INFO','CREATE_TASK','CREATE_ENTITY','UPDATE_ENTITY','CHANGE_STAGE','SEND_NOTIFICATION',
  'GENERATE_DOCUMENT','HTTP_REQUEST','OUTBOUND_WEBHOOK','SUB_WORKFLOW','TERMINATE'] as const;
export const nodeKind = z.enum(nodeKinds);
const expression = z.string().trim().min(1).max(4000);
const mapping = z.record(z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/), expression);
const boundedCount = z.number().int().min(1).max(1000);
const timeout = z.discriminatedUnion('type', [z.strictObject({ type: z.literal('TIMEOUT_BRANCH') }), z.strictObject({ type: z.literal('REMIND'), intervalSeconds: z.number().int().min(60).max(86400), maxReminders: z.number().int().min(1).max(10) }),
  z.strictObject({ type: z.enum(['ESCALATE','DELEGATE']), toUserId: uuid }), z.strictObject({ type: z.enum(['AUTO_REJECT','AUTO_APPROVE']) })]);
const approval = z.strictObject({ assigneeUserIds: z.array(uuid).min(1).max(100).refine(ids => new Set(ids).size === ids.length),
  policy: z.enum(['ANY','ALL','QUORUM']).default('ALL'), quorumCount: z.number().int().min(1).max(100).optional(),
  rejectPolicy: z.enum(['ANY_REJECT','ALL_REJECT','QUORUM_REJECT']).default('ANY_REJECT'), dueSeconds: z.number().int().min(1).max(31536000).optional(),
  timeoutPolicy: timeout.default({ type: 'TIMEOUT_BRANCH' }), informationSchema: z.array(parameterDefinition).max(100).default([]) });
export const actionConfig = z.strictObject({ actionCode: z.string().regex(/^[A-Z][A-Z0-9_.]{1,100}$/), input: z.record(z.string(), z.json()),
  inputExpressions: z.record(z.string(), expression).default({}), compensation: z.strictObject({ actionCode: z.string().regex(/^[A-Z][A-Z0-9_.]{1,100}$/),
    input: z.record(z.string(), z.json()), inputExpressions: z.record(z.string(), expression).default({}) }).optional(),
  maxAttempts: z.number().int().min(1).max(5).default(3) });
export const httpConfig = z.strictObject({ connectionId: uuid, path: z.string().max(1000).default('/'), method: z.enum(['GET','POST','PUT','PATCH','DELETE']).default('POST'),
  body: z.record(z.string(), z.json()).default({}), timeoutMs: z.number().int().min(100).max(30000).default(10000), maxAttempts: z.number().int().min(1).max(5).default(3),
  waitForCallback: z.boolean().default(false) });
export const configs: Record<(typeof nodeKinds)[number], z.ZodType> = {
  START: z.strictObject({}), END: z.strictObject({ result: expression.optional() }), TERMINATE: z.strictObject({ resultCode: z.string().max(64).default('TERMINATED') }),
  ACTION: actionConfig, CREATE_TASK: actionConfig, CREATE_ENTITY: actionConfig, UPDATE_ENTITY: actionConfig, CHANGE_STAGE: actionConfig,
  SEND_NOTIFICATION: actionConfig, GENERATE_DOCUMENT: actionConfig, HTTP_REQUEST: httpConfig, OUTBOUND_WEBHOOK: httpConfig,
  CONDITION: z.strictObject({ expression }), SWITCH: z.strictObject({ expression, cases: z.array(z.strictObject({ value: z.json(), edgeType: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/) })).min(1).max(100) }),
  PARALLEL_SPLIT: z.strictObject({ joinNodeKey: code }), EVENT_RACE: z.strictObject({ joinNodeKey: code }),
  PARALLEL_JOIN: z.strictObject({ splitNodeKey: code, mode: z.enum(['ALL','ANY','QUORUM']).default('ALL'), requiredCount: boundedCount.optional() }),
  WAIT_EVENT: z.strictObject({ eventType: z.string().regex(/^[A-Z][A-Z0-9_.]{1,100}$/), correlationKey: expression, timeoutSeconds: z.number().int().min(1).max(31536000).optional() }),
  TIMER: z.discriminatedUnion('type', [z.strictObject({ type: z.literal('ABSOLUTE'), scheduledFor: z.iso.datetime({ offset: true }) }),
    z.strictObject({ type: z.literal('RELATIVE'), seconds: z.number().int().min(1).max(31536000) }),
    z.strictObject({ type: z.literal('WORKDAY_AWARE'), seconds: z.number().int().min(1).max(31536000) })]),
  WHILE: z.strictObject({ expression, maxIterations: boundedCount, bodyNodeKey: code, exitNodeKey: code }),
  FOR_EACH: z.strictObject({ collection: expression, maxIterations: boundedCount, itemVariable: code, bodyNodeKey: code, exitNodeKey: code }),
  SET_VARIABLE: z.strictObject({ variable: code, expression }), APPROVAL: approval, REQUEST_INFO: approval,
  SUB_WORKFLOW: z.strictObject({ workflowId: uuid, versionId: uuid.optional(), inputMapping: mapping, outputMapping: mapping,
    waitForCompletion: z.boolean().default(true) }),
};
export const node = z.strictObject({ id: uuid, nodeKey: code, nodeType: nodeKind, config: z.record(z.string(), z.json()),
  position: z.strictObject({ x: z.number().finite().min(-100000).max(100000), y: z.number().finite().min(-100000).max(100000) }) });
export const edge = z.strictObject({ id: uuid, fromNodeId: uuid, toNodeId: uuid,
  edgeType: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).default('NEXT'), condition: expression.optional(), sortOrder: z.number().int().min(0).max(10000).default(0) });
export const graph = z.strictObject({ nodes: z.array(node).max(500), edges: z.array(edge).max(2000),
  parameters: z.array(parameterDefinition).max(100).default([]), variables: z.array(parameterDefinition).max(100),
  constants: z.array(parameterDefinition).max(100) });
export type Graph = z.infer<typeof graph>;
export type Node = z.infer<typeof node>;
export type Parameter = z.infer<typeof parameterDefinition>;
export const limits = z.strictObject({ maxLoopIterations: boundedCount, maxNodeRuns: z.number().int().min(1).max(10000),
  maxDepth: z.number().int().min(1).max(10), maxLifetimeDays: z.number().int().min(1).max(365), retentionDays: z.number().int().min(1).max(3650).optional() });
