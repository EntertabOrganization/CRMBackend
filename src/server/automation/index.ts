import type { AccessService } from '../access-service';
import type { ActivityService } from '../activities/activity-service';
import type { CrmCoreService } from '../crm-core-service';
import type { CrmPipelineService } from '../crm-pipeline-service';
import type { User } from '../domain';
import type { FieldEngine } from '../fields/field-engine';
import type { FieldEntityRegistry } from '../fields/entity-registry';
import type { CommunicationPort, DocumentPort, NotificationPort, SecretPort } from '../ports';
import { UnconfiguredSecretPort } from '../ports';
import type { RealtimeHub } from '../realtime';
import type { InMemoryStore } from '../store';
import type { ActionServices } from './actions';
import { builtInActions } from './actions';
import { MAX_CONDITION_DEPTH, MAX_CONDITION_NODES, OPERATORS_BY_TYPE, operatorsFor } from './conditions';
import type { EgressPort } from './egress';
import { SafeHttpEgress } from './egress';
import { AutomationEngine } from './engine';
import { AutomationExecutionService } from './execution-service';
import { ExtensionService } from './extension-service';
import { AutomationIdentityService } from './identity';
import { AutomationRegistry, FieldEngineTarget } from './registry';
import { RuleService } from './rule-service';
import type { StateRunner } from './runner';
import { AutomationRunner } from './runner';
import { AutomationSupport } from './support';
import { MAX_AUTOMATION_DEPTH } from './support';
import { AUTOMATION_PERMISSIONS as P } from './types';

export type { StateRunner } from './runner';
export { AutomationRunner } from './runner';

/**
 * Automation composition root. Automation owns definitions, revisions, jobs, executions and logs; every business effect goes
 * through the owning module's service (CRM, Pipelines, Activities, ports for Notifications/Communication/Documents).
 * It is deliberately not the Workflows engine: no graphs, approvals, parallel joins or long-lived instances.
 */
export class AutomationModule {
  readonly support: AutomationSupport;
  readonly registry: AutomationRegistry;
  readonly identity: AutomationIdentityService;
  readonly services: ActionServices;
  readonly rules: RuleService;
  readonly engine: AutomationEngine;
  readonly execution: AutomationExecutionService;
  readonly extensions: ExtensionService;
  readonly runner: AutomationRunner;

  private notifications: NotificationPort | null = null;
  private communication: CommunicationPort | null = null;
  private documents: DocumentPort | null = null;
  private secrets: SecretPort = new UnconfiguredSecretPort();
  private egress: EgressPort = new SafeHttpEgress();
  private stateRunner: StateRunner | null = null;

  constructor(deps: {
    store: InMemoryStore;
    access: AccessService;
    realtime: RealtimeHub;
    fields: FieldEngine;
    registry: FieldEntityRegistry;
    crm: CrmPipelineService;
    crmCore: CrmCoreService;
    activities: ActivityService;
  }) {
    this.support = new AutomationSupport(deps.store, deps.access, deps.realtime);
    this.registry = new AutomationRegistry(deps.store);

    const crmRecord = (title: (record: Record<string, unknown>) => string) => ({
      title,
      actionable: (record: Record<string, unknown>) => !record.isDeleted && !record.isArchived,
    });
    const targets: Array<[string, string, boolean, ReturnType<typeof crmRecord>]> = [
      ['LEAD', 'Lead', true, crmRecord((record) => String(record.title ?? ''))],
      ['DEAL', 'Deal', true, crmRecord((record) => String(record.title ?? ''))],
      ['CONTACT', 'Contact', false, crmRecord((record) => String(record.displayName ?? ''))],
      ['COMPANY', 'Company', false, crmRecord((record) => String(record.name ?? ''))],
      ['ACTIVITY', 'Activity', false, { title: (record) => String(record.subject ?? ''), actionable: (record) => !record.isDeleted }],
    ];
    for (const [type, label, stages, config] of targets) {
      this.registry.targets.register(new FieldEngineTarget(type, label, stages, deps.store, deps.fields, deps.registry, config.title, config.actionable));
    }

    this.services = {
      store: deps.store,
      targets: this.registry.targets,
      crm: deps.crm,
      crmCore: deps.crmCore,
      activities: deps.activities,
      notifications: () => this.notifications,
      communication: () => this.communication,
      documents: () => this.documents,
      secrets: () => this.secrets,
      egress: () => this.egress,
      allowHttp: () => process.env.AUTOMATION_ALLOW_HTTP === '1',
    };
    for (const action of builtInActions()) this.registry.registerAction(action);

    this.identity = new AutomationIdentityService(deps.store, deps.access, this.registry);
    this.rules = new RuleService(this.support, this.registry, this.services, this.identity);
    this.engine = new AutomationEngine(this.support, this.registry, this.rules, this.identity, this.services);
    this.execution = new AutomationExecutionService(this.support, this.registry, this.rules, this.engine, this.identity, this.services);
    this.extensions = new ExtensionService(this.support, this.registry, this.rules, this.engine, this.services);
    this.runner = new AutomationRunner(this.execution, () => this.stateRunner ?? this.passthrough());
  }

  private passthrough(): StateRunner {
    // Default (tests / in-process use): work directly on the shared in-memory store and ingest the events each unit produced.
    return {
      unit: async (fn) => {
        const value = await fn();
        this.engine.ingestPending();
        return value;
      },
    };
  }

  /** The request layer installs the transactional runner; without one the in-memory passthrough is used. */
  setStateRunner(runner: StateRunner | null) {
    this.stateRunner = runner;
  }

  setNotificationPort(port: NotificationPort | null) {
    this.notifications = port;
  }
  setCommunicationPort(port: CommunicationPort | null) {
    this.communication = port;
  }
  setDocumentPort(port: DocumentPort | null) {
    this.documents = port;
  }
  setSecretPort(port: SecretPort) {
    this.secrets = port;
  }
  setEgress(port: EgressPort) {
    this.egress = port;
  }

  ingestPending() {
    return this.engine.ingestPending();
  }

  /** Cheap check used by the request wrapper: is there anything that could be due right now? */
  hasWork(now: Date = new Date()) {
    return this.support.state.automationJobs.some((job) => (job.status === 'PENDING' && job.scheduledAt <= now) || (job.status === 'RUNNING' && job.leaseExpiresAt !== null && job.leaseExpiresAt < now));
  }

  // ---- metadata (registry-driven, so the designer never hard-codes a target, trigger or action) --------------------------------------

  targetsMetadata(user: User, workspaceId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireAny(actor, P.read, P.manage, P.publish);
    return this.registry.targets.list().map((target) => ({
      targetType: target.targetType,
      label: target.label,
      supportsStages: target.supportsStages,
      stageEntityType: target.stageEntityType ?? null,
      fields: target.fields(workspaceId).map((field) => ({ ...field, operators: operatorsFor(field.dataType, field.source !== 'derived' || field.key === 'stageId') })),
      timingFields: target.timingFields(workspaceId),
      triggerCodes: this.registry.triggersFor(workspaceId).filter((trigger) => trigger.targetTypes.includes(target.targetType)).map((trigger) => trigger.code),
    }));
  }

  triggerTypes(user: User, workspaceId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireAny(actor, P.read, P.manage, P.publish);
    return this.registry.triggersFor(workspaceId).map((trigger) => ({
      code: trigger.code,
      label: trigger.label,
      category: trigger.category,
      description: trigger.description,
      targetTypes: trigger.targetTypes,
      configFields: trigger.configFields,
      isExtension: trigger.isExtension ?? false,
      payload: trigger.payloadSchema ?? null,
    }));
  }

  actionTypes(user: User, workspaceId: string) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireAny(actor, P.read, P.manage, P.publish);
    return this.registry
      .actionsFor(workspaceId)
      .filter((action) => action.isAvailable(this.services))
      .map((action) => ({
        code: action.code,
        label: action.label,
        category: action.category,
        description: action.description,
        ownerModule: action.ownerModule,
        targetTypes: action.targetTypes,
        configFields: action.configFields,
        sideEffect: action.sideEffect,
        supportsContinueOnError: action.supportsContinueOnError,
        timeoutMs: action.timeoutMs,
        isExtension: action.isExtension ?? false,
      }));
  }

  conditionMetadata(user: User, workspaceId: string, searchParams: URLSearchParams) {
    const actor = this.support.actor(user, workspaceId);
    this.support.requireAny(actor, P.read, P.manage, P.publish);
    const targetType = searchParams.get('targetType') ?? '';
    const triggerCode = searchParams.get('triggerCode');
    if (!this.registry.targets.has(targetType)) return { operatorsByType: OPERATORS_BY_TYPE, limits: this.limits(), operands: [], variables: [] };
    const trigger = triggerCode ? this.registry.triggerFor(workspaceId, triggerCode, true) : undefined;
    const operands = [...this.registry.operandsFor(workspaceId, targetType, trigger).values()].map((operand) => ({ ...operand, operators: operatorsFor(operand.dataType, operand.supportsChange) }));
    const variables = ['target.id', 'target.title', 'trigger.eventType', 'trigger.eventId', 'actor.id', 'rule.name', 'now', ...operands.map((operand) => operand.ref).filter((ref) => ref.startsWith('target.') || ref.startsWith('trigger.payload.'))];
    return { operatorsByType: OPERATORS_BY_TYPE, limits: this.limits(), operands, variables: [...new Set(variables)] };
  }

  private limits() {
    return { maxDepth: MAX_CONDITION_DEPTH, maxNodes: MAX_CONDITION_NODES, maxAutomationDepth: MAX_AUTOMATION_DEPTH };
  }
}
