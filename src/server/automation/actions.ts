import type { ActorContext } from '../access-service';
import type { ActivityService } from '../activities/activity-service';
import type { CrmCoreService } from '../crm-core-service';
import type { CrmPipelineService } from '../crm-pipeline-service';
import type { CrmRecordEntityType, User } from '../domain';
import { AppError } from '../errors';
import { canonicalDecimal } from '../fields/decimal';
import type { CommunicationPort, DocumentPort, NotificationPort, SecretPort } from '../ports';
import type { InMemoryStore } from '../store';
import type { EgressPort, EgressRequest } from './egress';
import { EgressError, assertSafeUrlShape } from './egress';
import { redact } from './redact';
import type { ConfigField, Problem, TargetRecord } from './registry';
import type { TargetRegistry } from './registry';

export class ActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

const RETRYABLE_CODES = new Set(['RATE_LIMITED', 'ACTIVITY_ADAPTER_UNAVAILABLE', 'CRM_VERSION_CONFLICT', 'ACTIVITY_VERSION_CONFLICT', 'FILES_UNAVAILABLE', 'AUTOMATION_PORT_UNAVAILABLE']);

/** Business validation/permission failures are permanent; only transient platform/provider problems are retried. */
export function toActionError(error: unknown, secrets: string[] = []): ActionError {
  if (error instanceof ActionError) return error;
  if (error instanceof EgressError) return new ActionError(error.code, error.message, error.retryable);
  if (error instanceof AppError) {
    return new ActionError(error.code, redact(error.message, secrets), error.status >= 500 || RETRYABLE_CODES.has(error.code));
  }
  return new ActionError('AUTOMATION_ACTION_INTERNAL', 'The action failed unexpectedly.', true);
}

export type ActionServices = {
  store: InMemoryStore;
  targets: TargetRegistry;
  crm: CrmPipelineService;
  crmCore: CrmCoreService;
  activities: ActivityService;
  notifications: () => NotificationPort | null;
  communication: () => CommunicationPort | null;
  documents: () => DocumentPort | null;
  secrets: () => SecretPort;
  egress: () => EgressPort;
  allowHttp: () => boolean;
};

export type ActionContext = {
  workspaceId: string;
  user: User;
  actor: ActorContext;
  targetType: string;
  target: TargetRecord;
  idempotencyKey: string;
  executionId: string;
  services: ActionServices;
};

export type ActionValidationEnv = { workspaceId: string; targetType: string; services: ActionServices };

export type NetworkCall = { request: EgressRequest; secrets: string[]; describe: Record<string, unknown> };

export interface ActionDescriptor {
  readonly code: string;
  readonly label: string;
  readonly category: string;
  readonly description: string;
  readonly ownerModule: string;
  readonly targetTypes: string[] | '*';
  readonly configFields: ConfigField[];
  /** DOMAIN: owner service call inside the state transaction. ADAPTER: provider call keyed by the action idempotency key. NETWORK: off-transaction HTTP call. */
  readonly sideEffect: 'DOMAIN' | 'ADAPTER' | 'NETWORK';
  readonly idempotency: 'ATOMIC_WITH_RECORD' | 'PROVIDER_KEY';
  readonly timeoutMs: number;
  readonly supportsContinueOnError: boolean;
  readonly isExtension?: boolean;
  /** Permissions the executing identity must hold for this target type (owning services still decide). */
  requiredPermissions(targetType: string): string[];
  /** Union used to scope the Automation service identity. */
  readonly allPermissions: string[];
  isAvailable(services: ActionServices): boolean;
  validate(config: Record<string, unknown>, env: ActionValidationEnv): Problem[];
  /** Safe, side-effect-free preview of the resolved configuration (secrets redacted by the caller). */
  preview(resolved: Record<string, unknown>): Record<string, unknown>;
  execute?(ctx: ActionContext, input: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown>;
  buildNetworkCall?(ctx: ActionContext, input: Record<string, unknown>): NetworkCall;
  summarizeNetwork?(response: { status: number; bytes: number }): Record<string, unknown>;
}

const CRM_TARGETS = ['LEAD', 'DEAL', 'CONTACT', 'COMPANY'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMPLATE = /\{\{[^}]+\}\}/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const problem = (path: string, message: string, code = 'AUTOMATION_ACTION_CONFIG_INVALID'): Problem => ({ path, code, message });

function unknownKeys(config: Record<string, unknown>, allowed: string[]): Problem[] {
  return Object.keys(config).filter((key) => !allowed.includes(key)).map((key) => problem(`$.${key}`, `Unsupported setting "${key}".`));
}

/** A value that is either a constant of the wanted kind or a `{{template}}`. */
const isUuidOrTemplate = (value: unknown) => typeof value === 'string' && (UUID.test(value) || TEMPLATE.test(value));

const perms = (entity: string, ...actions: string[]) => actions.map((action) => `crm.${entity}.${action}`);
const ALL_ENTITIES = ['lead', 'deal', 'contact', 'company'];
const entityOf = (targetType: string) => targetType.toLowerCase();

abstract class BaseAction implements ActionDescriptor {
  abstract readonly code: string;
  abstract readonly label: string;
  abstract readonly category: string;
  abstract readonly description: string;
  abstract readonly ownerModule: string;
  targetTypes: string[] | '*' = CRM_TARGETS;
  abstract readonly configFields: ConfigField[];
  sideEffect: 'DOMAIN' | 'ADAPTER' | 'NETWORK' = 'DOMAIN';
  idempotency: 'ATOMIC_WITH_RECORD' | 'PROVIDER_KEY' = 'ATOMIC_WITH_RECORD';
  timeoutMs = 15_000;
  supportsContinueOnError = true;
  abstract requiredPermissions(targetType: string): string[];
  abstract readonly allPermissions: string[];
  isAvailable(_services: ActionServices) {
    return true;
  }
  abstract validate(config: Record<string, unknown>, env: ActionValidationEnv): Problem[];
  preview(resolved: Record<string, unknown>) {
    return resolved;
  }
}

class UpdateFieldsAction extends BaseAction {
  code = 'crm.update_fields';
  label = 'Update fields';
  category = 'CRM';
  description = 'Set system or custom field values on the record.';
  ownerModule = 'CRM Core';
  configFields: ConfigField[] = [{ key: 'fields', label: 'Fields to update', type: 'field-map', required: true, help: 'Values may use {{target.*}} / {{trigger.payload.*}} variables.' }];
  allPermissions = ALL_ENTITIES.flatMap((entity) => perms(entity, 'update'));
  requiredPermissions(targetType: string) {
    return perms(entityOf(targetType), 'update');
  }

  validate(config: Record<string, unknown>, env: ActionValidationEnv): Problem[] {
    const problems = unknownKeys(config, ['fields']);
    if (!isRecord(config.fields) || Object.keys(config.fields).length === 0 || Object.keys(config.fields).length > 30) {
      problems.push(problem('$.fields', 'Select 1-30 fields to update.'));
      return problems;
    }
    const target = env.services.targets.find(env.targetType);
    const updatable = new Map((target?.fields(env.workspaceId) ?? []).filter((field) => field.updatable).map((field) => [field.key, field]));
    for (const [key, value] of Object.entries(config.fields)) {
      if (!updatable.has(key)) problems.push(problem(`$.fields.${key}`, `"${key}" is not an updatable field of ${env.targetType}.`, 'AUTOMATION_FIELD_UNAVAILABLE'));
      else if (typeof value === 'object' && value !== null) problems.push(problem(`$.fields.${key}`, 'Field values must be text, numbers, booleans or null.'));
    }
    return problems;
  }

  async execute(ctx: ActionContext, input: Record<string, unknown>) {
    const fields = input.fields as Record<string, unknown>;
    const descriptors = new Map((ctx.services.targets.get(ctx.targetType).fields(ctx.workspaceId)).map((field) => [field.key, field]));
    const system: Record<string, unknown> = {};
    const custom: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(fields)) {
      const descriptor = descriptors.get(key)!;
      let value: unknown = raw === '' ? null : raw;
      if (descriptor.dataType === 'NUMBER' && descriptor.source === 'system' && value !== null) {
        const canonical = canonicalDecimal(value);
        if (canonical === null) throw new ActionError('AUTOMATION_ACTION_INPUT_INVALID', `"${key}" needs a numeric value.`);
        value = Number(canonical);
      }
      if (key.startsWith('customFields.')) custom[key.slice('customFields.'.length)] = value;
      else system[key] = value;
    }
    const current = ctx.target.version;
    const record = ctx.services.crmCore.updateRecord(ctx.user, ctx.workspaceId, ctx.targetType as CrmRecordEntityType, ctx.target.id, {
      ...system,
      ...(Object.keys(custom).length > 0 ? { customFields: custom } : {}),
      expectedVersion: current,
    });
    return { updated: Object.keys(fields), version: record.version };
  }
}

class SetResponsibleAction extends BaseAction {
  code = 'crm.set_responsible';
  label = 'Set responsible user';
  category = 'CRM';
  description = 'Assign the record to a user.';
  ownerModule = 'CRM Core';
  configFields: ConfigField[] = [{ key: 'userId', label: 'Responsible user', type: 'user', required: true }];
  allPermissions = ALL_ENTITIES.flatMap((entity) => perms(entity, 'assign', 'read'));
  requiredPermissions(targetType: string) {
    return perms(entityOf(targetType), 'assign');
  }
  validate(config: Record<string, unknown>): Problem[] {
    const problems = unknownKeys(config, ['userId']);
    if (!isUuidOrTemplate(config.userId)) problems.push(problem('$.userId', 'Choose a user (or a {{variable}} that resolves to one).'));
    return problems;
  }
  execute(ctx: ActionContext, input: Record<string, unknown>) {
    const userId = String(input.userId ?? '');
    if (!UUID.test(userId)) throw new ActionError('AUTOMATION_ACTION_INPUT_INVALID', 'The responsible user could not be resolved.');
    if (ctx.target.responsibleUserId === userId) return { assigned: false, responsibleUserId: userId };
    const record = ctx.services.crmCore.assignRecord(ctx.user, ctx.workspaceId, ctx.targetType as CrmRecordEntityType, ctx.target.id, { responsibleUserId: userId, expectedVersion: ctx.target.version ?? 0 });
    return { assigned: true, responsibleUserId: userId, version: record.version };
  }
}

class MoveStageAction extends BaseAction {
  code = 'crm.move_stage';
  label = 'Move to stage';
  category = 'Pipeline';
  description = 'Move a Lead or Deal through the pipeline service (transition rules and required fields still apply).';
  ownerModule = 'Pipelines';
  targetTypes = ['LEAD', 'DEAL'];
  configFields: ConfigField[] = [
    { key: 'stageId', label: 'Target stage', type: 'stage', required: true },
    { key: 'lostReasonId', label: 'Lost reason (failure stages)', type: 'text' },
  ];
  allPermissions = ['crm.lead.transition', 'crm.deal.transition'];
  requiredPermissions(targetType: string) {
    return [`crm.${entityOf(targetType)}.transition`];
  }
  validate(config: Record<string, unknown>, env: ActionValidationEnv): Problem[] {
    const problems = unknownKeys(config, ['stageId', 'lostReasonId']);
    const stage = env.services.store.state.crmStages.find((item) => item.id === config.stageId && item.workspaceId === env.workspaceId);
    const pipeline = stage ? env.services.store.state.crmPipelines.find((item) => item.id === stage.pipelineId) : undefined;
    if (!stage || !pipeline || pipeline.entityType !== env.targetType) problems.push(problem('$.stageId', 'The target stage does not exist for this target.', 'AUTOMATION_STAGE_UNAVAILABLE'));
    else if (!stage.isActive) problems.push(problem('$.stageId', 'The target stage is inactive.', 'AUTOMATION_STAGE_UNAVAILABLE'));
    if (config.lostReasonId !== undefined && typeof config.lostReasonId !== 'string') problems.push(problem('$.lostReasonId', 'lostReasonId must be a lost-reason id.'));
    return problems;
  }
  execute(ctx: ActionContext, input: Record<string, unknown>) {
    const stageId = String(input.stageId);
    if (ctx.target.stage?.stageId === stageId) return { moved: false, stageId };
    const stage = ctx.services.store.state.crmStages.find((item) => item.id === stageId && item.workspaceId === ctx.workspaceId);
    const payload = { expectedVersion: ctx.target.version ?? 0, targetStageId: stageId, targetPipelineId: stage && stage.pipelineId !== ctx.target.stage?.pipelineId ? stage.pipelineId : undefined, lostReasonId: typeof input.lostReasonId === 'string' && input.lostReasonId ? input.lostReasonId : undefined };
    const record = ctx.targetType === 'LEAD' ? ctx.services.crm.transitionLead(ctx.user, ctx.workspaceId, ctx.target.id, payload) : ctx.services.crm.transitionDeal(ctx.user, ctx.workspaceId, ctx.target.id, payload);
    return { moved: true, stageId, version: record.version };
  }
}

class CreateRecordAction extends BaseAction {
  code = 'crm.create_record';
  label = 'Create CRM record';
  category = 'CRM';
  description = 'Create a Contact, Company, Lead or Deal through its owning service.';
  ownerModule = 'CRM Core';
  targetTypes: string[] | '*' = '*';
  configFields: ConfigField[] = [
    { key: 'entityType', label: 'Record type', type: 'select', required: true, options: ['CONTACT', 'COMPANY', 'LEAD', 'DEAL'].map((value) => ({ value, label: value })) },
    { key: 'values', label: 'Values', type: 'field-map', required: true },
  ];
  allPermissions = ALL_ENTITIES.flatMap((entity) => perms(entity, 'create', 'read'));
  requiredPermissions() {
    return [];
  }
  private static readonly KEYS: Record<string, string[]> = {
    CONTACT: ['firstName', 'lastName'],
    COMPANY: ['name'],
    LEAD: ['title', 'firstName', 'lastName', 'companyName'],
    DEAL: ['title', 'companyId'],
  };
  validate(config: Record<string, unknown>): Problem[] {
    const problems = unknownKeys(config, ['entityType', 'values']);
    const type = String(config.entityType);
    if (!CreateRecordAction.KEYS[type]) {
      problems.push(problem('$.entityType', 'entityType must be CONTACT, COMPANY, LEAD or DEAL.'));
      return problems;
    }
    if (!isRecord(config.values)) return [...problems, problem('$.values', 'values must be an object.')];
    for (const key of Object.keys(config.values)) if (!CreateRecordAction.KEYS[type].includes(key)) problems.push(problem(`$.values.${key}`, `"${key}" cannot be set when creating a ${type}.`));
    return problems;
  }
  execute(ctx: ActionContext, input: Record<string, unknown>) {
    const type = String(input.entityType);
    const values = isRecord(input.values) ? input.values : {};
    const responsible = ctx.target.responsibleUserId && ctx.services.store.state.workspaceMemberships.some((m) => m.workspaceId === ctx.workspaceId && m.userId === ctx.target.responsibleUserId && m.status === 'ACTIVE' && !m.isDeleted) ? ctx.target.responsibleUserId : undefined;
    const common = { responsibleUserId: responsible };
    if (type === 'CONTACT') {
      const record = ctx.services.crmCore.createContact(ctx.user, ctx.workspaceId, { firstName: String(values.firstName ?? ''), lastName: String(values.lastName ?? ''), ...common });
      return { entityType: type, id: record.id };
    }
    if (type === 'COMPANY') {
      const record = ctx.services.crmCore.createCompany(ctx.user, ctx.workspaceId, { name: String(values.name ?? ''), ...common });
      return { entityType: type, id: record.id };
    }
    if (type === 'LEAD') {
      const record = ctx.services.crm.createLead(ctx.user, ctx.workspaceId, { title: String(values.title ?? ''), firstName: (values.firstName as string) || undefined, lastName: (values.lastName as string) || undefined, companyName: (values.companyName as string) || undefined, ...common }, ctx.idempotencyKey);
      return { entityType: type, id: record.id };
    }
    const record = ctx.services.crm.createDeal(ctx.user, ctx.workspaceId, { title: String(values.title ?? ''), companyId: (values.companyId as string) || undefined, ...common }, ctx.idempotencyKey);
    return { entityType: type, id: record.id };
  }
}

const OFFSET_MAX = 525_600;

class CreateActivityAction extends BaseAction {
  code = 'activities.create_activity';
  label = 'Create Activity';
  category = 'Activities';
  description = 'Create an Activity bound to the record through the Activities service.';
  ownerModule = 'Activities';
  configFields: ConfigField[] = [
    { key: 'typeCode', label: 'Activity type', type: 'activity-type', required: true },
    { key: 'subject', label: 'Subject', type: 'text', required: true },
    { key: 'description', label: 'Description', type: 'textarea' },
    { key: 'deadlineOffsetMinutes', label: 'Deadline (minutes from now)', type: 'number' },
    { key: 'responsibleUserId', label: 'Responsible user (default: record owner)', type: 'user' },
  ];
  allPermissions = ['activity.create', 'activity.assign', ...ALL_ENTITIES.flatMap((entity) => perms(entity, 'read'))];
  requiredPermissions() {
    return ['activity.create'];
  }
  fixedType: string | null = null;
  validate(config: Record<string, unknown>, env: ActionValidationEnv): Problem[] {
    const problems = unknownKeys(config, this.fixedType ? ['subject', 'description', 'deadlineOffsetMinutes', 'responsibleUserId'] : ['typeCode', 'subject', 'description', 'deadlineOffsetMinutes', 'responsibleUserId']);
    if (typeof config.subject !== 'string' || !config.subject.trim() || config.subject.length > 300) problems.push(problem('$.subject', 'A subject is required (max 300 characters).'));
    if (!this.fixedType && (typeof config.typeCode !== 'string' || !/^[A-Z][A-Z0-9_]{1,49}$/.test(config.typeCode))) problems.push(problem('$.typeCode', 'Choose an Activity type.'));
    if (config.description !== undefined && (typeof config.description !== 'string' || config.description.length > 20000)) problems.push(problem('$.description', 'description must be text.'));
    if (config.deadlineOffsetMinutes !== undefined && (typeof config.deadlineOffsetMinutes !== 'number' || !Number.isInteger(config.deadlineOffsetMinutes) || config.deadlineOffsetMinutes < 0 || config.deadlineOffsetMinutes > OFFSET_MAX)) problems.push(problem('$.deadlineOffsetMinutes', 'deadlineOffsetMinutes must be between 0 and 525600.'));
    if (config.responsibleUserId !== undefined && !isUuidOrTemplate(config.responsibleUserId)) problems.push(problem('$.responsibleUserId', 'Choose a user or a {{variable}}.'));
    void env;
    return problems;
  }
  async execute(ctx: ActionContext, input: Record<string, unknown>) {
    const typeCode = this.fixedType ?? String(input.typeCode);
    const responsible = typeof input.responsibleUserId === 'string' && UUID.test(input.responsibleUserId) ? input.responsibleUserId : ctx.target.responsibleUserId ?? undefined;
    const activity = await ctx.services.activities.create(
      ctx.user,
      ctx.workspaceId,
      {
        typeCode,
        subject: String(input.subject ?? '').trim(),
        description: typeof input.description === 'string' && input.description ? input.description : undefined,
        deadline: typeof input.deadlineOffsetMinutes === 'number' ? new Date(Date.now() + input.deadlineOffsetMinutes * 60_000).toISOString() : undefined,
        responsibleUserId: responsible,
        bindings: [{ entityType: ctx.targetType, entityId: ctx.target.id }],
      },
      ctx.idempotencyKey,
    );
    return { activityId: activity.id, typeCode };
  }
}

class CreateTaskAction extends CreateActivityAction {
  code = 'tasks.create_task';
  label = 'Create Task';
  category = 'Tasks';
  description = 'Create a Task (an Activity of type TASK) through the Activities service; Task lifecycle stays with the Tasks module.';
  ownerModule = 'Tasks';
  configFields: ConfigField[] = [
    { key: 'subject', label: 'Task title', type: 'text', required: true },
    { key: 'description', label: 'Description', type: 'textarea' },
    { key: 'deadlineOffsetMinutes', label: 'Deadline (minutes from now)', type: 'number' },
    { key: 'responsibleUserId', label: 'Responsible user (default: record owner)', type: 'user' },
  ];
  fixedType = 'TASK';
}

class NotifyUserAction extends BaseAction {
  code = 'notifications.notify_user';
  label = 'Notify users';
  category = 'Notifications';
  description = 'Send an in-app notification through the Notifications module.';
  ownerModule = 'Notifications';
  targetTypes: string[] | '*' = '*';
  sideEffect = 'ADAPTER' as const;
  idempotency = 'PROVIDER_KEY' as const;
  configFields: ConfigField[] = [
    { key: 'userIds', label: 'Recipients', type: 'string-list', required: true, help: 'User ids or {{target.responsibleUserId}}.' },
    { key: 'title', label: 'Title', type: 'text', required: true },
    { key: 'message', label: 'Message', type: 'textarea', required: true },
  ];
  allPermissions: string[] = [];
  requiredPermissions() {
    return [];
  }
  isAvailable(services: ActionServices) {
    return services.notifications() !== null;
  }
  validate(config: Record<string, unknown>): Problem[] {
    const problems = unknownKeys(config, ['userIds', 'title', 'message', 'link']);
    if (!Array.isArray(config.userIds) || config.userIds.length === 0 || config.userIds.length > 50 || config.userIds.some((id) => !isUuidOrTemplate(id))) problems.push(problem('$.userIds', 'Choose 1-50 recipients.'));
    if (typeof config.title !== 'string' || !config.title.trim() || config.title.length > 200) problems.push(problem('$.title', 'A title is required (max 200 characters).'));
    if (typeof config.message !== 'string' || !config.message.trim() || config.message.length > 2000) problems.push(problem('$.message', 'A message is required (max 2000 characters).'));
    return problems;
  }
  async execute(ctx: ActionContext, input: Record<string, unknown>) {
    const port = ctx.services.notifications();
    if (!port) throw new ActionError('AUTOMATION_PORT_UNAVAILABLE', 'Notifications are not available.', true);
    const recipients = [...new Set((Array.isArray(input.userIds) ? input.userIds : []).map(String).filter((id) => UUID.test(id)))];
    const members = new Set(ctx.services.store.state.workspaceMemberships.filter((m) => m.workspaceId === ctx.workspaceId && m.status === 'ACTIVE' && !m.isDeleted).map((m) => m.userId));
    const valid = recipients.filter((id) => members.has(id));
    if (valid.length === 0) throw new ActionError('AUTOMATION_ACTION_INPUT_INVALID', 'No recipient is an active member of this workspace.');
    const result = await port.notifyUsers({ workspaceId: ctx.workspaceId, actorUserId: ctx.user.id, recipientUserIds: valid, title: String(input.title), message: String(input.message), link: typeof input.link === 'string' ? input.link : null, idempotencyKey: ctx.idempotencyKey });
    return { recipients: valid.length, reference: result.reference ?? null };
  }
}

class SendMessageAction extends BaseAction {
  code = 'communication.send_message';
  label = 'Send email / message';
  category = 'Communication';
  description = 'Send through the configured Communication channel; delivery status stays with Communication.';
  ownerModule = 'Communication';
  targetTypes: string[] | '*' = '*';
  sideEffect = 'ADAPTER' as const;
  idempotency = 'PROVIDER_KEY' as const;
  configFields: ConfigField[] = [
    { key: 'channel', label: 'Channel', type: 'select', required: true, options: [{ value: 'EMAIL', label: 'Email' }, { value: 'MESSAGE', label: 'Message' }] },
    { key: 'to', label: 'Recipients', type: 'string-list', required: true },
    { key: 'subject', label: 'Subject', type: 'text' },
    { key: 'body', label: 'Body', type: 'textarea', required: true },
  ];
  allPermissions: string[] = [];
  requiredPermissions() {
    return [];
  }
  isAvailable(services: ActionServices) {
    return services.communication() !== null;
  }
  validate(config: Record<string, unknown>): Problem[] {
    const problems = unknownKeys(config, ['channel', 'to', 'subject', 'body']);
    if (config.channel !== 'EMAIL' && config.channel !== 'MESSAGE') problems.push(problem('$.channel', 'channel must be EMAIL or MESSAGE.'));
    if (!Array.isArray(config.to) || config.to.length === 0 || config.to.length > 20 || config.to.some((item) => typeof item !== 'string' || !item.trim())) problems.push(problem('$.to', 'Choose 1-20 recipients.'));
    if (typeof config.body !== 'string' || !config.body.trim() || config.body.length > 20000) problems.push(problem('$.body', 'A body is required.'));
    if (config.subject !== undefined && (typeof config.subject !== 'string' || config.subject.length > 300)) problems.push(problem('$.subject', 'subject must be text.'));
    return problems;
  }
  async execute(ctx: ActionContext, input: Record<string, unknown>) {
    const port = ctx.services.communication();
    if (!port) throw new ActionError('AUTOMATION_PORT_UNAVAILABLE', 'Communication is not available.', true);
    const to = (Array.isArray(input.to) ? input.to : []).map((item) => String(item).trim()).filter(Boolean);
    if (to.length === 0) throw new ActionError('AUTOMATION_ACTION_INPUT_INVALID', 'No recipient could be resolved.');
    const result = await port.send({ workspaceId: ctx.workspaceId, actorUserId: ctx.user.id, channel: input.channel as 'EMAIL' | 'MESSAGE', to, subject: typeof input.subject === 'string' ? input.subject : null, body: String(input.body), target: { type: ctx.targetType, id: ctx.target.id }, idempotencyKey: ctx.idempotencyKey });
    return { recipients: to.length, reference: result.reference ?? null };
  }
}

class GenerateDocumentAction extends BaseAction {
  code = 'documents.generate_document';
  label = 'Generate document';
  category = 'Documents';
  description = 'Generate a document from a template through the Documents service.';
  ownerModule = 'Files / Documents';
  targetTypes: string[] | '*' = CRM_TARGETS;
  sideEffect = 'ADAPTER' as const;
  idempotency = 'PROVIDER_KEY' as const;
  configFields: ConfigField[] = [
    { key: 'templateId', label: 'Template', type: 'text', required: true },
    { key: 'name', label: 'File name', type: 'text' },
  ];
  allPermissions: string[] = [];
  requiredPermissions() {
    return [];
  }
  isAvailable(services: ActionServices) {
    return services.documents() !== null;
  }
  validate(config: Record<string, unknown>): Problem[] {
    const problems = unknownKeys(config, ['templateId', 'name']);
    if (typeof config.templateId !== 'string' || !config.templateId.trim() || config.templateId.length > 100) problems.push(problem('$.templateId', 'Choose a template.'));
    if (config.name !== undefined && (typeof config.name !== 'string' || config.name.length > 200)) problems.push(problem('$.name', 'name must be text.'));
    return problems;
  }
  async execute(ctx: ActionContext, input: Record<string, unknown>) {
    const port = ctx.services.documents();
    if (!port) throw new ActionError('AUTOMATION_PORT_UNAVAILABLE', 'Documents are not available.', true);
    const result = await port.generate({ workspaceId: ctx.workspaceId, actorUserId: ctx.user.id, templateId: String(input.templateId), name: typeof input.name === 'string' && input.name ? input.name : null, target: { type: ctx.targetType, id: ctx.target.id }, idempotencyKey: ctx.idempotencyKey });
    return { reference: result.reference ?? null, fileId: result.fileId ?? null };
  }
}

const FORBIDDEN_HEADERS = /^(authorization|proxy-authorization|cookie|x-api-key|x-auth-token|host|content-length)$/i;

/** Builds the outbound request. The secret is resolved here (in memory only) and can never reach a log or a stored result. */
export function buildWebhookCall(ctx: ActionContext, input: Record<string, unknown>, options: { url: string; method: string; secretRef?: string | null; timeoutMs?: number; extra?: Record<string, unknown> }): NetworkCall {
  const secrets: string[] = [];
  const headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': ctx.idempotencyKey };
  for (const [name, value] of Object.entries(isRecord(input.headers) ? input.headers : {})) {
    if (!FORBIDDEN_HEADERS.test(name) && typeof value === 'string') headers[name.toLowerCase()] = value.slice(0, 500);
  }
  if (options.secretRef) {
    const secret = ctx.services.secrets().resolve(ctx.workspaceId, options.secretRef);
    if (!secret) throw new ActionError('AUTOMATION_SECRET_UNAVAILABLE', 'The configured credential could not be resolved.');
    secrets.push(secret);
    headers.authorization = `Bearer ${secret}`;
  }
  const bodyValue = input.body !== undefined ? input.body : options.extra;
  const body = bodyValue === undefined ? undefined : typeof bodyValue === 'string' ? bodyValue : JSON.stringify(bodyValue);
  if (body && body.length > 64_000) throw new ActionError('AUTOMATION_ACTION_INPUT_INVALID', 'The request body is too large.');
  return {
    request: { url: options.url, method: options.method as EgressRequest['method'], headers, body, timeoutMs: Math.min(Math.max(options.timeoutMs ?? 10_000, 1_000), 15_000) },
    secrets,
    describe: { url: options.url, method: options.method },
  };
}

class WebhookAction extends BaseAction {
  code = 'integrations.call_webhook';
  label = 'Call webhook';
  category = 'Integrations';
  description = 'Call an HTTPS endpoint through the controlled egress layer (private/internal destinations are blocked).';
  ownerModule = 'Integrations';
  targetTypes: string[] | '*' = '*';
  sideEffect = 'NETWORK' as const;
  idempotency = 'PROVIDER_KEY' as const;
  timeoutMs = 15_000;
  configFields: ConfigField[] = [
    { key: 'url', label: 'URL', type: 'url', required: true },
    { key: 'method', label: 'Method', type: 'select', options: ['POST', 'PUT', 'PATCH', 'GET'].map((value) => ({ value, label: value })) },
    { key: 'secretRef', label: 'Credential reference', type: 'secret-ref', help: 'A reference name in the secure credential store - never the secret itself.' },
    { key: 'body', label: 'JSON body', type: 'json' },
  ];
  allPermissions: string[] = [];
  requiredPermissions() {
    return [];
  }
  validate(config: Record<string, unknown>, env: ActionValidationEnv): Problem[] {
    const problems = unknownKeys(config, ['url', 'method', 'secretRef', 'body', 'headers', 'timeoutMs']);
    if (typeof config.url !== 'string') problems.push(problem('$.url', 'A URL is required.'));
    else if (!TEMPLATE.test(config.url)) {
      try {
        assertSafeUrlShape(config.url, { allowHttp: env.services.allowHttp() });
      } catch (error) {
        problems.push(problem('$.url', error instanceof Error ? error.message : 'The URL is not allowed.', 'AUTOMATION_EGRESS_BLOCKED'));
      }
    } else problems.push(problem('$.url', 'The URL must be a fixed address (variables are not allowed in the destination).', 'AUTOMATION_EGRESS_BLOCKED'));
    if (config.method !== undefined && !['POST', 'PUT', 'PATCH', 'GET'].includes(String(config.method))) problems.push(problem('$.method', 'method must be POST, PUT, PATCH or GET.'));
    if (config.secretRef !== undefined && (typeof config.secretRef !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(config.secretRef))) problems.push(problem('$.secretRef', 'secretRef must be a credential reference name.'));
    if (config.headers !== undefined) {
      if (!isRecord(config.headers) || Object.keys(config.headers).length > 20) problems.push(problem('$.headers', 'headers must be an object (max 20).'));
      else for (const name of Object.keys(config.headers)) if (FORBIDDEN_HEADERS.test(name)) problems.push(problem(`$.headers.${name}`, 'Credentials must use secretRef, not a plain header.', 'AUTOMATION_SECRET_MUST_BE_REFERENCE'));
    }
    if (config.timeoutMs !== undefined && (typeof config.timeoutMs !== 'number' || config.timeoutMs < 1000 || config.timeoutMs > 15000)) problems.push(problem('$.timeoutMs', 'timeoutMs must be between 1000 and 15000.'));
    return problems;
  }
  preview(resolved: Record<string, unknown>) {
    return { url: resolved.url, method: resolved.method ?? 'POST', secretRef: resolved.secretRef ?? null, body: redact(resolved.body ?? null) };
  }
  buildNetworkCall(ctx: ActionContext, input: Record<string, unknown>) {
    return buildWebhookCall(ctx, input, { url: String(input.url), method: String(input.method ?? 'POST'), secretRef: typeof input.secretRef === 'string' ? input.secretRef : null, timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined });
  }
  summarizeNetwork(response: { status: number; bytes: number }) {
    return { status: response.status, responseBytes: response.bytes };
  }
}

export function builtInActions(): ActionDescriptor[] {
  return [new UpdateFieldsAction(), new SetResponsibleAction(), new MoveStageAction(), new CreateRecordAction(), new CreateActivityAction(), new CreateTaskAction(), new NotifyUserAction(), new SendMessageAction(), new GenerateDocumentAction(), new WebhookAction()];
}

export { BaseAction };
