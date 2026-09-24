import { AuditService } from '../audit-service';
import type { AccessService } from '../access-service';
import { AppError, conflict, notFound } from '../errors';
import { emitDomainEvent } from '../events';
import type { RealtimeHub } from '../realtime';
import type { InMemoryStore } from '../store';
import type { FieldEntityRegistry } from './entity-registry';
import type { CustomField, FieldSchemaVersion } from './types';

export type FieldModuleDeps = {
  store: InMemoryStore;
  access: AccessService;
  registry: FieldEntityRegistry;
  realtime: RealtimeHub;
};

/** Shared plumbing for the field services: audit, schema versioning, outbox events and realtime hints. */
export class FieldSupport {
  constructor(readonly deps: FieldModuleDeps) {}

  get store() {
    return this.deps.store;
  }

  audit(workspaceId: string, actorUserId: string | null, action: string, entityType: string, entityId: string, before: unknown, after: unknown, metadata?: unknown) {
    new AuditService(this.store).write({
      workspaceId,
      actorUserId,
      action,
      entityType,
      entityId,
      beforeData: before,
      afterData: after,
      metadata,
    });
  }

  schemaVersion(workspaceId: string, entityType: string): number {
    return this.schemaRow(workspaceId, entityType)?.version ?? 1;
  }

  private schemaRow(workspaceId: string, entityType: string): FieldSchemaVersion | undefined {
    return this.store.state.crmFieldSchemaVersions.find((row) => row.workspaceId === workspaceId && row.entityType === entityType);
  }

  /** Bumps the workspace+entity schema version and tells consumers (realtime, search, forms, import) to refresh. */
  bumpSchema(workspaceId: string, entityType: string, actorUserId: string | null, changeKind: string, ref?: { fieldId?: string; ruleId?: string }) {
    let row = this.schemaRow(workspaceId, entityType);
    if (!row) {
      row = { id: this.store.id(), workspaceId, entityType, version: 1, updatedAt: new Date() };
      this.store.state.crmFieldSchemaVersions.push(row);
    }
    row.version += 1;
    row.updatedAt = new Date();
    const changes = { entityType, schemaVersion: row.version, changeKind, ...ref };
    emitDomainEvent(this.store, {
      workspaceId,
      eventType: ref?.ruleId ? 'FIELD_REQUIREMENT_CHANGED' : 'CUSTOM_FIELD_CHANGED',
      entityType: ref?.ruleId ? 'FIELD_REQUIREMENT' : 'CUSTOM_FIELD',
      entityId: (ref?.ruleId ?? ref?.fieldId ?? workspaceId) as string,
      actorUserId,
      changes,
    });
    emitDomainEvent(this.store, {
      workspaceId,
      eventType: 'FIELD_SCHEMA_CHANGED',
      entityType: 'CUSTOM_FIELD_SCHEMA',
      entityId: workspaceId,
      actorUserId,
      changes,
    });
    this.deps.realtime.enqueue({
      type: 'FIELD_SCHEMA_CHANGED',
      workspaceId,
      data: { entityType, schemaVersion: row.version },
    });
    return row.version;
  }

  field(workspaceId: string, fieldId: string): CustomField {
    const field = this.store.state.crmCustomFields.find((item) => item.id === fieldId && item.workspaceId === workspaceId);
    // Foreign-workspace ids are indistinguishable from missing ones.
    if (!field) throw new AppError('CUSTOM_FIELD_NOT_FOUND', 'Custom field was not found.', 404);
    return field;
  }

  fieldsFor(workspaceId: string, entityType: string) {
    return this.store.state.crmCustomFields.filter((item) => item.workspaceId === workspaceId && item.entityType === entityType);
  }

  optionsOf(fieldId: string) {
    return this.store.state.crmCustomFieldOptions.filter((item) => item.fieldId === fieldId);
  }

  valueCount(fieldId: string) {
    return this.store.state.crmCustomFieldValues.filter((row) => row.fieldId === fieldId).length;
  }

  assertVersion(current: number, provided: unknown, what = 'configuration') {
    if (typeof provided !== 'number' || !Number.isInteger(provided)) {
      throw new AppError('CONFIGURATION_VERSION_REQUIRED', `The current ${what} version is required.`, 400);
    }
    if (provided !== current) {
      throw conflict('CONFIGURATION_VERSION_CONFLICT', `The ${what} changed after you loaded it.`, { currentVersion: current });
    }
  }

  notFound(entity: string) {
    return notFound(entity);
  }
}
