import type { ActorContext } from '../access-service';
import type { FilePort } from '../ports';
import type { FieldTypeContext, ReferenceCheck } from './field-types';
import { fieldTypeRegistry } from './field-types';
import type { FieldPermissionService } from './field-permission';
import type { FieldSupport } from './support';
import type { CrmReferenceValue, CustomField, CustomFieldValueRow, FieldEffectiveAccess, FieldViolations } from './types';

export type WriteOrigin = 'API' | 'FORM' | 'IMPORT' | 'AUTOMATION';

export type PreparedCustomValues = {
  workspaceId: string;
  entityType: string;
  entityId: string | null;
  /** Fields the caller supplied (or create-time defaults) that must be rewritten on commit. */
  changes: Map<string, { field: CustomField; items: unknown[] }>;
  /** Post-write logical value set for every applicable active field: existing + incoming + defaults. */
  effective: Map<string, unknown[]>;
  /** Active, origin-exposed fields applicable to this write, with the actor's effective access. */
  fields: Array<{ field: CustomField; access: FieldEffectiveAccess }>;
  /** Every active field applicable to the entity (used to evaluate requirement conditions). */
  activeFields: CustomField[];
  violations: FieldViolations;
};

const rowKey = (entityId: string, fieldId: string) => entityId + '|' + fieldId;

const UNIQUE_ITEM_TYPES = new Set(['LIST', 'MULTI_LIST', 'USER_REFERENCE', 'CRM_REFERENCE', 'FILE']);

export function isEmptyFieldValue(field: CustomField, items: unknown[] | undefined) {
  if (!items || items.length === 0) return true;
  const handler = fieldTypeRegistry.get(field.fieldType);
  return items.every((item) => handler.isEmptyItem(item));
}

/**
 * Typed custom-field value engine: validates and normalizes supplied values, applies create-only defaults, enforces
 * field-level access, and reads/writes the generic typed value rows. Owning entity services call prepare() before
 * mutating anything and commit() inside the same atomic operation as their own record write.
 */
export class CustomValueService {
  constructor(
    private readonly support: FieldSupport,
    private readonly permissions: FieldPermissionService,
    private readonly files: () => FilePort,
  ) {}

  private get store() {
    return this.support.store;
  }

  /** Fields that apply to a write from the given origin. Inactive and non-exposed fields never take part. */
  applicableFields(workspaceId: string, entityType: string, origin: WriteOrigin, activityTypeId?: string | null) {
    return this.support
      .fieldsFor(workspaceId, entityType)
      .filter((field) => field.isActive)
      .filter((field) => this.exposedTo(field, origin))
      .filter((field) => !field.activityTypeId || field.activityTypeId === (activityTypeId ?? null))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  private exposedTo(field: CustomField, origin: WriteOrigin) {
    if (origin === 'FORM') return field.availableInForms;
    if (origin === 'IMPORT') return field.availableInImport;
    return field.availableInApi;
  }

  prepare(args: {
    actor: ActorContext;
    entityType: string;
    entityId: string | null;
    isCreate: boolean;
    supplied: unknown;
    origin?: WriteOrigin;
    activityTypeId?: string | null;
  }): PreparedCustomValues {
    const { actor, entityType, entityId, isCreate } = args;
    const origin = args.origin ?? 'API';
    const workspaceId = actor.workspaceId;
    const adapter = this.support.deps.registry.get(entityType);
    const violations: FieldViolations = {};
    const addViolation = (key: string, code: string, message: string) => (violations[key] ??= []).push({ code, message });

    const recordAccess = {
      canRead: true,
      canUpdate: isCreate || !entityId ? true : adapter.canUpdate(actor, entityId),
    };
    const fields = this.applicableFields(workspaceId, entityType, origin, args.activityTypeId).map((field) => ({
      field,
      access: this.permissions.effectiveAccess(actor, field, recordAccess),
    }));

    let supplied: Record<string, unknown> = {};
    if (args.supplied !== undefined && args.supplied !== null) {
      if (typeof args.supplied !== 'object' || Array.isArray(args.supplied)) {
        addViolation('customFields', 'INVALID_TYPE', 'customFields must be an object keyed by field code.');
      } else {
        supplied = args.supplied as Record<string, unknown>;
      }
    }

    // Requirement conditions and required targets look at every active field, whatever surface exposes it.
    const allActive = this.support
      .fieldsFor(workspaceId, entityType)
      .filter((field) => field.isActive && (!field.activityTypeId || field.activityTypeId === (args.activityTypeId ?? null)));
    const existing = new Map<string, unknown[]>();
    if (entityId) {
      const index = this.rowsByField(workspaceId, entityType, [entityId]);
      for (const field of allActive) existing.set(field.id, this.itemsFromRows(field, index.get(rowKey(entityId, field.id)) ?? []));
    }

    const changes = new Map<string, { field: CustomField; items: unknown[] }>();
    const knownCodes = new Map(fields.map((entry) => [entry.field.code, entry]));
    const allByCode = new Map(this.support.fieldsFor(workspaceId, entityType).map((field) => [field.code, field]));

    for (const [code, raw] of Object.entries(supplied)) {
      const entry = knownCodes.get(code);
      if (!entry || entry.access === 'HIDDEN') {
        const inactive = allByCode.get(code);
        // Hidden and unknown fields answer identically so field existence is never disclosed.
        if (inactive && !inactive.isActive && this.permissions.fieldAccess(actor, inactive) !== 'HIDDEN' && this.exposedTo(inactive, origin)) {
          addViolation(code, 'CUSTOM_FIELD_INACTIVE', 'This field is no longer active.');
        } else {
          addViolation(code, 'UNKNOWN_FIELD', 'Unknown field.');
        }
        continue;
      }
      if (entry.access === 'READ_ONLY') {
        addViolation(code, 'FIELD_EDIT_FORBIDDEN', 'You are not allowed to change this field.');
        continue;
      }
      const parsed = this.parseSupplied(actor, entry.field, raw, existing.get(entry.field.id) ?? []);
      if (parsed.ok) changes.set(entry.field.id, { field: entry.field, items: parsed.items });
      else for (const violation of parsed.violations) addViolation(code, violation.code, violation.message);
    }

    // Create-only defaults: only when the caller did not supply the key at all (explicit null is validated as supplied).
    if (isCreate) {
      for (const { field } of fields) {
        if (Object.prototype.hasOwnProperty.call(supplied, field.code)) continue;
        if (field.staticDefaultValue === null || field.staticDefaultValue === undefined) continue;
        const items = field.isMultiple ? (field.staticDefaultValue as unknown[]) : [field.staticDefaultValue];
        changes.set(field.id, { field, items });
      }
    }

    const effective = new Map<string, unknown[]>();
    for (const field of allActive) effective.set(field.id, changes.get(field.id)?.items ?? existing.get(field.id) ?? []);

    return { workspaceId, entityType, entityId, changes, effective, fields, activeFields: allActive, violations };
  }

  private parseSupplied(actor: ActorContext, field: CustomField, raw: unknown, existingItems: unknown[]): { ok: true; items: unknown[] } | { ok: false; violations: { code: string; message: string }[] } {
    const handler = fieldTypeRegistry.get(field.fieldType);
    if (raw === null) return { ok: true, items: [] };
    let rawItems: unknown[];
    if (field.isMultiple) {
      if (!Array.isArray(raw)) return { ok: false, violations: [{ code: 'INVALID_TYPE', message: 'An array of values is required.' }] };
      rawItems = raw;
    } else {
      if (Array.isArray(raw)) return { ok: false, violations: [{ code: 'INVALID_TYPE', message: 'A single value is required.' }] };
      rawItems = [raw];
    }
    const maxItems = typeof field.validationConfig?.maxItems === 'number' ? field.validationConfig.maxItems : 100;
    if (rawItems.length > maxItems) return { ok: false, violations: [{ code: 'MAX_ITEMS', message: `At most ${maxItems} values are allowed.` }] };

    const ctx = this.context(actor, field, existingItems);
    const items: unknown[] = [];
    const violations: { code: string; message: string }[] = [];
    for (const item of rawItems) {
      const result = handler.parseItem(item, field, ctx);
      if (result.ok) items.push(result.value);
      else violations.push(...result.violations);
    }
    if (violations.length > 0) return { ok: false, violations };
    if (UNIQUE_ITEM_TYPES.has(field.fieldType)) {
      const seen = new Set(items.map((item) => JSON.stringify(item)));
      if (seen.size !== items.length) return { ok: false, violations: [{ code: 'DUPLICATE_VALUE', message: 'Duplicate values are not allowed.' }] };
    }
    return { ok: true, items };
  }

  private context(actor: ActorContext, field: CustomField, existingItems: unknown[]): FieldTypeContext {
    const registry = this.support.deps.registry;
    const access = this.support.deps.access;
    return {
      options: this.support.optionsOf(field.id),
      existingItems,
      checkUser: (userId): ReferenceCheck => (this.store.state.users.some((user) => user.id === userId && !user.isDeleted) ? 'OK' : 'MISSING'),
      isUserSelectable: (userId) => access.isActiveMember(actor.workspaceId, userId),
      checkCrmReference: (entityType, entityId): ReferenceCheck => {
        if (!registry.has(entityType) || entityType === 'ACTIVITY') return 'MISSING';
        const adapter = registry.get(entityType);
        if (!adapter.findRecord(actor.workspaceId, entityId)) return 'MISSING';
        return adapter.canRead(actor, entityId) ? 'OK' : 'FORBIDDEN';
      },
      checkFile: (fileId): ReferenceCheck => this.files().check(actor.workspaceId, actor, fileId),
      registeredEntityTypes: registry.types(),
    };
  }

  /** Rewrites the value rows of every changed field. Call inside the owning entity's atomic operation. */
  commit(prepared: PreparedCustomValues, entityId: string) {
    const now = new Date();
    for (const { field, items } of prepared.changes.values()) {
      const handler = fieldTypeRegistry.get(field.fieldType);
      this.store.state.crmCustomFieldValues = this.store.state.crmCustomFieldValues.filter(
        (row) => !(row.fieldId === field.id && row.entityType === prepared.entityType && row.entityId === entityId),
      );
      items.forEach((item, ordinal) => {
        this.store.state.crmCustomFieldValues.push({
          id: this.store.id(),
          workspaceId: prepared.workspaceId,
          fieldId: field.id,
          entityType: prepared.entityType,
          entityId,
          ordinal,
          valueText: null,
          valueInteger: null,
          valueDecimal: null,
          valueBoolean: null,
          valueDate: null,
          valueDateTime: null,
          valueUuid: null,
          valueJson: null,
          ...handler.serializeItem(item),
          createdAt: now,
          updatedAt: now,
        });
      });
    }
  }

  loadItems(workspaceId: string, entityType: string, entityId: string, field: CustomField): unknown[] {
    return this.itemsFromRows(field, this.rowsByField(workspaceId, entityType, [entityId]).get(rowKey(entityId, field.id)) ?? []);
  }

  private itemsFromRows(field: CustomField, rows: CustomFieldValueRow[]): unknown[] {
    const handler = fieldTypeRegistry.get(field.fieldType);
    return [...rows]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((row) => handler.deserializeItem(row))
      .filter((item) => item !== null && item !== undefined);
  }

  /** One pass over the value rows for the requested entities (avoids a full scan per entity x field). */
  private rowsByField(workspaceId: string, entityType: string, entityIds: string[]) {
    const wanted = new Set(entityIds);
    const index = new Map<string, CustomFieldValueRow[]>();
    for (const row of this.store.state.crmCustomFieldValues) {
      if (row.workspaceId !== workspaceId || row.entityType !== entityType || !wanted.has(row.entityId)) continue;
      const key = rowKey(row.entityId, row.fieldId);
      const list = index.get(key);
      if (list) list.push(row);
      else index.set(key, [row]);
    }
    return index;
  }

  /** Public value shape for a field's items (single => value|null, multiple => array). */
  toApiValue(actor: ActorContext, field: CustomField, items: unknown[]) {
    const handler = fieldTypeRegistry.get(field.fieldType);
    const visible = items.filter((item) => this.isItemVisible(actor, field, item));
    const api = visible.map((item) => handler.toApi(item));
    return field.isMultiple ? api : (api[0] ?? null);
  }

  /** Reference values the caller cannot read are omitted rather than redacted so restricted records never leak. */
  private isItemVisible(actor: ActorContext, field: CustomField, item: unknown) {
    if (field.fieldType === 'CRM_REFERENCE') {
      const ref = item as CrmReferenceValue;
      const registry = this.support.deps.registry;
      return registry.has(ref.entityType) && registry.get(ref.entityType).canRead(actor, ref.entityId);
    }
    if (field.fieldType === 'FILE') return this.files().check(actor.workspaceId, actor, item as string) === 'OK';
    return true;
  }

  /** Authorized custom values for records: hidden, inactive and non-API-exposed fields are omitted entirely. */
  decorate(actor: ActorContext, entityType: string, entityIds: string[], options: { activityTypeIds?: Map<string, string | null> } = {}) {
    const result = new Map<string, Record<string, unknown>>();
    const visibleFields = this.applicableFields(actor.workspaceId, entityType, 'API').filter(
      (field) => this.permissions.fieldAccess(actor, field) !== 'HIDDEN',
    );
    const index = this.rowsByField(actor.workspaceId, entityType, entityIds);
    for (const entityId of entityIds) {
      const out: Record<string, unknown> = {};
      const activityTypeId = options.activityTypeIds?.get(entityId) ?? null;
      for (const field of visibleFields) {
        if (field.activityTypeId && field.activityTypeId !== activityTypeId) continue;
        out[field.code] = this.toApiValue(actor, field, this.itemsFromRows(field, index.get(rowKey(entityId, field.id)) ?? []));
      }
      result.set(entityId, out);
    }
    return result;
  }
}
