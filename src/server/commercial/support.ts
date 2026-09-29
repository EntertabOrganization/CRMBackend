import { createHash } from 'crypto';
import type { ActorContext } from '../access-service';
import { AuditService } from '../audit-service';
import { emitDomainEvent } from '../events';
import { AppError, badRequest, forbidden } from '../errors';
import type { InMemoryStore } from '../store';

export function stableHash(value: unknown) {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, normalize(x)])) : v;
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

export class CommercialSupport {
  readonly auditService: AuditService;
  constructor(readonly store: InMemoryStore, private readonly access: {
    requireScope(actor: ActorContext, key: string): unknown;
    scopeCoversUser?(scope: 'OWN'|'DEPARTMENT'|'DEPARTMENT_TREE'|'WORKSPACE', actorUserId: string, targetUserId: string|null|undefined, workspaceId: string): boolean;
  }) {
    this.auditService = new AuditService(store);
  }
  require(actor: ActorContext, permission: string) { return this.access.requireScope(actor, permission); }
  requireRecord(actor: ActorContext, permission: string, responsibleUserId: string|null|undefined) {
    const scope = this.access.requireScope(actor, permission) as 'OWN'|'DEPARTMENT'|'DEPARTMENT_TREE'|'WORKSPACE';
    if (this.access.scopeCoversUser && !this.access.scopeCoversUser(scope, actor.user.id, responsibleUserId, actor.workspaceId)) {
      throw forbidden(`${permission} scope does not cover this record.`);
    }
    return scope;
  }
  canReadRecord(actor: ActorContext, permission: string, responsibleUserId: string|null|undefined) {
    const scope = this.access.requireScope(actor, permission) as 'OWN'|'DEPARTMENT'|'DEPARTMENT_TREE'|'WORKSPACE';
    return !this.access.scopeCoversUser || this.access.scopeCoversUser(scope, actor.user.id, responsibleUserId, actor.workspaceId);
  }
  assertWorkspace(actor: ActorContext, workspaceId: string) {
    if (actor.workspaceId !== workspaceId) throw new AppError('CROSS_WORKSPACE_REFERENCE', 'Cross-workspace reference is not allowed.', 404);
  }
  audit(actor: ActorContext, action: string, entityType: string, entityId: string, beforeData?: unknown, afterData?: unknown, metadata?: unknown) {
    return this.auditService.write({ workspaceId: actor.workspaceId, actorUserId: actor.user.id, action, entityType, entityId, beforeData, afterData, metadata });
  }
  event(actor: ActorContext, eventType: string, entityType: string, entityId: string, changes: Record<string, unknown> = {}, idempotencyKey?: string) {
    return emitDomainEvent(this.store, { workspaceId: actor.workspaceId, actorUserId: actor.user.id, eventType, entityType, entityId, changes, idempotencyKey });
  }
  serviceEvent(workspaceId: string, eventType: string, entityType: string, entityId: string, changes: Record<string, unknown> = {}, idempotencyKey?: string) {
    return emitDomainEvent(this.store, { workspaceId, eventType, entityType, entityId, changes, idempotencyKey });
  }
  text(value: unknown, field: string, max = 300) {
    if (typeof value !== 'string' || !value.trim()) throw badRequest('VALIDATION_ERROR', `${field} is required.`, { field });
    return value.trim().slice(0, max);
  }
  deny(message: string): never { throw forbidden(message); }
}
