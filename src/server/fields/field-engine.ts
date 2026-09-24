import type { ActorContext, AccessService } from '../access-service';
import { AppError, fieldValidationFailed } from '../errors';
import type { RealtimeHub } from '../realtime';
import type { FilePort } from '../ports';
import type { InMemoryStore } from '../store';
import { CustomFieldDefinitionService } from './custom-field-service';
import type { PreparedCustomValues, WriteOrigin } from './custom-value-service';
import { CustomValueService } from './custom-value-service';
import type { FieldEntityRegistry } from './entity-registry';
import { FieldMigrationService } from './field-migration-service';
import { FieldPermissionService } from './field-permission';
import { FieldSchemaService } from './field-schema-service';
import { FieldRequirementService } from './requirement-service';
import { FieldSupport } from './support';
import type { FieldViolations } from './types';

export type FieldWriteArgs = {
  actor: ActorContext;
  entityType: string;
  entityId: string | null;
  isCreate: boolean;
  /** The `customFields` object from the request (undefined when the caller sent none). */
  supplied: unknown;
  /** Post-write system values of the owning record (existing + incoming changes). */
  systemState: Record<string, unknown>;
  pipelineId?: string | null;
  stageId?: string | null;
  origin?: WriteOrigin;
  activityTypeId?: string | null;
  /**
   * Controlled internal repair/migration only. Never reachable from public endpoints: it needs a service identity and a
   * mandatory reason, skips requirement rules (never type validation) and is always audited.
   */
  repair?: { serviceIdentity: string; reason: string };
};

/**
 * Facade the owning entity services (Leads, Contacts, Companies, Deals, Activities, and future Forms/Import/Automation
 * adapters) call. Every normal write path goes through validateWrite(), so nothing can bypass required-field rules by
 * calling a lower layer.
 */
export class FieldEngine {
  readonly support: FieldSupport;
  readonly permissions: FieldPermissionService;
  readonly definitions: CustomFieldDefinitionService;
  readonly values: CustomValueService;
  readonly requirements: FieldRequirementService;
  readonly schema: FieldSchemaService;
  readonly migrations: FieldMigrationService;
  private filePort: FilePort;

  constructor(deps: { store: InMemoryStore; access: AccessService; registry: FieldEntityRegistry; realtime: RealtimeHub; files: FilePort }) {
    this.filePort = deps.files;
    this.support = new FieldSupport({ store: deps.store, access: deps.access, registry: deps.registry, realtime: deps.realtime });
    this.permissions = new FieldPermissionService(deps.store);
    this.definitions = new CustomFieldDefinitionService(this.support);
    this.values = new CustomValueService(this.support, this.permissions, () => this.filePort);
    this.requirements = new FieldRequirementService(this.support, this.values);
    this.schema = new FieldSchemaService(this.support, this.permissions, this.values, this.requirements);
    this.migrations = new FieldMigrationService(this.support, this.definitions);
  }

  setFilePort(port: FilePort) {
    this.filePort = port;
  }

  /** Validates custom values + requirement rules against the post-write state; throws every safe violation at once. */
  validateWrite(args: FieldWriteArgs): PreparedCustomValues {
    const prepared = this.values.prepare({
      actor: args.actor,
      entityType: args.entityType,
      entityId: args.entityId,
      isCreate: args.isCreate,
      supplied: args.supplied,
      origin: args.origin,
      activityTypeId: args.activityTypeId,
    });

    let requirementViolations: FieldViolations = {};
    if (args.repair) {
      if (!args.repair.reason?.trim() || !args.repair.serviceIdentity?.trim()) {
        throw new AppError('VALIDATION_BYPASS_FORBIDDEN', 'A controlled repair needs a service identity and a reason.', 403);
      }
      this.support.audit(args.actor.workspaceId, args.actor.user.id, 'CUSTOM_FIELD.VALIDATION_BYPASSED', args.entityType, args.entityId ?? 'new', null, null, {
        serviceIdentity: args.repair.serviceIdentity,
        reason: args.repair.reason,
      });
    } else {
      requirementViolations = this.requirements.check({
        actor: args.actor,
        prepared,
        systemState: args.systemState,
        pipelineId: args.pipelineId,
        stageId: args.stageId,
      });
    }

    const merged: FieldViolations = { ...prepared.violations };
    for (const [key, list] of Object.entries(requirementViolations)) {
      // A field that already failed type validation reports that error rather than a misleading "required".
      if (!merged[key]) merged[key] = list;
    }
    if (Object.keys(merged).length > 0) throw fieldValidationFailed(merged);
    return prepared;
  }

  commit(prepared: PreparedCustomValues, entityId: string) {
    this.values.commit(prepared, entityId);
  }

  /** Adds an authorized `customFields` object to each record (hidden/inactive/non-API fields are omitted). */
  decorate<T extends { id: string }>(actor: ActorContext, entityType: string, records: T[]): Array<T & { customFields: Record<string, unknown> }> {
    if (records.length === 0) return [];
    const activityTypeIds = new Map<string, string | null>();
    if (entityType === 'ACTIVITY') {
      for (const record of records) activityTypeIds.set(record.id, (record as unknown as { customActivityTypeId?: string | null }).customActivityTypeId ?? null);
    }
    const map = this.values.decorate(actor, entityType, records.map((record) => record.id), { activityTypeIds });
    return records.map((record) => ({ ...record, customFields: map.get(record.id) ?? {} }));
  }
}
