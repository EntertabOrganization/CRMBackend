import { AuditService } from './audit-service';
import type {
  CrmDeal,
  CrmLead,
  CrmLeadCommunication,
  CrmPipeline,
  CrmPipelineEntityType,
  CrmRoleStagePermission,
  PermissionScope,
  CrmStage,
  CrmStageSemanticType,
  CrmCommunicationType,
  User,
} from './domain';
import { badRequest, conflict, forbidden, notFound } from './errors';
import type { InMemoryStore } from './store';

type StageInput = {
  name: string;
  semanticType: CrmStageSemanticType;
  isDefault?: boolean;
  position?: number;
};

type TransitionInput = {
  expectedVersion: number;
  targetPipelineId?: string;
  targetStageId: string;
  lostReasonId?: string;
  lostReasonComment?: string | null;
  overrideTransitionGraph?: boolean;
  fieldValues?: Record<string, unknown>;
};

type PipelineMigrationInput = {
  targetPipelineId: string;
  stageMappings: Array<{
    fromStageId: string;
    toStageId: string;
  }>;
};

type LegacyBackfillInput = {
  leadStatusToStageName?: Record<string, string>;
  dealStatusToStageName?: Record<string, string>;
};

type CommunicationInput = {
  type: CrmCommunicationType;
  value: string;
  label?: string | null;
  isPrimary?: boolean;
};

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

type RequiredFieldRule = {
  field: string;
  label?: string;
};

type RequiredFieldResolver = {
  requiredFieldsForStage: (context: {
    workspaceId: string;
    entityType: CrmPipelineEntityType;
    pipelineId: string;
    stageId: string;
  }) => RequiredFieldRule[];
};

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeCommunication(type: CrmCommunicationType, value: string) {
  const trimmed = value.trim();
  if (type === 'EMAIL') return trimmed.toLowerCase();
  if (type === 'PHONE') return trimmed.replace(/[^\d+]/g, '');
  if (type === 'WEB') return trimmed.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  return trimmed.toLowerCase();
}

function now() {
  return new Date();
}

export class CrmPipelineService {
  constructor(
    private readonly store: InMemoryStore,
    private requiredFieldResolver: RequiredFieldResolver = { requiredFieldsForStage: () => [] },
  ) {}

  setRequiredFieldResolver(resolver: RequiredFieldResolver) {
    this.requiredFieldResolver = resolver;
  }

  bootstrapDefaults(workspaceId: string) {
    const lead = this.defaultPipeline(workspaceId, 'LEAD', 'Default Lead Pipeline', [
      { name: 'New', semanticType: 'PROGRESS', isDefault: true, position: 10 },
      { name: 'Qualified', semanticType: 'SUCCESS', position: 20 },
      { name: 'Disqualified', semanticType: 'FAILURE', position: 30 },
    ]);
    const deal = this.defaultPipeline(workspaceId, 'DEAL', 'Default Deal Pipeline', [
      { name: 'New', semanticType: 'PROGRESS', isDefault: true, position: 10 },
      { name: 'Won', semanticType: 'SUCCESS', position: 20 },
      { name: 'Lost', semanticType: 'FAILURE', position: 30 },
    ]);
    return { lead, deal };
  }

  backfillLegacyWorkspace(actor: User, workspaceId: string, input: LegacyBackfillInput = {}) {
    this.assertPipelineManager(actor.id, workspaceId);
    const snapshot = this.store.cloneState();
    try {
      this.bootstrapDefaults(workspaceId);
      const leadPipeline = this.defaultActivePipeline(workspaceId, 'LEAD');
      const dealPipeline = this.defaultActivePipeline(workspaceId, 'DEAL');
      const assignments = [
        ...this.planLegacyRecordBackfill(workspaceId, 'LEAD', leadPipeline, input.leadStatusToStageName ?? {}),
        ...this.planLegacyRecordBackfill(workspaceId, 'DEAL', dealPipeline, input.dealStatusToStageName ?? {}),
      ];

      for (const { entityType, record, pipeline, stage } of assignments) {
        const before = {
          pipelineId: record.pipelineId || null,
          stageId: record.stageId || null,
          version: record.version,
          legacyStatus: this.legacyStatus(record),
        };
        record.pipelineId = pipeline.id;
        record.stageId = stage.id;
        record.updatedAt = now();
        record.version += 1;
        this.applyStatusFromStage(entityType, record, stage);
        this.appendStageHistory(workspaceId, entityType, record.id, before.pipelineId, before.stageId, pipeline.id, stage.id, actor.id);
        this.emitStageChanged(workspaceId, entityType, record.id, actor.id, before, {
          pipelineId: record.pipelineId,
          stageId: record.stageId,
          version: record.version,
        });
      }

      this.validateWorkspacePipelineConfiguration(workspaceId);
      new AuditService(this.store).write({
        workspaceId,
        actorUserId: actor.id,
        action: 'CRM.PIPELINE.LEGACY_BACKFILLED',
        entityType: 'Workspace',
        entityId: workspaceId,
        afterData: { migratedRecords: assignments.length },
      });
      return {
        migratedRecords: assignments.length,
        leadPipelineId: leadPipeline.id,
        dealPipelineId: dealPipeline.id,
      };
    } catch (error) {
      this.store.state = snapshot;
      throw error;
    }
  }

  createPipeline(
    actor: User,
    workspaceId: string,
    input: {
      entityType: CrmPipelineEntityType;
      name: string;
      isDefault?: boolean;
      transitionRulesEnabled?: boolean;
      stages: StageInput[];
    },
  ) {
    this.assertPipelineManager(actor.id, workspaceId);
    const pipeline = this.buildPipeline(workspaceId, input.entityType, input.name, {
      isDefault: Boolean(input.isDefault),
      transitionRulesEnabled: Boolean(input.transitionRulesEnabled),
    });
    const stages = this.buildStages(workspaceId, pipeline.id, input.stages);
    this.validatePipelineCanBecomeActive(workspaceId, pipeline, stages);
    if (pipeline.isDefault) this.clearDefaultPipeline(workspaceId, pipeline.entityType);
    this.store.state.crmPipelines.push(pipeline);
    this.store.state.crmStages.push(...stages);
    new AuditService(this.store).write({
      workspaceId,
      actorUserId: actor.id,
      action: 'CRM.PIPELINE.CREATED',
      entityType: 'CrmPipeline',
      entityId: pipeline.id,
      afterData: { id: pipeline.id, entityType: pipeline.entityType, name: pipeline.name },
    });
    return { pipeline, stages };
  }

  listPipelines(actor: User, workspaceId: string, entityType?: CrmPipelineEntityType) {
    this.assertMembership(actor.id, workspaceId);
    return this.store.state.crmPipelines.filter(
      (pipeline) => pipeline.workspaceId === workspaceId && pipeline.isActive && (!entityType || pipeline.entityType === entityType),
    );
  }

  createStage(actor: User, workspaceId: string, pipelineId: string, input: StageInput) {
    this.assertPipelineManager(actor.id, workspaceId);
    const pipeline = this.activePipeline(workspaceId, pipelineId);
    const stage = this.buildStage(workspaceId, pipeline.id, input, this.store.state.crmStages.length + 1);
    const siblings = this.store.state.crmStages.filter((item) => item.pipelineId === pipeline.id && item.isActive);
    this.validateStageNameUnique(pipeline.id, stage.name);
    this.validatePipelineCanBecomeActive(workspaceId, pipeline, [...siblings, stage]);
    if (stage.isDefault) this.clearDefaultStage(pipeline.id);
    this.store.state.crmStages.push(stage);
    pipeline.updatedAt = now();
    pipeline.version += 1;
    return stage;
  }

  updateStage(
    actor: User,
    workspaceId: string,
    stageId: string,
    input: Partial<Pick<CrmStage, 'name' | 'position' | 'semanticType' | 'isDefault' | 'isActive'>>,
  ) {
    this.assertPipelineManager(actor.id, workspaceId);
    const stage = this.store.state.crmStages.find((item) => item.id === stageId && item.workspaceId === workspaceId);
    if (!stage) throw notFound('CRM_STAGE');
    const pipeline = this.activePipeline(workspaceId, stage.pipelineId);
    if (input.name && normalizeName(input.name) !== normalizeName(stage.name)) {
      this.validateStageNameUnique(pipeline.id, input.name, stage.id);
    }
    const nextStage = { ...stage, ...input, updatedAt: now(), version: stage.version + 1 };
    const nextStages = this.store.state.crmStages
      .filter((item) => item.pipelineId === pipeline.id && item.id !== stage.id)
      .concat(nextStage)
      .filter((item) => item.isActive);
    this.validatePipelineCanBecomeActive(workspaceId, pipeline, nextStages);
    if (nextStage.isDefault) this.clearDefaultStage(pipeline.id, stage.id);
    Object.assign(stage, nextStage);
    return stage;
  }

  setStagePermission(
    actor: User,
    workspaceId: string,
    roleId: string,
    stageId: string,
    input: { canView?: boolean; canEnter?: boolean; canLeave?: boolean },
  ) {
    this.assertPipelineManager(actor.id, workspaceId);
    const role = this.store.state.roles.find((item) => item.id === roleId && item.workspaceId === workspaceId && !item.isDeleted);
    if (!role) throw notFound('Role');
    if (role.isOwnerRole) throw forbidden('Owner/Admin role stage permissions are implicit and protected.');
    this.activeStage(workspaceId, stageId);
    const existing = this.store.state.crmRoleStagePermissions.find((item) => item.roleId === roleId && item.stageId === stageId);
    if (existing) {
      Object.assign(existing, {
        canView: input.canView ?? existing.canView,
        canEnter: input.canEnter ?? existing.canEnter,
        canLeave: input.canLeave ?? existing.canLeave,
        updatedAt: now(),
      });
      return existing;
    }
    const permission: CrmRoleStagePermission = {
      id: this.store.id(),
      workspaceId,
      roleId,
      stageId,
      canView: input.canView ?? true,
      canEnter: input.canEnter ?? true,
      canLeave: input.canLeave ?? true,
      createdAt: now(),
      updatedAt: now(),
    };
    this.store.state.crmRoleStagePermissions.push(permission);
    return permission;
  }

  deactivateStage(actor: User, workspaceId: string, stageId: string, replacementStageId?: string) {
    this.assertPipelineManager(actor.id, workspaceId);
    const snapshot = this.store.cloneState();
    try {
      const stage = this.activeStage(workspaceId, stageId);
      const pipeline = this.activePipeline(workspaceId, stage.pipelineId);
      const currentRecords = this.currentRecordsForStage(workspaceId, pipeline.entityType, stage.id);
      const replacement = replacementStageId ? this.activeStage(workspaceId, replacementStageId) : null;

      if (currentRecords.length > 0 && !replacement) {
        throw conflict('CRM_STAGE_MIGRATION_REQUIRED', 'Stage has current records and requires an explicit replacement stage.');
      }
      if (replacement) {
        if (replacement.pipelineId !== pipeline.id) throw badRequest('CRM_STAGE_WRONG_PIPELINE', 'Replacement stage must belong to the same pipeline.');
        if (replacement.id === stage.id) throw badRequest('CRM_STAGE_REPLACEMENT_INVALID', 'Replacement stage must differ from the removed stage.');
      }
      if (stage.isDefault) {
        if (!replacement || replacement.semanticType !== 'PROGRESS') {
          throw conflict('CRM_DEFAULT_STAGE_PROTECTED', 'Default stage cannot be removed until another default PROGRESS stage exists.');
        }
        replacement.isDefault = true;
        replacement.updatedAt = now();
        replacement.version += 1;
      }

      const remainingStages = this.store.state.crmStages
        .filter((item) => item.pipelineId === pipeline.id && item.id !== stage.id && item.isActive);
      this.validatePipelineCanBecomeActive(workspaceId, pipeline, remainingStages);

      for (const record of currentRecords) {
        const before = { pipelineId: record.pipelineId, stageId: record.stageId, version: record.version };
        record.stageId = replacement!.id;
        record.pipelineId = pipeline.id;
        record.version += 1;
        record.updatedAt = now();
        this.applyStatusFromStage(pipeline.entityType, record, replacement!);
        this.appendStageHistory(workspaceId, pipeline.entityType, record.id, before.pipelineId, before.stageId, pipeline.id, replacement!.id, actor.id);
        this.emitStageChanged(workspaceId, pipeline.entityType, record.id, actor.id, before, {
          pipelineId: record.pipelineId,
          stageId: record.stageId,
          version: record.version,
        });
      }

      stage.isActive = false;
      stage.isDefault = false;
      stage.updatedAt = now();
      stage.version += 1;
      pipeline.updatedAt = now();
      pipeline.version += 1;
      new AuditService(this.store).write({
        workspaceId,
        actorUserId: actor.id,
        action: 'CRM.STAGE.DEACTIVATED',
        entityType: 'CrmStage',
        entityId: stage.id,
        afterData: { replacementStageId: replacement?.id ?? null, migratedRecords: currentRecords.length },
      });
      return { stage, migratedRecords: currentRecords.length };
    } catch (error) {
      this.store.state = snapshot;
      throw error;
    }
  }

  deactivatePipeline(actor: User, workspaceId: string, pipelineId: string, migration?: PipelineMigrationInput) {
    // An empty body means no migration mapping was supplied.
    const input = migration?.targetPipelineId ? migration : undefined;
    this.assertPipelineManager(actor.id, workspaceId);
    const snapshot = this.store.cloneState();
    try {
      const pipeline = this.activePipeline(workspaceId, pipelineId);
      const currentRecords = this.currentRecordsForPipeline(workspaceId, pipeline.entityType, pipeline.id);
      const activePeerPipelines = this.store.state.crmPipelines.filter(
        (item) => item.workspaceId === workspaceId && item.entityType === pipeline.entityType && item.id !== pipeline.id && item.isActive,
      );
      if (activePeerPipelines.length === 0) throw conflict('CRM_LAST_PIPELINE_PROTECTED', 'Cannot deactivate the last active pipeline for an entity type.');
      if (pipeline.isDefault && !activePeerPipelines.some((item) => item.isDefault)) {
        throw conflict('CRM_DEFAULT_PIPELINE_PROTECTED', 'Default pipeline cannot be removed until another default pipeline exists.');
      }
      if (currentRecords.length > 0 && !input) {
        throw conflict('CRM_PIPELINE_MIGRATION_REQUIRED', 'Pipeline has current records and requires an explicit stage mapping.');
      }

      let mapping = new Map<string, CrmStage>();
      let targetPipeline: CrmPipeline | null = null;
      if (input) {
        targetPipeline = this.activePipeline(workspaceId, input.targetPipelineId);
        if (targetPipeline.id === pipeline.id) throw badRequest('CRM_PIPELINE_REPLACEMENT_INVALID', 'Target pipeline must differ from the deactivated pipeline.');
        if (targetPipeline.entityType !== pipeline.entityType) {
          throw badRequest('CRM_PIPELINE_ENTITY_TYPE_MISMATCH', 'Target pipeline does not match the deactivated pipeline entity type.');
        }
        mapping = this.validatePipelineMigrationMapping(workspaceId, pipeline, targetPipeline, currentRecords, input.stageMappings);
      }

      for (const record of currentRecords) {
        const targetStage = mapping.get(record.stageId);
        if (!targetStage || !targetPipeline) throw conflict('CRM_PIPELINE_MIGRATION_REQUIRED', 'Pipeline migration mapping is incomplete.');
        const before = { pipelineId: record.pipelineId, stageId: record.stageId, version: record.version };
        record.pipelineId = targetPipeline.id;
        record.stageId = targetStage.id;
        record.version += 1;
        record.updatedAt = now();
        this.applyStatusFromStage(pipeline.entityType, record, targetStage);
        this.appendStageHistory(workspaceId, pipeline.entityType, record.id, before.pipelineId, before.stageId, targetPipeline.id, targetStage.id, actor.id);
        this.emitStageChanged(workspaceId, pipeline.entityType, record.id, actor.id, before, {
          pipelineId: record.pipelineId,
          stageId: record.stageId,
          version: record.version,
        });
      }

      pipeline.isActive = false;
      pipeline.isDefault = false;
      pipeline.updatedAt = now();
      pipeline.version += 1;
      for (const stage of this.store.state.crmStages) {
        if (stage.pipelineId === pipeline.id && stage.isActive) {
          stage.isActive = false;
          stage.isDefault = false;
          stage.updatedAt = now();
          stage.version += 1;
        }
      }
      new AuditService(this.store).write({
        workspaceId,
        actorUserId: actor.id,
        action: 'CRM.PIPELINE.DEACTIVATED',
        entityType: 'CrmPipeline',
        entityId: pipeline.id,
        afterData: { targetPipelineId: targetPipeline?.id ?? null, migratedRecords: currentRecords.length },
      });
      return { pipeline, migratedRecords: currentRecords.length };
    } catch (error) {
      this.store.state = snapshot;
      throw error;
    }
  }

  createLead(
    actor: User,
    workspaceId: string,
    input: {
      title: string;
      firstName?: string | null;
      lastName?: string | null;
      companyName?: string | null;
      responsibleUserId?: string;
      companyId?: string | null;
      contactIds?: string[];
      pipelineId?: string;
      stageId?: string;
      sourceId?: string | null;
      sourceDescription?: string | null;
      estimatedAmount?: number | null;
      currencyCode?: string | null;
      addressLine1?: string | null;
      addressLine2?: string | null;
      city?: string | null;
      stateOrProvince?: string | null;
      postalCode?: string | null;
      countryCode?: string | null;
      utmSource?: string | null;
      utmMedium?: string | null;
      utmCampaign?: string | null;
      utmContent?: string | null;
      utmTerm?: string | null;
      originSystem?: string | null;
      originExternalId?: string | null;
      originVersion?: string | null;
      communications?: CommunicationInput[];
      forceCreate?: boolean;
    },
    idempotencyKey?: string,
  ) {
    const idempotent = this.findIdempotentReplay(workspaceId, actor.id, 'crm.lead.create', input, idempotencyKey);
    if (idempotent) return idempotent as CrmLead;
    this.assertMembership(actor.id, workspaceId);
    this.assertLeadCustomerLinks(workspaceId, input.companyId ?? null, input.contactIds ?? []);
    this.assertActiveSource(workspaceId, input.sourceId ?? null);
    this.assertNoDuplicateLeadCommunications(workspaceId, input.communications ?? [], Boolean(input.forceCreate));
    const { pipeline, stage } = this.resolvePipelineAndStage(workspaceId, 'LEAD', input.pipelineId, input.stageId);
    const record: CrmLead = {
      id: this.store.id(),
      workspaceId,
      title: input.title,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      companyName: input.companyName ?? null,
      responsibleUserId: input.responsibleUserId ?? actor.id,
      companyId: input.companyId ?? null,
      pipelineId: pipeline.id,
      stageId: stage.id,
      status: this.leadStatus(stage.semanticType),
      conversionStatus: 'NOT_CONVERTED',
      convertedAt: null,
      convertedByUserId: null,
      sourceId: input.sourceId ?? null,
      sourceDescription: input.sourceDescription ?? null,
      estimatedAmount: input.estimatedAmount ?? null,
      currencyCode: input.currencyCode ?? null,
      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      city: input.city ?? null,
      stateOrProvince: input.stateOrProvince ?? null,
      postalCode: input.postalCode ?? null,
      countryCode: input.countryCode ?? null,
      utmSource: input.utmSource ?? null,
      utmMedium: input.utmMedium ?? null,
      utmCampaign: input.utmCampaign ?? null,
      utmContent: input.utmContent ?? null,
      utmTerm: input.utmTerm ?? null,
      originSystem: input.originSystem ?? null,
      originExternalId: input.originExternalId ?? null,
      originVersion: input.originVersion ?? null,
      lostReasonId: null,
      lostReasonComment: null,
      isArchived: false,
      archivedAt: null,
      archivedByUserId: null,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      createdAt: now(),
      updatedAt: now(),
      version: 1,
    };
    this.store.state.crmLeads.push(record);
    for (const [index, contactId] of Array.from(new Set(input.contactIds ?? [])).entries()) {
      this.store.state.crmLeadContacts.push({
        id: this.store.id(),
        workspaceId,
        leadId: record.id,
        contactId,
        isPrimary: index === 0,
        sortOrder: index + 1,
        createdAt: now(),
        updatedAt: now(),
      });
    }
    for (const communication of input.communications ?? []) {
      this.addLeadCommunication(workspaceId, record.id, communication);
    }
    this.appendStageHistory(workspaceId, 'LEAD', record.id, null, null, pipeline.id, stage.id, actor.id);
    new AuditService(this.store).write({
      workspaceId,
      actorUserId: actor.id,
      action: 'CRM.LEAD.CREATED',
      entityType: 'CrmLead',
      entityId: record.id,
      afterData: { id: record.id, title: record.title, pipelineId: record.pipelineId, stageId: record.stageId },
    });
    this.store.state.outboxEvents.push({
      id: this.store.id(),
      workspaceId,
      eventType: 'CRM.LEAD.CREATED',
      entityType: 'LEAD',
      entityId: record.id,
      actorUserId: actor.id,
      occurredAt: now(),
      payload: { entityVersion: record.version, pipelineId: record.pipelineId, stageId: record.stageId },
    });
    this.storeIdempotentResponse(workspaceId, actor.id, 'crm.lead.create', input, idempotencyKey, record);
    return record;
  }

  createDeal(
    actor: User,
    workspaceId: string,
    input: {
      title: string;
      responsibleUserId?: string;
      pipelineId?: string;
      stageId?: string;
      amount?: number;
      currencyCode?: string;
      sourceId?: string | null;
      sourceDescription?: string | null;
      utmSource?: string | null;
      utmMedium?: string | null;
      utmCampaign?: string | null;
      utmContent?: string | null;
      utmTerm?: string | null;
      originSystem?: string | null;
      originExternalId?: string | null;
      originVersion?: string | null;
      companyId?: string | null;
      contactIds?: string[];
      primaryContactId?: string;
    },
    idempotencyKey?: string,
  ) {
    const idempotent = this.findIdempotentReplay(workspaceId, actor.id, 'crm.deal.create', input, idempotencyKey);
    if (idempotent) return idempotent as CrmDeal;
    this.assertMembership(actor.id, workspaceId);
    this.assertActiveWorkspaceMember(workspaceId, input.responsibleUserId ?? actor.id);
    this.assertActiveSource(workspaceId, input.sourceId ?? null);
    const contactIds = Array.from(new Set(input.contactIds ?? []));
    if (!input.companyId && contactIds.length === 0) {
      throw badRequest('CRM_CUSTOMER_REQUIRED', 'A deal requires a company or at least one contact.');
    }
    if (input.companyId) {
      const company = this.store.state.crmCompanies.find((item) => item.id === input.companyId && item.workspaceId === workspaceId && !item.isDeleted);
      if (!company) throw notFound('CRM_COMPANY');
    }
    for (const contactId of contactIds) {
      const contact = this.store.state.crmContacts.find((item) => item.id === contactId && item.workspaceId === workspaceId && !item.isDeleted);
      if (!contact) throw notFound('CRM_CONTACT');
    }
    if (contactIds.length > 0 && input.primaryContactId && !contactIds.includes(input.primaryContactId)) {
      throw badRequest('CRM_PRIMARY_RELATION_REPLACEMENT_REQUIRED', 'Primary deal contact must be included in contactIds.');
    }
    const { pipeline, stage } = this.resolvePipelineAndStage(workspaceId, 'DEAL', input.pipelineId, input.stageId);
    const record: CrmDeal = {
      id: this.store.id(),
      workspaceId,
      title: input.title,
      responsibleUserId: input.responsibleUserId ?? actor.id,
      companyId: input.companyId ?? null,
      pipelineId: pipeline.id,
      stageId: stage.id,
      status: this.dealStatus(stage.semanticType),
      amount: input.amount ?? null,
      currencyCode: input.currencyCode ?? null,
      sourceId: input.sourceId ?? null,
      sourceDescription: input.sourceDescription ?? null,
      utmSource: input.utmSource ?? null,
      utmMedium: input.utmMedium ?? null,
      utmCampaign: input.utmCampaign ?? null,
      utmContent: input.utmContent ?? null,
      utmTerm: input.utmTerm ?? null,
      originSystem: input.originSystem ?? null,
      originExternalId: input.originExternalId ?? null,
      originVersion: input.originVersion ?? null,
      lostReasonId: null,
      lostReasonComment: null,
      isArchived: false,
      archivedAt: null,
      archivedByUserId: null,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      createdAt: now(),
      updatedAt: now(),
      version: 1,
    };
    this.store.state.crmDeals.push(record);
    contactIds.forEach((contactId, index) => {
      this.store.state.crmDealContacts.push({
        id: this.store.id(),
        workspaceId,
        dealId: record.id,
        contactId,
        role: null,
        isPrimary: input.primaryContactId ? input.primaryContactId === contactId : index === 0,
        sortOrder: index + 1,
        createdAt: now(),
        updatedAt: now(),
      });
    });
    this.appendStageHistory(workspaceId, 'DEAL', record.id, null, null, pipeline.id, stage.id, actor.id);
    new AuditService(this.store).write({
      workspaceId,
      actorUserId: actor.id,
      action: 'CRM.DEAL.CREATED',
      entityType: 'CrmDeal',
      entityId: record.id,
      afterData: { id: record.id, title: record.title, pipelineId: record.pipelineId, stageId: record.stageId },
    });
    this.store.state.outboxEvents.push({
      id: this.store.id(),
      workspaceId,
      eventType: 'CRM.DEAL.CREATED',
      entityType: 'DEAL',
      entityId: record.id,
      actorUserId: actor.id,
      occurredAt: now(),
      payload: { entityVersion: record.version, pipelineId: record.pipelineId, stageId: record.stageId },
    });
    this.storeIdempotentResponse(workspaceId, actor.id, 'crm.deal.create', input, idempotencyKey, record);
    return record;
  }

  transitionLead(actor: User, workspaceId: string, leadId: string, input: TransitionInput, idempotencyKey?: string) {
    const idempotent = this.findIdempotentReplay(workspaceId, actor.id, `crm.lead.transition:${leadId}`, input, idempotencyKey);
    if (idempotent) return idempotent as CrmLead;
    const lead = this.store.state.crmLeads.find((item) => item.id === leadId && item.workspaceId === workspaceId && !item.isDeleted);
    if (!lead) throw notFound('CRM_LEAD');
    if (lead.conversionStatus === 'CONVERTED') throw conflict('CRM_ALREADY_CONVERTED', 'Converted leads cannot be transitioned.');
    const result = this.transitionRecord(actor, workspaceId, 'LEAD', lead, input);
    this.storeIdempotentResponse(workspaceId, actor.id, `crm.lead.transition:${leadId}`, input, idempotencyKey, result);
    return result;
  }

  transitionDeal(actor: User, workspaceId: string, dealId: string, input: TransitionInput, idempotencyKey?: string) {
    const idempotent = this.findIdempotentReplay(workspaceId, actor.id, `crm.deal.transition:${dealId}`, input, idempotencyKey);
    if (idempotent) return idempotent as CrmDeal;
    const deal = this.store.state.crmDeals.find((item) => item.id === dealId && item.workspaceId === workspaceId && !item.isDeleted);
    if (!deal) throw notFound('CRM_DEAL');
    const result = this.transitionRecord(actor, workspaceId, 'DEAL', deal, input);
    this.storeIdempotentResponse(workspaceId, actor.id, `crm.deal.transition:${dealId}`, input, idempotencyKey, result);
    return result;
  }

  private transitionRecord<T extends CrmLead | CrmDeal>(
    actor: User,
    workspaceId: string,
    entityType: CrmPipelineEntityType,
    record: T,
    input: TransitionInput,
  ) {
    this.assertMembership(actor.id, workspaceId);
    this.assertRecordPermission(
      actor.id,
      workspaceId,
      entityType === 'LEAD' ? 'crm.lead.transition' : 'crm.deal.transition',
      record,
    );
    if (record.version !== input.expectedVersion) {
      throw conflict('CRM_VERSION_CONFLICT', 'CRM record version is stale.');
    }
    const currentPipeline = this.activePipeline(workspaceId, record.pipelineId);
    const currentStage = this.activeStage(workspaceId, record.stageId);
    const targetPipelineId = input.targetPipelineId ?? record.pipelineId;
    const targetPipeline = this.activePipeline(workspaceId, targetPipelineId);
    if (targetPipeline.entityType !== entityType) {
      throw badRequest('CRM_PIPELINE_ENTITY_TYPE_MISMATCH', 'Target pipeline does not match the CRM record type.');
    }
    const targetStage = this.activeStage(workspaceId, input.targetStageId);
    if (targetStage.pipelineId !== targetPipeline.id) {
      throw badRequest('CRM_STAGE_WRONG_PIPELINE', 'Target stage does not belong to the target pipeline.');
    }
    if (targetPipeline.id !== currentPipeline.id && !input.targetPipelineId) {
      throw badRequest('CRM_INVALID_PIPELINE', 'Cross-pipeline transitions require an explicit target pipeline.');
    }
    this.assertStageAccess(actor.id, workspaceId, currentStage.id, 'leave');
    this.assertStageAccess(actor.id, workspaceId, targetStage.id, 'view');
    this.assertStageAccess(actor.id, workspaceId, targetStage.id, 'enter');
    if (targetPipeline.transitionRulesEnabled && !input.overrideTransitionGraph) {
      const edge = this.store.state.crmStageTransitions.find(
        (item) =>
          item.workspaceId === workspaceId &&
          item.pipelineId === targetPipeline.id &&
          item.fromStageId === currentStage.id &&
          item.toStageId === targetStage.id &&
          item.isActive,
      );
      if (!edge) throw conflict('CRM_TRANSITION_NOT_ALLOWED', 'The configured transition graph does not allow this move.');
    }
    if (targetStage.semanticType === 'FAILURE') {
      const lostReason = input.lostReasonId
        ? this.store.state.crmLostReasons.find((item) => item.id === input.lostReasonId && item.workspaceId === workspaceId && item.isActive)
        : null;
      if (!lostReason) throw badRequest('CRM_LOST_REASON_REQUIRED', 'A valid lost reason is required for failure stages.');
    }
    this.validateAndApplyRequiredFields(workspaceId, entityType, record, targetPipeline.id, targetStage.id, input.fieldValues ?? {});

    const before = { pipelineId: record.pipelineId, stageId: record.stageId, version: record.version };
    record.pipelineId = targetPipeline.id;
    record.stageId = targetStage.id;
    record.version += 1;
    record.updatedAt = now();
    record.lostReasonId = targetStage.semanticType === 'FAILURE' ? input.lostReasonId! : null;
    record.lostReasonComment = targetStage.semanticType === 'FAILURE' ? input.lostReasonComment ?? null : null;
    if (entityType === 'LEAD') {
      (record as CrmLead).status = this.leadStatus(targetStage.semanticType);
    } else {
      (record as CrmDeal).status = this.dealStatus(targetStage.semanticType);
    }
    this.appendStageHistory(workspaceId, entityType, record.id, before.pipelineId, before.stageId, targetPipeline.id, targetStage.id, actor.id);
    this.emitStageChanged(workspaceId, entityType, record.id, actor.id, before, {
      pipelineId: record.pipelineId,
      stageId: record.stageId,
      version: record.version,
    });
    return record;
  }

  private validateAndApplyRequiredFields(
    workspaceId: string,
    entityType: CrmPipelineEntityType,
    record: CrmLead | CrmDeal,
    pipelineId: string,
    stageId: string,
    fieldValues: Record<string, unknown>,
  ) {
    const rules = this.requiredFieldResolver.requiredFieldsForStage({ workspaceId, entityType, pipelineId, stageId });
    if (rules.length === 0) return;
    const recordValues = record as unknown as Record<string, unknown>;
    const missing = rules.filter((rule) => {
      const value = fieldValues[rule.field] ?? recordValues[rule.field];
      return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
    });
    if (missing.length > 0) {
      throw badRequest('CRM_STAGE_REQUIRED_FIELDS_MISSING', 'Required fields are missing for the target stage.', {
        fields: missing.map((rule) => ({ field: rule.field, label: rule.label ?? rule.field })),
      });
    }
    for (const rule of rules) {
      if (Object.prototype.hasOwnProperty.call(fieldValues, rule.field) && Object.prototype.hasOwnProperty.call(recordValues, rule.field)) {
        recordValues[rule.field] = fieldValues[rule.field];
      }
    }
  }

  private defaultPipeline(workspaceId: string, entityType: CrmPipelineEntityType, name: string, stages: StageInput[]) {
    const existing = this.store.state.crmPipelines.find(
      (pipeline) => pipeline.workspaceId === workspaceId && pipeline.entityType === entityType && pipeline.isDefault && pipeline.isActive,
    );
    if (existing) {
      return {
        pipeline: existing,
        stages: this.store.state.crmStages.filter((stage) => stage.pipelineId === existing.id && stage.isActive),
      };
    }
    const pipeline = this.buildPipeline(workspaceId, entityType, name, { isDefault: true });
    const builtStages = this.buildStages(workspaceId, pipeline.id, stages);
    this.store.state.crmPipelines.push(pipeline);
    this.store.state.crmStages.push(...builtStages);
    return { pipeline, stages: builtStages };
  }

  private buildPipeline(
    workspaceId: string,
    entityType: CrmPipelineEntityType,
    name: string,
    options: { isDefault?: boolean; transitionRulesEnabled?: boolean } = {},
  ): CrmPipeline {
    const normalizedName = normalizeName(name);
    if (!normalizedName) throw badRequest('CRM_INVALID_PIPELINE', 'Pipeline name is required.');
    const duplicate = this.store.state.crmPipelines.some(
      (pipeline) =>
        pipeline.workspaceId === workspaceId &&
        pipeline.entityType === entityType &&
        pipeline.normalizedName === normalizedName &&
        pipeline.isActive,
    );
    if (duplicate) throw conflict('CRM_PIPELINE_NAME_EXISTS', 'Pipeline name already exists for this workspace and entity type.');
    return {
      id: this.store.id(),
      workspaceId,
      entityType,
      name: name.trim(),
      normalizedName,
      isDefault: Boolean(options.isDefault),
      isActive: true,
      transitionRulesEnabled: Boolean(options.transitionRulesEnabled),
      createdAt: now(),
      updatedAt: now(),
      version: 1,
    };
  }

  private buildStages(workspaceId: string, pipelineId: string, stages: StageInput[]) {
    return stages.map((stage, index) => this.buildStage(workspaceId, pipelineId, stage, index + 1));
  }

  private buildStage(workspaceId: string, pipelineId: string, input: StageInput, index: number): CrmStage {
    return {
      id: this.store.id(),
      workspaceId,
      pipelineId,
      name: input.name.trim(),
      position: input.position ?? index * 10,
      semanticType: input.semanticType,
      isDefault: Boolean(input.isDefault),
      isActive: true,
      createdAt: now(),
      updatedAt: now(),
      version: 1,
    };
  }

  private validatePipelineCanBecomeActive(workspaceId: string, pipeline: CrmPipeline, stages: CrmStage[]) {
    const activeStages = stages.filter((stage) => stage.workspaceId === workspaceId && stage.pipelineId === pipeline.id && stage.isActive);
    if (activeStages.filter((stage) => stage.semanticType === 'PROGRESS').length < 1) {
      throw badRequest('CRM_PIPELINE_STRUCTURE_INVALID', 'An active pipeline requires at least one PROGRESS stage.');
    }
    if (activeStages.filter((stage) => stage.semanticType === 'SUCCESS').length !== 1) {
      throw badRequest('CRM_PIPELINE_STRUCTURE_INVALID', 'An active pipeline requires exactly one SUCCESS stage.');
    }
    if (activeStages.filter((stage) => stage.semanticType === 'FAILURE').length < 1) {
      throw badRequest('CRM_PIPELINE_STRUCTURE_INVALID', 'An active pipeline requires at least one FAILURE stage.');
    }
    const defaultStages = activeStages.filter((stage) => stage.isDefault);
    if (defaultStages.length !== 1 || defaultStages[0].semanticType !== 'PROGRESS') {
      throw badRequest('CRM_DEFAULT_STAGE_REQUIRED', 'An active pipeline requires exactly one default PROGRESS stage.');
    }
  }

  private validateStageNameUnique(pipelineId: string, name: string, exceptStageId?: string) {
    const normalized = normalizeName(name);
    const duplicate = this.store.state.crmStages.some(
      (stage) => stage.pipelineId === pipelineId && stage.id !== exceptStageId && normalizeName(stage.name) === normalized && stage.isActive,
    );
    if (duplicate) throw conflict('CRM_STAGE_NAME_EXISTS', 'Stage name already exists in this pipeline.');
  }

  private resolvePipelineAndStage(workspaceId: string, entityType: CrmPipelineEntityType, pipelineId?: string, stageId?: string) {
    const pipeline = pipelineId ? this.activePipeline(workspaceId, pipelineId) : this.defaultActivePipeline(workspaceId, entityType);
    if (pipeline.entityType !== entityType) {
      throw badRequest('CRM_PIPELINE_ENTITY_TYPE_MISMATCH', 'Pipeline does not match the CRM record type.');
    }
    const stage = stageId ? this.activeStage(workspaceId, stageId) : this.defaultStage(pipeline.id);
    if (stage.pipelineId !== pipeline.id) {
      throw badRequest('CRM_STAGE_WRONG_PIPELINE', 'Stage does not belong to the selected pipeline.');
    }
    return { pipeline, stage };
  }

  private defaultActivePipeline(workspaceId: string, entityType: CrmPipelineEntityType) {
    const pipeline = this.store.state.crmPipelines.find(
      (item) => item.workspaceId === workspaceId && item.entityType === entityType && item.isDefault && item.isActive,
    );
    if (!pipeline) throw notFound('CRM_PIPELINE');
    return pipeline;
  }

  private activePipeline(workspaceId: string, pipelineId: string) {
    const pipeline = this.store.state.crmPipelines.find((item) => item.id === pipelineId && item.workspaceId === workspaceId && item.isActive);
    if (!pipeline) throw notFound('CRM_PIPELINE');
    return pipeline;
  }

  private activeStage(workspaceId: string, stageId: string) {
    const stage = this.store.state.crmStages.find((item) => item.id === stageId && item.workspaceId === workspaceId && item.isActive);
    if (!stage) throw notFound('CRM_STAGE');
    return stage;
  }

  private defaultStage(pipelineId: string) {
    const stage = this.store.state.crmStages.find((item) => item.pipelineId === pipelineId && item.isDefault && item.isActive);
    if (!stage) throw notFound('CRM_STAGE');
    return stage;
  }

  private clearDefaultPipeline(workspaceId: string, entityType: CrmPipelineEntityType) {
    for (const pipeline of this.store.state.crmPipelines) {
      if (pipeline.workspaceId === workspaceId && pipeline.entityType === entityType && pipeline.isDefault) {
        pipeline.isDefault = false;
        pipeline.version += 1;
      }
    }
  }

  private clearDefaultStage(pipelineId: string, exceptStageId?: string) {
    for (const stage of this.store.state.crmStages) {
      if (stage.pipelineId === pipelineId && stage.id !== exceptStageId && stage.isDefault) {
        stage.isDefault = false;
        stage.version += 1;
      }
    }
  }

  private appendStageHistory(
    workspaceId: string,
    entityType: CrmPipelineEntityType,
    recordId: string,
    fromPipelineId: string | null,
    fromStageId: string | null,
    toPipelineId: string,
    toStageId: string,
    actorUserId: string,
  ) {
    this.store.state.crmStageHistory.push({
      id: this.store.id(),
      workspaceId,
      entityType,
      recordId,
      fromPipelineId,
      fromStageId,
      toPipelineId,
      toStageId,
      movedByUserId: actorUserId,
      movedAt: now(),
      correlationId: null,
    });
  }

  private emitStageChanged(
    workspaceId: string,
    entityType: CrmPipelineEntityType,
    recordId: string,
    actorUserId: string,
    before: { pipelineId: string | null; stageId: string | null; version: number },
    after: { pipelineId: string; stageId: string; version: number },
  ) {
    new AuditService(this.store).write({
      workspaceId,
      actorUserId,
      action: `CRM.${entityType}.STAGE_CHANGED`,
      entityType: `Crm${entityType === 'LEAD' ? 'Lead' : 'Deal'}`,
      entityId: recordId,
      beforeData: before,
      afterData: after,
    });
    this.store.state.outboxEvents.push({
      id: this.store.id(),
      workspaceId,
      eventType: `CRM.${entityType}.STAGE_CHANGED`,
      entityType,
      entityId: recordId,
      actorUserId,
      occurredAt: now(),
      payload: {
        fromPipelineId: before.pipelineId,
        fromStageId: before.stageId,
        toPipelineId: after.pipelineId,
        toStageId: after.stageId,
        entityVersion: after.version,
      },
    });
  }

  private findIdempotentReplay(
    workspaceId: string,
    actorUserId: string,
    operation: string,
    input: unknown,
    idempotencyKey?: string,
  ) {
    if (!idempotencyKey) return null;
    const requestHash = JSON.stringify(input);
    const existing = this.store.state.idempotencyRecords.find(
      (item) =>
        item.workspaceId === workspaceId &&
        item.actorUserId === actorUserId &&
        item.operation === operation &&
        item.idempotencyKey === idempotencyKey &&
        item.expiresAt > now(),
    );
    if (!existing) return null;
    if (existing.requestHash !== requestHash) {
      throw conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different payload.');
    }
    return existing.response;
  }

  private storeIdempotentResponse(
    workspaceId: string,
    actorUserId: string,
    operation: string,
    input: unknown,
    idempotencyKey: string | undefined,
    response: Record<string, unknown>,
  ) {
    if (!idempotencyKey) return;
    this.store.state.idempotencyRecords.push({
      id: this.store.id(),
      workspaceId,
      actorUserId,
      operation,
      idempotencyKey,
      requestHash: JSON.stringify(input),
      response,
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      createdAt: now(),
    });
  }

  private currentRecordsForStage(workspaceId: string, entityType: CrmPipelineEntityType, stageId: string) {
    return entityType === 'LEAD'
      ? this.store.state.crmLeads.filter((record) => record.workspaceId === workspaceId && record.stageId === stageId && !record.isDeleted)
      : this.store.state.crmDeals.filter((record) => record.workspaceId === workspaceId && record.stageId === stageId && !record.isDeleted);
  }

  private currentRecordsForPipeline(workspaceId: string, entityType: CrmPipelineEntityType, pipelineId: string) {
    return entityType === 'LEAD'
      ? this.store.state.crmLeads.filter((record) => record.workspaceId === workspaceId && record.pipelineId === pipelineId && !record.isDeleted)
      : this.store.state.crmDeals.filter((record) => record.workspaceId === workspaceId && record.pipelineId === pipelineId && !record.isDeleted);
  }

  private planLegacyRecordBackfill(
    workspaceId: string,
    entityType: CrmPipelineEntityType,
    pipeline: CrmPipeline,
    statusToStageName: Record<string, string>,
  ) {
    const defaultStage = this.defaultStage(pipeline.id);
    const records = entityType === 'LEAD'
      ? this.store.state.crmLeads.filter((record) => record.workspaceId === workspaceId && !record.isDeleted)
      : this.store.state.crmDeals.filter((record) => record.workspaceId === workspaceId && !record.isDeleted);
    return records.flatMap((record) => {
      if (this.hasValidPipelineStage(workspaceId, entityType, record)) return [];
      const legacyStatus = this.legacyStatus(record);
      const stage = legacyStatus
        ? this.resolveLegacyStage(pipeline.id, legacyStatus, statusToStageName)
        : defaultStage;
      return [{ entityType, record, pipeline, stage }];
    });
  }

  private hasValidPipelineStage(workspaceId: string, entityType: CrmPipelineEntityType, record: CrmLead | CrmDeal) {
    if (!record.pipelineId || !record.stageId) return false;
    const pipeline = this.store.state.crmPipelines.find(
      (item) => item.id === record.pipelineId && item.workspaceId === workspaceId && item.entityType === entityType && item.isActive,
    );
    const stage = this.store.state.crmStages.find(
      (item) => item.id === record.stageId && item.workspaceId === workspaceId && item.pipelineId === pipeline?.id && item.isActive,
    );
    return Boolean(pipeline && stage);
  }

  private legacyStatus(record: CrmLead | CrmDeal) {
    const value = (record as unknown as { legacyStatus?: unknown; legacyStage?: unknown }).legacyStatus
      ?? (record as unknown as { legacyStage?: unknown }).legacyStage;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private resolveLegacyStage(pipelineId: string, legacyStatus: string, statusToStageName: Record<string, string>) {
    const mappedStageName = statusToStageName[legacyStatus];
    if (!mappedStageName) {
      throw conflict('CRM_LEGACY_STAGE_MAPPING_REQUIRED', 'Unknown legacy stage or status requires an explicit mapping.', { legacyStatus });
    }
    const stage = this.store.state.crmStages.find(
      (item) => item.pipelineId === pipelineId && item.isActive && normalizeName(item.name) === normalizeName(mappedStageName),
    );
    if (!stage) throw badRequest('CRM_LEGACY_STAGE_MAPPING_INVALID', 'Legacy stage mapping points to a missing target stage.');
    return stage;
  }

  private validateWorkspacePipelineConfiguration(workspaceId: string) {
    const leadPipeline = this.defaultActivePipeline(workspaceId, 'LEAD');
    const dealPipeline = this.defaultActivePipeline(workspaceId, 'DEAL');
    this.validatePipelineCanBecomeActive(workspaceId, leadPipeline, this.store.state.crmStages.filter((stage) => stage.pipelineId === leadPipeline.id));
    this.validatePipelineCanBecomeActive(workspaceId, dealPipeline, this.store.state.crmStages.filter((stage) => stage.pipelineId === dealPipeline.id));
    for (const entityType of ['LEAD', 'DEAL'] as const) {
      const defaults = this.store.state.crmPipelines.filter(
        (pipeline) => pipeline.workspaceId === workspaceId && pipeline.entityType === entityType && pipeline.isActive && pipeline.isDefault,
      );
      if (defaults.length !== 1) throw conflict('CRM_DEFAULT_PIPELINE_INVALID', 'Workspace must have exactly one active default pipeline per entity type.');
    }
  }

  private validatePipelineMigrationMapping(
    workspaceId: string,
    sourcePipeline: CrmPipeline,
    targetPipeline: CrmPipeline,
    currentRecords: Array<CrmLead | CrmDeal>,
    stageMappings: Array<{ fromStageId: string; toStageId: string }>,
  ) {
    const mapping = new Map<string, CrmStage>();
    const sourceStageIdsWithCurrentRecords = new Set(currentRecords.map((record) => record.stageId));
    for (const sourceStageId of sourceStageIdsWithCurrentRecords) {
      const sourceStage = this.store.state.crmStages.find(
        (stage) => stage.id === sourceStageId && stage.workspaceId === workspaceId && stage.pipelineId === sourcePipeline.id,
      );
      if (!sourceStage) throw notFound('CRM_STAGE');
      const matchingMappings = stageMappings.filter((item) => item.fromStageId === sourceStageId);
      if (matchingMappings.length !== 1) {
        throw conflict('CRM_PIPELINE_MIGRATION_INCOMPLETE', 'Pipeline migration mapping must include exactly one target for every current source stage.');
      }
      const targetStage = this.activeStage(workspaceId, matchingMappings[0].toStageId);
      if (targetStage.pipelineId !== targetPipeline.id) {
        throw badRequest('CRM_STAGE_WRONG_PIPELINE', 'Mapped target stage must belong to the target pipeline.');
      }
      mapping.set(sourceStageId, targetStage);
    }

    for (const item of stageMappings) {
      const sourceStage = this.store.state.crmStages.find(
        (stage) => stage.id === item.fromStageId && stage.workspaceId === workspaceId && stage.pipelineId === sourcePipeline.id,
      );
      if (!sourceStage) throw notFound('CRM_STAGE');
      const targetStage = this.activeStage(workspaceId, item.toStageId);
      if (targetStage.pipelineId !== targetPipeline.id) {
        throw badRequest('CRM_STAGE_WRONG_PIPELINE', 'Mapped target stage must belong to the target pipeline.');
      }
    }

    return mapping;
  }

  private applyStatusFromStage(entityType: CrmPipelineEntityType, record: CrmLead | CrmDeal, stage: CrmStage) {
    record.lostReasonId = null;
    record.lostReasonComment = null;
    if (entityType === 'LEAD') {
      (record as CrmLead).status = this.leadStatus(stage.semanticType);
    } else {
      (record as CrmDeal).status = this.dealStatus(stage.semanticType);
    }
  }

  private addLeadCommunication(workspaceId: string, leadId: string, input: CommunicationInput) {
    const normalizedValue = normalizeCommunication(input.type, input.value);
    if (!normalizedValue) throw badRequest('CRM_COMMUNICATION_INVALID', 'Communication value is required.');
    const existingForType = this.store.state.crmLeadCommunications.filter(
      (item) => item.workspaceId === workspaceId && item.leadId === leadId && item.type === input.type,
    );
    const isPrimary = input.isPrimary ?? existingForType.length === 0;
    if (isPrimary) {
      for (const communication of this.store.state.crmLeadCommunications) {
        if (communication.leadId === leadId && communication.type === input.type) communication.isPrimary = false;
      }
    }
    const communication: CrmLeadCommunication = {
      id: this.store.id(),
      workspaceId,
      leadId,
      type: input.type,
      value: input.value.trim(),
      normalizedValue,
      label: input.label ?? null,
      isPrimary,
      createdAt: now(),
      updatedAt: now(),
    };
    this.store.state.crmLeadCommunications.push(communication);
    return communication;
  }

  private assertLeadCustomerLinks(workspaceId: string, companyId: string | null, contactIds: string[]) {
    if (companyId) {
      const company = this.store.state.crmCompanies.find((item) => item.id === companyId && item.workspaceId === workspaceId && !item.isDeleted);
      if (!company) throw notFound('CRM_COMPANY');
    }
    for (const contactId of contactIds) {
      const contact = this.store.state.crmContacts.find((item) => item.id === contactId && item.workspaceId === workspaceId && !item.isDeleted);
      if (!contact) throw notFound('CRM_CONTACT');
    }
  }

  private assertActiveWorkspaceMember(workspaceId: string, userId: string) {
    const membership = this.store.state.workspaceMemberships.find(
      (item) => item.workspaceId === workspaceId && item.userId === userId && item.status === 'ACTIVE' && !item.isDeleted,
    );
    if (!membership) throw notFound('Workspace member');
  }

  private assertActiveSource(workspaceId: string, sourceId: string | null) {
    if (!sourceId) return;
    const source = this.store.state.crmSources.find((item) => item.id === sourceId && item.workspaceId === workspaceId && item.isActive);
    if (!source) throw notFound('CRM_SOURCE');
  }

  private assertNoDuplicateLeadCommunications(workspaceId: string, communications: CommunicationInput[], forceCreate: boolean) {
    if (forceCreate) return;
    const duplicates = communications
      .map((communication) => ({
        ...communication,
        normalizedValue: normalizeCommunication(communication.type, communication.value),
      }))
      .filter((communication) => communication.type === 'EMAIL' || communication.type === 'PHONE')
      .flatMap((communication) => {
        const leadMatches = this.store.state.crmLeadCommunications
          .filter(
            (existing) =>
              existing.workspaceId === workspaceId &&
              existing.type === communication.type &&
              existing.normalizedValue === communication.normalizedValue,
          )
          .map((existing) => ({ leadId: existing.leadId, type: existing.type, value: existing.value }));
        const contactMatches = this.store.state.crmContactCommunications
          .filter(
            (existing) =>
              existing.workspaceId === workspaceId &&
              existing.type === communication.type &&
              existing.normalizedValue === communication.normalizedValue,
          )
          .map((existing) => ({ contactId: existing.contactId, type: existing.type, value: existing.value }));
        return [...leadMatches, ...contactMatches];
      });
    if (duplicates.length > 0) throw conflict('CRM_DUPLICATE_DETECTED', 'Potential duplicate lead detected.', { matches: duplicates });
  }

  private assertPipelineManager(userId: string, workspaceId: string) {
    const { role } = this.assertMembership(userId, workspaceId);
    if (!role.isOwnerRole && !this.roleHasPermission(role.id, 'crm.pipeline.manage')) {
      throw forbidden('CRM pipeline management permission is required.');
    }
  }

  private assertMembership(userId: string, workspaceId: string) {
    const workspace = this.store.state.workspaces.find((item) => item.id === workspaceId && !item.isDeleted);
    if (!workspace) throw notFound('Workspace');
    const membership = this.store.state.workspaceMemberships.find(
      (item) => item.userId === userId && item.workspaceId === workspaceId && item.status === 'ACTIVE' && !item.isDeleted,
    );
    if (!membership) throw forbidden('Workspace membership is required.');
    const role = this.store.state.roles.find((item) => item.id === membership.roleId && !item.isDeleted);
    if (!role) throw forbidden('Workspace role is required.');
    return { workspace, membership, role };
  }

  private roleHasPermission(roleId: string, permissionKey: string) {
    return this.store.state.rolePermissions.some((rolePermission) => {
      const permission = this.store.state.permissions.find((item) => item.id === rolePermission.permissionId);
      return rolePermission.roleId === roleId && !rolePermission.isDeleted && permission?.key === permissionKey;
    });
  }

  private assertRecordPermission(userId: string, workspaceId: string, permissionKey: string, record: CrmLead | CrmDeal) {
    const scope = this.permissionScope(userId, workspaceId, permissionKey);
    if (scope === 'WORKSPACE') return;
    if (scope === 'OWN' && record.responsibleUserId === userId) return;
    throw forbidden();
  }

  private permissionScope(userId: string, workspaceId: string, permissionKey: string): PermissionScope {
    const { role } = this.assertMembership(userId, workspaceId);
    if (role.isOwnerRole) return 'WORKSPACE';
    const rolePermission = this.store.state.rolePermissions.find((item) => {
      const permission = this.store.state.permissions.find((candidate) => candidate.id === item.permissionId);
      return item.roleId === role.id && !item.isDeleted && permission?.key === permissionKey;
    });
    if (!rolePermission) throw forbidden();
    return rolePermission.scope;
  }

  private assertStageAccess(userId: string, workspaceId: string, stageId: string, action: 'view' | 'enter' | 'leave') {
    const { role } = this.assertMembership(userId, workspaceId);
    if (role.isOwnerRole) return;
    const policy = this.store.state.crmRoleStagePermissions.find(
      (item) => item.workspaceId === workspaceId && item.roleId === role.id && item.stageId === stageId,
    );
    if (!policy) return;
    const allowed = action === 'view' ? policy.canView : action === 'enter' ? policy.canEnter : policy.canLeave;
    if (!allowed) throw forbidden(`CRM stage ${action} permission is required.`);
  }

  private leadStatus(semanticType: CrmStageSemanticType) {
    if (semanticType === 'SUCCESS') return 'QUALIFIED';
    if (semanticType === 'FAILURE') return 'DISQUALIFIED';
    return 'ACTIVE';
  }

  private dealStatus(semanticType: CrmStageSemanticType) {
    if (semanticType === 'SUCCESS') return 'WON';
    if (semanticType === 'FAILURE') return 'LOST';
    return 'OPEN';
  }
}
