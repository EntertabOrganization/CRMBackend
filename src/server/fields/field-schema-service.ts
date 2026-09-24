import type { User } from '../domain';
import { AppError } from '../errors';
import type { CustomValueService } from './custom-value-service';
import type { FieldPermissionService } from './field-permission';
import { fieldTypeRegistry } from './field-types';
import type { FieldRequirementService } from './requirement-service';
import type { FieldSupport } from './support';
import type { CustomField } from './types';

export type SchemaSurface = 'create' | 'edit' | 'detail' | 'list';

const SURFACE_FLAG: Record<SchemaSurface, keyof CustomField> = {
  create: 'showOnCreate',
  edit: 'showOnEdit',
  detail: 'showOnDetail',
  list: 'availableAsListColumn',
};

/**
 * Authorized schema for normal clients: only active, relevant, viewable fields, with editability resolved for the
 * record context. Hidden fields (and their options/metadata) never appear.
 */
export class FieldSchemaService {
  constructor(
    private readonly support: FieldSupport,
    private readonly permissions: FieldPermissionService,
    private readonly values: CustomValueService,
    private readonly requirements: FieldRequirementService,
  ) {}

  getSchema(
    user: User,
    workspaceId: string,
    entityType: string,
    options: { surface?: string; entityId?: string | null; pipelineId?: string | null; stageId?: string | null; activityTypeId?: string | null } = {},
  ) {
    const access = this.support.deps.access;
    const actor = access.actor(user, workspaceId);
    const adapter = this.support.deps.registry.get(entityType);
    const surface = (options.surface ?? 'detail') as SchemaSurface;
    if (!(surface in SURFACE_FLAG)) throw new AppError('SCHEMA_SURFACE_INVALID', 'surface must be create, edit, detail or list.', 400);

    let record: unknown;
    let canUpdate = true;
    if (options.entityId) {
      record = adapter.findRecord(workspaceId, options.entityId);
      // Inaccessible and missing records are indistinguishable.
      if (!record || !adapter.canRead(actor, options.entityId)) throw new AppError('RESOURCE_NOT_FOUND_OR_FORBIDDEN', 'Record was not found.', 404);
      canUpdate = adapter.canUpdate(actor, options.entityId);
    } else if (surface === 'create' && !adapter.canCreate(actor)) {
      throw new AppError('PERMISSION_DENIED', 'Permission denied.', 403);
    }

    let activityTypeId = options.activityTypeId ?? null;
    if (entityType === 'ACTIVITY' && record) activityTypeId = (record as { customActivityTypeId?: string | null }).customActivityTypeId ?? null;

    const systemState = record ? adapter.systemValues(record) : {};
    const pipelineId = options.pipelineId ?? (record as { pipelineId?: string } | undefined)?.pipelineId ?? this.defaultPipeline(workspaceId, entityType);
    const stageId = options.stageId ?? (record as { stageId?: string } | undefined)?.stageId ?? null;

    const snapshot = this.values.prepare({ actor, entityType, entityId: options.entityId ?? null, isCreate: false, supplied: undefined, activityTypeId });
    const required = this.requirements.requiredTargets({ workspaceId, entityType, systemState, prepared: snapshot, pipelineId, stageId });

    const fields = snapshot.fields
      .filter(({ field }) => Boolean(field[SURFACE_FLAG[surface]]))
      .filter(({ access: effective }) => effective !== 'HIDDEN')
      .map(({ field, access: effective }) => {
        const handler = fieldTypeRegistry.get(field.fieldType);
        const held = snapshot.effective.get(field.id) ?? [];
        const optionRows = handler.usesOptions
          ? this.support
              .optionsOf(field.id)
              .filter((option) => option.isActive || held.includes(option.id))
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map((option) => ({ id: option.id, code: option.code, label: option.label, isActive: option.isActive }))
          : undefined;
        const readOnly = surface === 'detail' || surface === 'list' || effective !== 'EDIT' || !canUpdate;
        return {
          id: field.id,
          code: field.code,
          label: field.label,
          helpText: field.helpText ?? null,
          type: field.fieldType,
          multiple: field.isMultiple,
          required: required.has(`custom:${field.id}`),
          readOnly,
          sortOrder: field.sortOrder,
          defaultValue: surface === 'create' ? field.staticDefaultValue ?? null : undefined,
          validation: field.validationConfig ?? {},
          referenceConfig: field.referenceConfig ?? undefined,
          options: optionRows,
          showOnCreate: field.showOnCreate,
          showOnEdit: field.showOnEdit,
          showOnDetail: field.showOnDetail,
          availableAsListColumn: field.availableAsListColumn,
          searchable: field.searchable,
          filterable: field.filterable,
          sortable: field.sortable,
        };
      });

    const systemFields = adapter
      .systemFields()
      .filter((descriptor) => descriptor.requirementCapable)
      .map((descriptor) => ({ key: descriptor.key, label: descriptor.label, dataType: descriptor.dataType, required: required.has(`system:${descriptor.key}`) }));

    return {
      entityType,
      surface,
      schemaVersion: this.support.schemaVersion(workspaceId, entityType),
      pipelineId: pipelineId ?? null,
      stageId,
      fields,
      systemFields,
    };
  }

  private defaultPipeline(workspaceId: string, entityType: string) {
    return this.support.store.state.crmPipelines.find((pipeline) => pipeline.workspaceId === workspaceId && pipeline.entityType === entityType && pipeline.isDefault && pipeline.isActive)?.id ?? null;
  }
}
