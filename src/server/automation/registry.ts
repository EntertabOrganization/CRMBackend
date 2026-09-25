import type { ActorContext } from '../access-service';
import type { OutboxEvent } from '../domain';
import type { FieldEngine } from '../fields/field-engine';
import type { FieldEntityRegistry } from '../fields/entity-registry';
import type { ConditionDataType } from '../fields/field-types';
import { fieldTypeRegistry } from '../fields/field-types';
import type { CustomField } from '../fields/types';
import type { InMemoryStore } from '../store';
import type { ActionDescriptor } from './actions';
import type { OperandDescriptor } from './conditions';
import type { AutomationExtension, SchemaNode, TriggerContext } from './types';

export type Problem = { path: string; code: string; message: string; section?: string };

export type TargetField = {
  key: string;
  label: string;
  dataType: ConditionDataType;
  source: 'system' | 'custom' | 'derived';
  updatable: boolean;
  options?: Array<{ id: string; code: string; label: string }>;
};

/** A snapshot of the authoritative record. Never copied into jobs; reloaded whenever current state matters. */
export type TargetRecord = {
  id: string;
  title: string;
  /** Operand values for the condition engine (custom LIST fields expose both option id and code). */
  conditionValues: Record<string, unknown[]>;
  /** Display values for templates. */
  templateValues: Record<string, unknown>;
  isActionable: boolean;
  version: number | null;
  responsibleUserId: string | null;
  stage: { pipelineId: string | null; stageId: string | null } | null;
};

export interface AutomationTargetDescriptor {
  readonly targetType: string;
  readonly label: string;
  readonly supportsStages: boolean;
  /** Pipeline entity type when the target has pipelines/stages. */
  readonly stageEntityType?: 'LEAD' | 'DEAL';
  fields(workspaceId: string): TargetField[];
  load(workspaceId: string, id: string): TargetRecord | null;
  canAccess(actor: ActorContext, id: string, action: 'read' | 'update'): boolean;
  /** Date/datetime fields usable for relative-to-field scheduling. */
  timingFields(workspaceId: string): Array<{ ref: string; label: string }>;
  /** Values for a whole-record read by the action layer (current version etc.). */
}

const CONDITION_TYPES = new Set(['TEXT', 'TEXTAREA', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'DATE', 'DATETIME', 'LIST', 'MULTI_LIST', 'PHONE', 'EMAIL', 'URL', 'MONEY', 'USER_REFERENCE']);

const STATUS_OPTIONS: Record<string, string[]> = {
  LEAD: ['ACTIVE', 'QUALIFIED', 'DISQUALIFIED'],
  DEAL: ['OPEN', 'WON', 'LOST'],
  ACTIVITY: ['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
};

function conditionValuesOf(field: CustomField, items: unknown[], options: Array<{ id: string; code: string }>): unknown[] {
  switch (field.fieldType) {
    case 'LIST':
    case 'MULTI_LIST':
      return items.flatMap((id) => {
        const option = options.find((item) => item.id === id);
        return option ? [option.id, option.code] : [id];
      });
    case 'MONEY':
      return items.map((item) => (item as { amount: string }).amount);
    default:
      return items;
  }
}

/** Registers any entity the shared field engine knows (Lead, Deal, Contact, Company, Activity, ...) as an automation target. */
export class FieldEngineTarget implements AutomationTargetDescriptor {
  constructor(
    readonly targetType: string,
    readonly label: string,
    readonly supportsStages: boolean,
    private readonly store: InMemoryStore,
    private readonly fieldEngine: FieldEngine,
    private readonly registry: FieldEntityRegistry,
    private readonly titleOf: (record: Record<string, unknown>) => string,
    private readonly actionable: (record: Record<string, unknown>) => boolean,
  ) {}

  get stageEntityType(): 'LEAD' | 'DEAL' | undefined {
    return this.supportsStages ? (this.targetType as 'LEAD' | 'DEAL') : undefined;
  }

  private customFields(workspaceId: string) {
    return this.store.state.crmCustomFields
      .filter((field) => field.workspaceId === workspaceId && field.entityType === this.targetType && field.isActive && CONDITION_TYPES.has(field.fieldType))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  fields(workspaceId: string): TargetField[] {
    const adapter = this.registry.get(this.targetType);
    const out: TargetField[] = adapter
      .systemFields()
      .filter((descriptor) => descriptor.conditionCapable)
      .map((descriptor) => ({
        key: descriptor.key,
        label: descriptor.label,
        dataType: descriptor.dataType,
        source: 'system' as const,
        updatable: descriptor.editable,
        options: descriptor.key === 'status' && STATUS_OPTIONS[this.targetType] ? STATUS_OPTIONS[this.targetType].map((value) => ({ id: value, code: value, label: value })) : undefined,
      }));
    if (this.supportsStages) {
      const stages = this.store.state.crmStages.filter((stage) => stage.workspaceId === workspaceId && stage.isActive && this.store.state.crmPipelines.some((pipeline) => pipeline.id === stage.pipelineId && pipeline.entityType === this.targetType));
      out.push({ key: 'pipelineId', label: 'Pipeline', dataType: 'ENUM', source: 'derived', updatable: false, options: this.store.state.crmPipelines.filter((pipeline) => pipeline.workspaceId === workspaceId && pipeline.isActive && pipeline.entityType === this.targetType).map((pipeline) => ({ id: pipeline.id, code: pipeline.id, label: pipeline.name })) });
      out.push({ key: 'stageId', label: 'Stage', dataType: 'ENUM', source: 'derived', updatable: false, options: stages.map((stage) => ({ id: stage.id, code: stage.id, label: stage.name })) });
    }
    for (const field of this.customFields(workspaceId)) {
      const handler = fieldTypeRegistry.get(field.fieldType);
      out.push({
        key: `customFields.${field.code}`,
        label: field.label,
        dataType: handler.conditionDataType,
        source: 'custom',
        updatable: true,
        options: handler.usesOptions ? this.store.state.crmCustomFieldOptions.filter((option) => option.fieldId === field.id && option.isActive).sort((a, b) => a.sortOrder - b.sortOrder).map((option) => ({ id: option.id, code: option.code, label: option.label })) : undefined,
      });
    }
    return out;
  }

  load(workspaceId: string, id: string): TargetRecord | null {
    const adapter = this.registry.get(this.targetType);
    const record = adapter.findRecord(workspaceId, id) as Record<string, unknown> | undefined;
    if (!record || record.workspaceId !== workspaceId) return null;
    const system = adapter.systemValues(record);
    const conditionValues: Record<string, unknown[]> = {};
    const templateValues: Record<string, unknown> = { id: record.id, title: this.titleOf(record) };
    for (const [key, value] of Object.entries(system)) {
      conditionValues[key] = value === undefined || value === null ? [] : [value];
      templateValues[key] = value ?? null;
    }
    let stage: TargetRecord['stage'] = null;
    if (this.supportsStages) {
      stage = { pipelineId: (record.pipelineId as string) ?? null, stageId: (record.stageId as string) ?? null };
      conditionValues.pipelineId = stage.pipelineId ? [stage.pipelineId] : [];
      conditionValues.stageId = stage.stageId ? [stage.stageId] : [];
      templateValues.pipelineId = stage.pipelineId;
      templateValues.stageId = stage.stageId;
    }
    for (const field of this.customFields(workspaceId)) {
      if (field.activityTypeId && field.activityTypeId !== (record.customActivityTypeId ?? null)) continue;
      const items = this.fieldEngine.values.loadItems(workspaceId, this.targetType, id, field);
      const options = this.store.state.crmCustomFieldOptions.filter((option) => option.fieldId === field.id);
      const handler = fieldTypeRegistry.get(field.fieldType);
      conditionValues[`customFields.${field.code}`] = conditionValuesOf(field, items, options);
      templateValues[`customFields.${field.code}`] = field.isMultiple ? items.map((item) => handler.toApi(item)) : items.length > 0 ? handler.toApi(items[0]) : null;
    }
    return {
      id,
      title: this.titleOf(record),
      conditionValues,
      templateValues,
      isActionable: this.actionable(record),
      version: typeof record.version === 'number' ? record.version : null,
      responsibleUserId: (record.responsibleUserId as string | null | undefined) ?? null,
      stage,
    };
  }

  canAccess(actor: ActorContext, id: string, action: 'read' | 'update') {
    const adapter = this.registry.get(this.targetType);
    return action === 'read' ? adapter.canRead(actor, id) : adapter.canUpdate(actor, id);
  }

  timingFields(workspaceId: string) {
    const out: Array<{ ref: string; label: string }> = [];
    if (this.targetType === 'ACTIVITY') out.push({ ref: 'target.deadline', label: 'Deadline' }, { ref: 'target.startAt', label: 'Start' });
    for (const field of this.customFields(workspaceId)) if (field.fieldType === 'DATE' || field.fieldType === 'DATETIME') out.push({ ref: `target.customFields.${field.code}`, label: field.label });
    return out;
  }
}

export class TargetRegistry {
  private readonly targets = new Map<string, AutomationTargetDescriptor>();

  register(target: AutomationTargetDescriptor) {
    this.targets.set(target.targetType, target);
    return this;
  }

  has(targetType: string) {
    return this.targets.has(targetType);
  }

  get(targetType: string) {
    const target = this.targets.get(targetType);
    if (!target) throw new Error(`Unknown automation target ${targetType}`);
    return target;
  }

  find(targetType: string) {
    return this.targets.get(targetType);
  }

  list() {
    return [...this.targets.values()];
  }
}

// ---- Triggers ----------------------------------------------------------------------------------------------------------------

export type TriggerEnv = { workspaceId: string; store: InMemoryStore };

export type ConfigField = {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'user' | 'stage' | 'pipeline' | 'fields' | 'field-map' | 'activity-type' | 'url' | 'secret-ref' | 'json' | 'string-list';
  required?: boolean;
  help?: string;
  options?: Array<{ value: string; label: string }>;
};

export interface TriggerDescriptor {
  readonly code: string;
  readonly label: string;
  readonly category: string;
  readonly description: string;
  readonly targetTypes: string[];
  /** Outbox event types this trigger consumes. Empty for manual and externally invoked triggers. */
  readonly eventTypes: string[];
  readonly configFields: ConfigField[];
  readonly isExtension?: boolean;
  /** Typed payload schema of a custom trigger; its values become read-only context. */
  readonly payloadSchema?: SchemaNode | null;
  validateConfig(config: Record<string, unknown>, targetType: string, env: TriggerEnv): Problem[];
  /** Builds the pinned context for an event, or null when the event is not one this trigger reacts to. */
  buildContext(event: OutboxEvent, config: Record<string, unknown>, base: TriggerContext): TriggerContext | null;
  /** Reason a delayed job is stale for this trigger (e.g. the record left the stage), or null. */
  staleReason?(context: TriggerContext, config: Record<string, unknown>, target: TargetRecord): string | null;
}

const CRM_TARGETS = ['LEAD', 'DEAL', 'CONTACT', 'COMPANY'];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function changedOf(event: OutboxEvent) {
  const changed = event.payload.changed;
  return isRecord(changed) ? (changed as Record<string, { before: unknown; after: unknown }>) : undefined;
}

function crmEvent(code: string, label: string, suffix: string, description: string, targets = CRM_TARGETS): TriggerDescriptor {
  return {
    code,
    label,
    category: 'CRM',
    description,
    targetTypes: targets,
    eventTypes: targets.map((target) => `CRM.${target}.${suffix}`),
    configFields: [],
    validateConfig: (config) => Object.keys(config).map((key) => ({ path: `$.${key}`, code: 'AUTOMATION_TRIGGER_CONFIG_INVALID', message: `This trigger takes no "${key}" setting.` })),
    buildContext: (event, _config, base) => ({ ...base, changedFields: changedOf(event) }),
  };
}

const stageProblems = (config: Record<string, unknown>, targetType: string, env: TriggerEnv): Problem[] => {
  const problems: Problem[] = [];
  for (const key of Object.keys(config)) {
    if (!['pipelineId', 'stageId', 'requireStillInStage'].includes(key)) problems.push({ path: `$.${key}`, code: 'AUTOMATION_TRIGGER_CONFIG_INVALID', message: `Unsupported setting "${key}".` });
  }
  if (config.stageId !== undefined) {
    const stage = env.store.state.crmStages.find((item) => item.id === config.stageId && item.workspaceId === env.workspaceId);
    const pipeline = stage ? env.store.state.crmPipelines.find((item) => item.id === stage.pipelineId) : undefined;
    if (!stage || !pipeline || pipeline.entityType !== targetType) problems.push({ path: '$.stageId', code: 'AUTOMATION_STAGE_UNAVAILABLE', message: 'The selected stage does not exist for this target.' });
    else if (!stage.isActive) problems.push({ path: '$.stageId', code: 'AUTOMATION_STAGE_UNAVAILABLE', message: 'The selected stage is inactive.' });
  }
  if (config.pipelineId !== undefined && !env.store.state.crmPipelines.some((item) => item.id === config.pipelineId && item.workspaceId === env.workspaceId && item.entityType === targetType)) {
    problems.push({ path: '$.pipelineId', code: 'AUTOMATION_STAGE_UNAVAILABLE', message: 'The selected pipeline does not exist for this target.' });
  }
  if (config.requireStillInStage !== undefined && typeof config.requireStillInStage !== 'boolean') problems.push({ path: '$.requireStillInStage', code: 'AUTOMATION_TRIGGER_CONFIG_INVALID', message: 'requireStillInStage must be a boolean.' });
  return problems;
};

export const STAGE_CONFIG_FIELDS: ConfigField[] = [
  { key: 'pipelineId', label: 'Pipeline', type: 'pipeline', help: 'Leave empty for any pipeline.' },
  { key: 'stageId', label: 'Stage', type: 'stage', help: 'Leave empty for any stage.' },
  { key: 'requireStillInStage', label: 'Delayed runs require the record to still be in the stage', type: 'boolean' },
];

const stageEntered: TriggerDescriptor = {
  code: 'crm.stage.entered',
  label: 'Stage entered',
  category: 'Pipeline',
  description: 'A Lead or Deal enters a stage (optionally a specific pipeline/stage).',
  targetTypes: ['LEAD', 'DEAL'],
  eventTypes: ['CRM.LEAD.STAGE_CHANGED', 'CRM.DEAL.STAGE_CHANGED'],
  configFields: STAGE_CONFIG_FIELDS,
  validateConfig: stageProblems,
  buildContext(event, config, base) {
    const toStageId = (event.payload.toStageId as string) ?? null;
    const toPipelineId = (event.payload.toPipelineId as string) ?? null;
    if (config.stageId && config.stageId !== toStageId) return null;
    if (config.pipelineId && config.pipelineId !== toPipelineId) return null;
    return { ...base, stage: { pipelineId: toPipelineId, stageId: toStageId, fromPipelineId: (event.payload.fromPipelineId as string) ?? null, fromStageId: (event.payload.fromStageId as string) ?? null } };
  },
  // "Create a task if the Deal is still in the same stage": a delayed run is stale once the record moved on.
  staleReason(context, config, target) {
    if (config.requireStillInStage === false) return null;
    return target.stage && context.stage && target.stage.stageId !== context.stage.stageId ? 'STAGE_CHANGED' : null;
  },
};

const stageExited: TriggerDescriptor = {
  code: 'crm.stage.exited',
  label: 'Stage exited',
  category: 'Pipeline',
  description: 'A Lead or Deal leaves a stage (optionally a specific pipeline/stage).',
  targetTypes: ['LEAD', 'DEAL'],
  eventTypes: ['CRM.LEAD.STAGE_CHANGED', 'CRM.DEAL.STAGE_CHANGED'],
  configFields: STAGE_CONFIG_FIELDS.slice(0, 2),
  validateConfig: (config, targetType, env) => stageProblems(config, targetType, env).filter((problem) => problem.path !== '$.requireStillInStage'),
  buildContext(event, config, base) {
    const fromStageId = (event.payload.fromStageId as string) ?? null;
    const fromPipelineId = (event.payload.fromPipelineId as string) ?? null;
    if (config.stageId && config.stageId !== fromStageId) return null;
    if (config.pipelineId && config.pipelineId !== fromPipelineId) return null;
    return { ...base, stage: { pipelineId: (event.payload.toPipelineId as string) ?? null, stageId: (event.payload.toStageId as string) ?? null, fromPipelineId, fromStageId } };
  },
};

const fieldChanged: TriggerDescriptor = {
  code: 'crm.field.changed',
  label: 'Field changed',
  category: 'CRM',
  description: 'One of the selected fields changed on a CRM record.',
  targetTypes: CRM_TARGETS,
  eventTypes: CRM_TARGETS.map((target) => `CRM.${target}.UPDATED`),
  configFields: [{ key: 'fields', label: 'Fields', type: 'fields', required: true, help: 'The Rule fires when any selected field changes.' }],
  validateConfig(config) {
    const problems: Problem[] = [];
    for (const key of Object.keys(config)) if (key !== 'fields') problems.push({ path: `$.${key}`, code: 'AUTOMATION_TRIGGER_CONFIG_INVALID', message: `Unsupported setting "${key}".` });
    if (!Array.isArray(config.fields) || config.fields.length === 0 || config.fields.length > 20 || config.fields.some((field) => typeof field !== 'string')) {
      problems.push({ path: '$.fields', code: 'AUTOMATION_TRIGGER_CONFIG_INVALID', message: 'Select 1-20 fields.' });
    }
    return problems;
  },
  buildContext(event, config, base) {
    const wanted = (config.fields as string[]) ?? [];
    const changedNames = Array.isArray(event.payload.changedFields) ? (event.payload.changedFields as string[]) : [];
    if (!wanted.some((field) => changedNames.includes(field))) return null;
    return { ...base, changedFields: changedOf(event) };
  },
};

const activityEvent = (code: string, label: string, eventType: string, description: string): TriggerDescriptor => ({
  code,
  label,
  category: 'Activities',
  description,
  targetTypes: ['ACTIVITY'],
  eventTypes: [eventType],
  configFields: [{ key: 'typeCode', label: 'Activity type', type: 'activity-type', help: 'Leave empty for any type.' }],
  validateConfig(config) {
    const problems: Problem[] = [];
    for (const key of Object.keys(config)) if (key !== 'typeCode') problems.push({ path: `$.${key}`, code: 'AUTOMATION_TRIGGER_CONFIG_INVALID', message: `Unsupported setting "${key}".` });
    if (config.typeCode !== undefined && (typeof config.typeCode !== 'string' || !/^[A-Z][A-Z0-9_]{1,49}$/.test(config.typeCode))) problems.push({ path: '$.typeCode', code: 'AUTOMATION_TRIGGER_CONFIG_INVALID', message: 'typeCode must be an Activity type code.' });
    return problems;
  },
  buildContext(event, config, base) {
    if (config.typeCode && event.payload.typeCode !== config.typeCode) return null;
    return { ...base };
  },
});

export const MANUAL_TRIGGER: TriggerDescriptor = {
  code: 'manual.execute',
  label: 'Manual run only',
  category: 'Manual',
  description: 'The Rule runs only when an authorized user starts it against a record.',
  targetTypes: [...CRM_TARGETS, 'ACTIVITY'],
  eventTypes: [],
  configFields: [],
  validateConfig: (config) => Object.keys(config).map((key) => ({ path: `$.${key}`, code: 'AUTOMATION_TRIGGER_CONFIG_INVALID', message: `This trigger takes no "${key}" setting.` })),
  buildContext: () => null,
};

export const BUILT_IN_TRIGGERS: TriggerDescriptor[] = [
  crmEvent('crm.entity.created', 'Record created', 'CREATED', 'A CRM record is created.'),
  crmEvent('crm.entity.updated', 'Record updated', 'UPDATED', 'A CRM record is updated.'),
  fieldChanged,
  crmEvent('crm.entity.assigned', 'Responsible user changed', 'ASSIGNED', 'A CRM record is assigned to another user.'),
  stageEntered,
  stageExited,
  crmEvent('crm.lead.converted', 'Lead converted', 'CONVERTED', 'A Lead is converted.', ['LEAD']),
  activityEvent('activity.created', 'Activity created', 'ACTIVITY_CREATED', 'An Activity is created.'),
  activityEvent('activity.completed', 'Activity completed', 'ACTIVITY_COMPLETED', 'An Activity is completed.'),
  activityEvent('activity.overdue', 'Activity overdue', 'ACTIVITY_OVERDUE', 'An open Activity passes its deadline.'),
  MANUAL_TRIGGER,
];

/** Trigger backed by a registered custom Trigger extension. It is only ever fed by the authenticated invocation endpoint. */
export function extensionTrigger(extension: AutomationExtension): TriggerDescriptor {
  return {
    code: `ext.${extension.code}`,
    label: extension.name,
    category: 'Integrations',
    description: extension.description ?? '',
    targetTypes: extension.targetTypes,
    eventTypes: [],
    configFields: [],
    isExtension: true,
    payloadSchema: extension.payloadSchema,
    validateConfig: (config) => Object.keys(config).map((key) => ({ path: `$.${key}`, code: 'AUTOMATION_TRIGGER_CONFIG_INVALID', message: `This trigger takes no "${key}" setting.` })),
    buildContext: () => null,
  };
}

// ---- Registry container ----------------------------------------------------------------------------------------------------------

export class AutomationRegistry {
  readonly targets = new TargetRegistry();
  private readonly triggers = new Map<string, TriggerDescriptor>(BUILT_IN_TRIGGERS.map((trigger) => [trigger.code, trigger]));
  private readonly actions = new Map<string, ActionDescriptor>();
  private readonly byEvent = new Map<string, TriggerDescriptor[]>();

  constructor(private readonly store: InMemoryStore) {
    for (const trigger of BUILT_IN_TRIGGERS) for (const eventType of trigger.eventTypes) this.byEvent.set(eventType, [...(this.byEvent.get(eventType) ?? []), trigger]);
  }

  registerAction(action: ActionDescriptor) {
    this.actions.set(action.code, action);
    return this;
  }

  builtInActions() {
    return [...this.actions.values()];
  }

  triggersForEvent(eventType: string) {
    return this.byEvent.get(eventType) ?? [];
  }

  extensionsOf(workspaceId: string, kind: 'TRIGGER' | 'ACTION') {
    return this.store.state.automationExtensions.filter((extension) => extension.workspaceId === workspaceId && extension.kind === kind);
  }

  /** All trigger types usable in a workspace (built-in + enabled custom). `includeDisabled` keeps history resolvable. */
  triggerFor(workspaceId: string, code: string, includeDisabled = false): TriggerDescriptor | undefined {
    const builtIn = this.triggers.get(code);
    if (builtIn) return builtIn;
    if (!code.startsWith('ext.')) return undefined;
    const extension = this.extensionsOf(workspaceId, 'TRIGGER').find((item) => `ext.${item.code}` === code && (includeDisabled || item.enabled));
    return extension ? extensionTrigger(extension) : undefined;
  }

  triggersFor(workspaceId: string): TriggerDescriptor[] {
    return [...this.triggers.values(), ...this.extensionsOf(workspaceId, 'TRIGGER').filter((item) => item.enabled).map(extensionTrigger)];
  }

  /** Set by the extension service: resolves/lists custom Action descriptors for a workspace. */
  extensionActionResolver: ((workspaceId: string, code: string, includeDisabled: boolean) => ActionDescriptor | undefined) | null = null;
  extensionActionList: ((workspaceId: string) => ActionDescriptor[]) | null = null;

  resolveAction(workspaceId: string, code: string, includeDisabled = false): ActionDescriptor | undefined {
    const builtIn = this.actions.get(code);
    if (builtIn) return builtIn;
    return this.extensionActionResolver?.(workspaceId, code, includeDisabled);
  }

  actionsFor(workspaceId: string): ActionDescriptor[] {
    return [...this.actions.values(), ...(this.extensionActionList?.(workspaceId) ?? [])];
  }

  /** Operand catalogue for the condition engine and the designer, derived from the target and the trigger. */
  operandsFor(workspaceId: string, targetType: string, trigger: TriggerDescriptor | undefined): Map<string, OperandDescriptor> {
    const operands = new Map<string, OperandDescriptor>();
    const target = this.targets.find(targetType);
    if (target) {
      for (const field of target.fields(workspaceId)) {
        operands.set(`target.${field.key}`, { ref: `target.${field.key}`, label: field.label, dataType: field.dataType, scope: 'CURRENT', supportsChange: field.source !== 'derived' || field.key === 'stageId', options: field.options });
      }
    }
    if (trigger?.payloadSchema?.properties) {
      for (const [key, schema] of Object.entries(trigger.payloadSchema.properties)) {
        const dataType: ConditionDataType = schema.type === 'number' || schema.type === 'integer' ? 'NUMBER' : schema.type === 'boolean' ? 'BOOLEAN' : schema.format === 'date-time' ? 'DATETIME' : schema.enum ? 'ENUM' : 'TEXT';
        if (schema.type === 'object' || schema.type === 'array') continue;
        operands.set(`trigger.payload.${key}`, { ref: `trigger.payload.${key}`, label: `Payload: ${key}`, dataType, scope: 'EVENT', supportsChange: false });
      }
    }
    operands.set('actor.id', { ref: 'actor.id', label: 'Initiating user', dataType: 'ENUM', scope: 'EVENT', supportsChange: false });
    operands.set('now', { ref: 'now', label: 'Current time', dataType: 'DATETIME', scope: 'CURRENT', supportsChange: false });
    return operands;
  }
}
