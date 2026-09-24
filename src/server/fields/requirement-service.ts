import type { ActorContext } from '../access-service';
import type { User } from '../domain';
import { AppError, badRequest, conflict, fieldValidationFailed } from '../errors';
import { applyQuery } from '../query';
import { canonicalDecimal, decimalToScaled } from './decimal';
import type { ConditionDataType } from './field-types';
import { fieldTypeRegistry } from './field-types';
import type { CustomValueService, PreparedCustomValues } from './custom-value-service';
import { isEmptyFieldValue } from './custom-value-service';
import type { SystemFieldDescriptor } from './entity-registry';
import type { FieldSupport } from './support';
import type { ConditionNode, ConditionOperand, ConditionOperator, CustomField, FieldRequirement, FieldViolations } from './types';
import { CONDITION_OPERATORS, FIELD_PERMISSIONS } from './types';

const MAX_DEPTH = 5;
const MAX_NODES = 50;
const MAX_IN_LIST = 100;

type EvalContext = {
  systemValues: Record<string, unknown>;
  customItems: Map<string, unknown[]>;
  fields: Map<string, CustomField>;
};

type Comparable = string | number | bigint | boolean;

function isBlank(value: unknown) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function toComparable(dataType: ConditionDataType, raw: unknown): Comparable | null {
  if (isBlank(raw)) return null;
  switch (dataType) {
    case 'NUMBER':
      return decimalToScaled(raw);
    case 'BOOLEAN':
      return typeof raw === 'boolean' ? raw : null;
    case 'DATE':
    case 'DATETIME': {
      const ms = raw instanceof Date ? raw.getTime() : typeof raw === 'string' ? Date.parse(raw.length === 10 ? `${raw}T00:00:00.000Z` : raw) : NaN;
      return Number.isNaN(ms) ? null : ms;
    }
    case 'TEXT':
      return String(raw).trim().toLowerCase();
    case 'ENUM':
    default:
      return String(raw).trim().toLowerCase();
  }
}

function compare(a: Comparable, b: Comparable): number {
  if (typeof a === 'bigint' && typeof b === 'bigint') return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
  const left = String(a);
  const right = String(b);
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * Safe declarative evaluator. There is no expression language, no eval and no user code: a condition is a bounded tree
 * of ALL/ANY groups over allow-listed operators, evaluated against a plain value snapshot.
 */
export function evaluateCondition(node: ConditionNode | null | undefined, resolve: (operand: ConditionOperand) => { dataType: ConditionDataType; values: unknown[]; empty: boolean }): boolean {
  if (!node) return true;
  if (node.type === 'GROUP') {
    if (node.children.length === 0) return true;
    return node.operator === 'ALL' ? node.children.every((child) => evaluateCondition(child, resolve)) : node.children.some((child) => evaluateCondition(child, resolve));
  }
  const operand = resolve(node.field);
  const { dataType, values, empty } = operand;
  if (node.operator === 'IS_EMPTY') return empty;
  if (node.operator === 'IS_NOT_EMPTY') return !empty;
  const comparables = values.map((value) => toComparable(dataType, value)).filter((value): value is Comparable => value !== null);
  const constants = (Array.isArray(node.value) ? node.value : [node.value]).map((value) => toComparable(dataType, value)).filter((value): value is Comparable => value !== null);
  const first = constants[0];
  switch (node.operator) {
    case 'EQ':
      return first !== undefined && comparables.some((value) => compare(value, first) === 0);
    case 'NEQ':
      return first !== undefined && !comparables.some((value) => compare(value, first) === 0);
    case 'IN':
      return comparables.some((value) => constants.some((constant) => compare(value, constant) === 0));
    case 'NOT_IN':
      return !comparables.some((value) => constants.some((constant) => compare(value, constant) === 0));
    case 'GT':
      return first !== undefined && comparables.some((value) => compare(value, first) > 0);
    case 'GTE':
      return first !== undefined && comparables.some((value) => compare(value, first) >= 0);
    case 'LT':
      return first !== undefined && comparables.some((value) => compare(value, first) < 0);
    case 'LTE':
      return first !== undefined && comparables.some((value) => compare(value, first) <= 0);
    case 'CONTAINS':
      return first !== undefined && comparables.some((value) => String(value).includes(String(first)));
    default:
      return false;
  }
}

export type RequirementCheckArgs = {
  actor: ActorContext;
  prepared: PreparedCustomValues;
  /** Post-write system values of the owning record. */
  systemState: Record<string, unknown>;
  pipelineId?: string | null;
  stageId?: string | null;
};

export class FieldRequirementService {
  constructor(
    private readonly support: FieldSupport,
    private readonly values: CustomValueService,
  ) {}

  private get store() {
    return this.support.store;
  }

  private manageActor(user: User, workspaceId: string) {
    const actor = this.support.deps.access.actor(user, workspaceId);
    this.support.deps.access.requireWorkspaceScope(actor, FIELD_PERMISSIONS.manageRequirements);
    return actor;
  }

  // ---- administration -------------------------------------------------------------------------------------------

  create(user: User, workspaceId: string, input: Record<string, unknown>) {
    const actor = this.manageActor(user, workspaceId);
    return this.store.atomicSync(() => {
      const rule = this.buildRule(actor, input, null);
      this.store.state.crmFieldRequirements.push(rule);
      const schemaVersion = this.support.bumpSchema(workspaceId, rule.entityType, actor.user.id, 'REQUIREMENT_CREATED', { ruleId: rule.id });
      this.support.audit(workspaceId, actor.user.id, 'FIELD_REQUIREMENT.CREATED', 'CrmFieldRequirement', rule.id, null, this.auditShape(rule), { schemaVersion });
      return this.toDto(rule);
    });
  }

  list(user: User, workspaceId: string, searchParams: URLSearchParams) {
    const actor = this.manageActor(user, workspaceId);
    const entityType = searchParams.get('entityType');
    const targetFieldId = searchParams.get('targetFieldId');
    const pipelineId = searchParams.get('pipelineId');
    const stageId = searchParams.get('stageId');
    const isActive = searchParams.get('isActive');
    const rows = this.store.state.crmFieldRequirements.filter(
      (rule) =>
        rule.workspaceId === actor.workspaceId &&
        (!entityType || rule.entityType === entityType) &&
        (!targetFieldId || rule.targetCustomFieldId === targetFieldId) &&
        (!pipelineId || rule.pipelineId === pipelineId) &&
        (!stageId || rule.stageId === stageId) &&
        (isActive === null || rule.isActive === (isActive === 'true')),
    );
    const page = Math.max(Number(searchParams.get('page') ?? '1') || 1, 1);
    const limit = Math.min(Math.max(Number(searchParams.get('limit') ?? '20') || 20, 1), 100);
    const result = applyQuery(rows as unknown as Array<FieldRequirement & Record<string, unknown>>, {
      page,
      limit,
      sortBy: (searchParams.get('sortBy') ?? undefined) as never,
      sortOrder: searchParams.get('sortOrder') === 'desc' ? 'desc' : 'asc',
    }, { searchable: [], filterable: [], sortable: ['createdAt', 'updatedAt', 'entityType'], defaultSortBy: 'createdAt' });
    return { data: (result.data as FieldRequirement[]).map((rule) => this.toDto(rule)), meta: result.meta };
  }

  get(user: User, workspaceId: string, ruleId: string) {
    const actor = this.manageActor(user, workspaceId);
    return this.toDto(this.rule(actor.workspaceId, ruleId));
  }

  update(user: User, workspaceId: string, ruleId: string, input: Record<string, unknown>) {
    const actor = this.manageActor(user, workspaceId);
    return this.store.atomicSync(() => {
      const existing = this.rule(workspaceId, ruleId);
      this.support.assertVersion(existing.version, input.version);
      const before = this.auditShape(existing);
      const merged: Record<string, unknown> = {
        entityType: existing.entityType,
        target: existing.targetKind === 'SYSTEM' ? { kind: 'SYSTEM', key: existing.targetSystemFieldKey } : { kind: 'CUSTOM', fieldId: existing.targetCustomFieldId },
        pipelineId: existing.pipelineId ?? null,
        stageId: existing.stageId ?? null,
        conditions: existing.conditions ?? null,
        ...input,
      };
      if (input.entityType !== undefined && input.entityType !== existing.entityType) {
        throw badRequest('FIELD_REQUIREMENT_INVALID', 'entityType cannot be changed.');
      }
      const next = this.buildRule(actor, merged, existing);
      Object.assign(existing, {
        targetKind: next.targetKind,
        targetSystemFieldKey: next.targetSystemFieldKey,
        targetCustomFieldId: next.targetCustomFieldId,
        pipelineId: next.pipelineId,
        stageId: next.stageId,
        conditions: next.conditions,
        updatedByUserId: actor.user.id,
        updatedAt: new Date(),
        version: existing.version + 1,
      });
      const schemaVersion = this.support.bumpSchema(workspaceId, existing.entityType, actor.user.id, 'REQUIREMENT_UPDATED', { ruleId });
      this.support.audit(workspaceId, actor.user.id, 'FIELD_REQUIREMENT.UPDATED', 'CrmFieldRequirement', existing.id, before, this.auditShape(existing), { schemaVersion });
      return this.toDto(existing);
    });
  }

  setActive(user: User, workspaceId: string, ruleId: string, active: boolean, input: { version?: number } = {}) {
    const actor = this.manageActor(user, workspaceId);
    return this.store.atomicSync(() => {
      const rule = this.rule(workspaceId, ruleId);
      if (input.version !== undefined) this.support.assertVersion(rule.version, input.version);
      if (rule.isActive !== active) {
        if (active) this.assertRuleStillValid(actor, rule);
        rule.isActive = active;
        rule.version += 1;
        rule.updatedAt = new Date();
        rule.updatedByUserId = actor.user.id;
        this.support.bumpSchema(workspaceId, rule.entityType, actor.user.id, active ? 'REQUIREMENT_ACTIVATED' : 'REQUIREMENT_DEACTIVATED', { ruleId });
        this.support.audit(workspaceId, actor.user.id, active ? 'FIELD_REQUIREMENT.ACTIVATED' : 'FIELD_REQUIREMENT.DEACTIVATED', 'CrmFieldRequirement', rule.id, { isActive: !active }, { isActive: active });
      }
      return this.toDto(rule);
    });
  }

  /** Configuration removal. Audit history is retained; existing records are never touched. */
  delete(user: User, workspaceId: string, ruleId: string) {
    const actor = this.manageActor(user, workspaceId);
    return this.store.atomicSync(() => {
      const rule = this.rule(workspaceId, ruleId);
      const before = this.auditShape(rule);
      this.store.state.crmFieldRequirements = this.store.state.crmFieldRequirements.filter((item) => item.id !== rule.id);
      this.support.bumpSchema(workspaceId, rule.entityType, actor.user.id, 'REQUIREMENT_DELETED', { ruleId });
      this.support.audit(workspaceId, actor.user.id, 'FIELD_REQUIREMENT.DELETED_IF_SAFE', 'CrmFieldRequirement', rule.id, before, null);
      return { id: rule.id, deleted: true };
    });
  }

  /** Requirement-capable system field descriptors for the rule editor. */
  systemFields(user: User, workspaceId: string, entityType: string) {
    const actor = this.manageActor(user, workspaceId);
    return this.support.deps.registry.get(entityType).systemFields().filter((descriptor) => descriptor.requirementCapable || descriptor.conditionCapable)
      .map((descriptor) => ({
        key: descriptor.key,
        label: descriptor.label,
        dataType: descriptor.dataType,
        requirementCapable: descriptor.requirementCapable,
        conditionCapable: descriptor.conditionCapable,
        operators: fieldTypeRegistry.operatorsFor(descriptor.dataType),
        workspaceId: actor.workspaceId,
      }));
  }

  // ---- rule construction / validation ----------------------------------------------------------------------------

  private rule(workspaceId: string, ruleId: string): FieldRequirement {
    const rule = this.store.state.crmFieldRequirements.find((item) => item.id === ruleId && item.workspaceId === workspaceId);
    if (!rule) throw new AppError('FIELD_REQUIREMENT_NOT_FOUND', 'Requirement rule was not found.', 404);
    return rule;
  }

  private invalid(message: string, details?: unknown): never {
    throw new AppError('FIELD_REQUIREMENT_INVALID', message, 400, details ?? null);
  }

  private buildRule(actor: ActorContext, input: Record<string, unknown>, existing: FieldRequirement | null): FieldRequirement {
    const workspaceId = actor.workspaceId;
    const entityType = typeof input.entityType === 'string' ? input.entityType : '';
    const adapter = this.support.deps.registry.get(entityType); // throws ENTITY_TYPE_NOT_FIELD_CAPABLE
    const target = input.target as { kind?: string; key?: string; fieldId?: string } | undefined;
    if (!target || (target.kind !== 'SYSTEM' && target.kind !== 'CUSTOM')) this.invalid('target.kind must be SYSTEM or CUSTOM.');

    let targetSystemFieldKey: string | null = null;
    let targetCustomFieldId: string | null = null;
    if (target.kind === 'SYSTEM') {
      const descriptor = adapter.systemFields().find((item) => item.key === target.key);
      if (!descriptor || !descriptor.requirementCapable) this.invalid('The system field cannot be made required.');
      targetSystemFieldKey = descriptor.key;
    } else {
      const field = this.store.state.crmCustomFields.find((item) => item.id === target.fieldId && item.workspaceId === workspaceId && item.entityType === entityType);
      if (!field) throw new AppError('CUSTOM_FIELD_NOT_FOUND', 'Custom field was not found.', 404);
      if (!field.isActive) throw new AppError('CUSTOM_FIELD_INACTIVE', 'The target custom field is inactive.', 409);
      // A requirement must never be unsatisfiable for someone who cannot see or edit the field.
      if (this.store.state.crmFieldVisibilityRules.some((rule) => rule.fieldId === field.id)) {
        throw conflict('FIELD_REQUIREMENT_CONFIGURATION_CONFLICT', 'The target field is hidden or read-only for some users, so it cannot be required.');
      }
      targetCustomFieldId = field.id;
    }

    let pipelineId: string | null = null;
    let stageId: string | null = null;
    if (input.pipelineId !== undefined && input.pipelineId !== null) {
      if (!adapter.supportsPipeline) this.invalid(`${entityType} records have no pipelines.`);
      const pipeline = this.store.state.crmPipelines.find((item) => item.id === input.pipelineId && item.workspaceId === workspaceId);
      if (!pipeline || pipeline.entityType !== entityType) throw new AppError('NOT_FOUND', 'CRM_PIPELINE was not found.', 404);
      pipelineId = pipeline.id;
    }
    if (input.stageId !== undefined && input.stageId !== null) {
      if (!pipelineId) this.invalid('stageId requires pipelineId.');
      const stage = this.store.state.crmStages.find((item) => item.id === input.stageId && item.workspaceId === workspaceId);
      if (!stage || stage.pipelineId !== pipelineId) throw new AppError('NOT_FOUND', 'CRM_STAGE was not found.', 404);
      stageId = stage.id;
    }

    const conditions = this.normalizeConditions(workspaceId, entityType, adapter.systemFields(), input.conditions);
    const now = new Date();
    return {
      id: existing?.id ?? this.store.id(),
      workspaceId,
      entityType,
      targetKind: target.kind,
      targetSystemFieldKey,
      targetCustomFieldId,
      pipelineId,
      stageId,
      isActive: existing?.isActive ?? true,
      conditions,
      conditionsVersion: 1,
      version: existing?.version ?? 1,
      createdByUserId: existing?.createdByUserId ?? actor.user.id,
      updatedByUserId: actor.user.id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  private assertRuleStillValid(actor: ActorContext, rule: FieldRequirement) {
    this.buildRule(actor, {
      entityType: rule.entityType,
      target: rule.targetKind === 'SYSTEM' ? { kind: 'SYSTEM', key: rule.targetSystemFieldKey } : { kind: 'CUSTOM', fieldId: rule.targetCustomFieldId },
      pipelineId: rule.pipelineId,
      stageId: rule.stageId,
      conditions: rule.conditions ?? null,
    }, rule);
  }

  private normalizeConditions(workspaceId: string, entityType: string, systemFields: SystemFieldDescriptor[], raw: unknown): ConditionNode | null {
    if (raw === undefined || raw === null) return null;
    let nodes = 0;
    const violations: FieldViolations = {};
    const add = (path: string, message: string) => (violations[path] ??= []).push({ code: 'INVALID_CONDITION', message });

    const walk = (value: unknown, depth: number, path: string): ConditionNode | null => {
      nodes += 1;
      if (nodes > MAX_NODES) {
        add(path, `Conditions may contain at most ${MAX_NODES} nodes.`);
        return null;
      }
      if (depth > MAX_DEPTH) {
        add(path, `Conditions may be nested at most ${MAX_DEPTH} levels.`);
        return null;
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        add(path, 'A condition must be an object.');
        return null;
      }
      const node = value as Record<string, unknown>;
      const isGroup = node.type === 'GROUP' || (node.type === undefined && Array.isArray(node.children));
      if (isGroup) {
        const operator = node.operator === 'ANY' || node.operator === 'OR' ? 'ANY' : node.operator === 'ALL' || node.operator === 'AND' ? 'ALL' : null;
        if (!operator) {
          add(path, 'A group operator must be ALL or ANY.');
          return null;
        }
        if (!Array.isArray(node.children) || node.children.length === 0) {
          add(path, 'A group needs at least one child.');
          return null;
        }
        const children = node.children.map((child, index) => walk(child, depth + 1, `${path}.children[${index}]`));
        if (children.some((child) => child === null)) return null;
        return { type: 'GROUP', operator, children: children as ConditionNode[] };
      }
      if (node.type !== 'PREDICATE') {
        add(path, 'Unknown condition type.');
        return null;
      }
      const operator = node.operator as ConditionOperator;
      if (!CONDITION_OPERATORS.includes(operator)) {
        add(`${path}.operator`, 'Unsupported operator.');
        return null;
      }
      const operandRaw = node.field as { kind?: string; key?: string; fieldId?: string } | undefined;
      let operand: ConditionOperand;
      let dataType: ConditionDataType;
      let optionField: CustomField | null = null;
      if (operandRaw?.kind === 'SYSTEM') {
        const descriptor = systemFields.find((item) => item.key === operandRaw.key);
        if (!descriptor || !descriptor.conditionCapable) {
          add(`${path}.field`, 'The system field cannot be used in conditions.');
          return null;
        }
        operand = { kind: 'SYSTEM', key: descriptor.key };
        dataType = descriptor.dataType;
      } else if (operandRaw?.kind === 'CUSTOM') {
        const field = this.store.state.crmCustomFields.find((item) => item.id === operandRaw.fieldId && item.workspaceId === workspaceId && item.entityType === entityType);
        if (!field || !field.isActive) {
          add(`${path}.field`, 'The custom field does not exist for this entity.');
          return null;
        }
        operand = { kind: 'CUSTOM', fieldId: field.id };
        dataType = fieldTypeRegistry.get(field.fieldType).conditionDataType;
        optionField = field;
      } else {
        add(`${path}.field`, 'field.kind must be SYSTEM or CUSTOM.');
        return null;
      }
      if (!fieldTypeRegistry.operatorsFor(dataType).includes(operator)) {
        add(`${path}.operator`, `Operator ${operator} is not supported for ${dataType} fields.`);
        return null;
      }
      if (operator === 'IS_EMPTY' || operator === 'IS_NOT_EMPTY') return { type: 'PREDICATE', field: operand, operator };
      const list = operator === 'IN' || operator === 'NOT_IN';
      const constants = list ? node.value : [node.value];
      if (list && (!Array.isArray(constants) || constants.length === 0 || constants.length > MAX_IN_LIST)) {
        add(`${path}.value`, `${operator} requires a non-empty array (max ${MAX_IN_LIST}).`);
        return null;
      }
      const normalized: unknown[] = [];
      for (const constant of constants as unknown[]) {
        const parsed = this.parseConstant(dataType, constant, optionField);
        if (parsed === undefined) {
          add(`${path}.value`, `The value is not a valid ${dataType} constant.`);
          return null;
        }
        normalized.push(parsed);
      }
      return { type: 'PREDICATE', field: operand, operator, value: list ? normalized : normalized[0] };
    };

    const result = walk(raw, 1, 'conditions');
    if (Object.keys(violations).length > 0 || result === null) {
      throw new AppError('FIELD_REQUIREMENT_INVALID', 'The condition tree is invalid.', 400, { fields: violations });
    }
    return result;
  }

  private parseConstant(dataType: ConditionDataType, value: unknown, field: CustomField | null): unknown {
    switch (dataType) {
      case 'NUMBER':
        return canonicalDecimal(value) ?? undefined;
      case 'BOOLEAN':
        return typeof value === 'boolean' ? value : undefined;
      case 'DATE':
        return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined;
      case 'DATETIME':
        return typeof value === 'string' && /(Z|[+-]\d{2}:?\d{2})$/i.test(value) && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;
      case 'TEXT':
        return typeof value === 'string' && value.length <= 500 ? value : undefined;
      case 'ENUM': {
        if (typeof value !== 'string' || value.length === 0 || value.length > 200) return undefined;
        if (field && fieldTypeRegistry.get(field.fieldType).usesOptions) {
          const option = this.support.optionsOf(field.id).find((item) => item.id === value || item.code.toLowerCase() === value.toLowerCase());
          return option?.id;
        }
        return value;
      }
    }
  }

  // ---- evaluation -----------------------------------------------------------------------------------------------------

  applicableRules(workspaceId: string, entityType: string, pipelineId?: string | null, stageId?: string | null) {
    return this.store.state.crmFieldRequirements.filter((rule) => {
      if (rule.workspaceId !== workspaceId || rule.entityType !== entityType || !rule.isActive) return false;
      if (!rule.pipelineId) return true;
      if (rule.pipelineId !== (pipelineId ?? null)) return false;
      return !rule.stageId || rule.stageId === (stageId ?? null);
    });
  }

  /** Every target required in the given logical state. Any matching rule makes a field required (union semantics). */
  requiredTargets(args: { workspaceId: string; entityType: string; systemState: Record<string, unknown>; prepared: PreparedCustomValues; pipelineId?: string | null; stageId?: string | null }) {
    const adapter = this.support.deps.registry.get(args.entityType);
    const systemDescriptors = new Map(adapter.systemFields().map((descriptor) => [descriptor.key, descriptor]));
    const fields = new Map(args.prepared.activeFields.map((field) => [field.id, field]));
    const context: EvalContext = { systemValues: args.systemState, customItems: args.prepared.effective, fields };
    const required = new Map<string, string[]>();
    for (const rule of this.applicableRules(args.workspaceId, args.entityType, args.pipelineId, args.stageId)) {
      const matches = evaluateCondition(rule.conditions ?? null, (operand) => this.resolveOperand(operand, context, systemDescriptors));
      if (!matches) continue;
      const key = rule.targetKind === 'SYSTEM' ? `system:${rule.targetSystemFieldKey}` : `custom:${rule.targetCustomFieldId}`;
      required.set(key, [...(required.get(key) ?? []), rule.id]);
    }
    return required;
  }

  private resolveOperand(operand: ConditionOperand, context: EvalContext, systemDescriptors: Map<string, SystemFieldDescriptor>) {
    if (operand.kind === 'SYSTEM') {
      const raw = context.systemValues[operand.key];
      const dataType = systemDescriptors.get(operand.key)?.dataType ?? 'TEXT';
      return { dataType, values: isBlank(raw) ? [] : [raw], empty: isBlank(raw) };
    }
    const field = context.fields.get(operand.fieldId);
    if (!field) return { dataType: 'TEXT' as ConditionDataType, values: [], empty: true };
    const handler = fieldTypeRegistry.get(field.fieldType);
    const items = context.customItems.get(field.id) ?? [];
    return {
      dataType: handler.conditionDataType,
      values: items.map((item) => this.conditionValue(field, item)),
      empty: isEmptyFieldValue(field, items),
    };
  }

  private conditionValue(field: CustomField, item: unknown) {
    const handler = fieldTypeRegistry.get(field.fieldType);
    // ENUM-like values compare by their stable identity; everything else by its comparable form.
    if (field.fieldType === 'MONEY') return (item as { amount: string }).amount;
    if (field.fieldType === 'CRM_REFERENCE') return (item as { entityId: string }).entityId;
    if (field.fieldType === 'ADDRESS') return handler.comparable(item);
    return item;
  }

  /**
   * Evaluates requirements against the post-write state. Returns field violations keyed by public field name.
   * Throws a configuration error (without naming the field) when the requirement cannot be satisfied by this actor.
   */
  check(args: RequirementCheckArgs): FieldViolations {
    const { actor, prepared } = args;
    const violations: FieldViolations = {};
    const required = this.requiredTargets({
      workspaceId: actor.workspaceId,
      entityType: prepared.entityType,
      systemState: args.systemState,
      prepared,
      pipelineId: args.pipelineId,
      stageId: args.stageId,
    });
    if (required.size === 0) return violations;
    const adapter = this.support.deps.registry.get(prepared.entityType);
    const systemDescriptors = new Map(adapter.systemFields().map((descriptor) => [descriptor.key, descriptor]));
    const canSeeRules = this.support.deps.access.scopeFor(actor, FIELD_PERMISSIONS.manageRequirements) === 'WORKSPACE';

    for (const [target, ruleIds] of required) {
      const [kind, id] = [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)];
      if (kind === 'system') {
        const descriptor = systemDescriptors.get(id);
        if (!descriptor || !isBlank(args.systemState[id])) continue;
        (violations[id] ??= []).push({ code: 'REQUIRED', message: `${descriptor.label} is required.`, ...(canSeeRules ? { requirementRuleIds: ruleIds } : {}) });
        continue;
      }
      const field = prepared.activeFields.find((item) => item.id === id);
      if (!field) continue; // stale rule pointing at a deactivated field never blocks writes
      if (!isEmptyFieldValue(field, prepared.effective.get(field.id))) continue;
      const entry = prepared.fields.find((item) => item.field.id === field.id);
      if (!entry || entry.access !== 'EDIT') {
        // Do not name a field the actor cannot see or edit; this is an administrator problem, not the user's.
        throw new AppError(
          'FIELD_REQUIREMENT_CONFIGURATION_CONFLICT',
          'A required field cannot be completed with your current access. Please contact an administrator.',
          409,
        );
      }
      (violations[field.code] ??= []).push({ code: 'REQUIRED', message: `${field.label} is required.`, ...(canSeeRules ? { requirementRuleIds: ruleIds } : {}) });
    }
    return violations;
  }

  toDto(rule: FieldRequirement) {
    return { ...rule, schemaVersion: this.support.schemaVersion(rule.workspaceId, rule.entityType) };
  }

  private auditShape(rule: FieldRequirement) {
    return {
      id: rule.id,
      entityType: rule.entityType,
      targetKind: rule.targetKind,
      targetSystemFieldKey: rule.targetSystemFieldKey,
      targetCustomFieldId: rule.targetCustomFieldId,
      pipelineId: rule.pipelineId,
      stageId: rule.stageId,
      isActive: rule.isActive,
      conditions: rule.conditions,
      version: rule.version,
    };
  }
}

export { fieldValidationFailed };
