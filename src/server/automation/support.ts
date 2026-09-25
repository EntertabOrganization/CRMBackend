import { createHash } from 'node:crypto';
import type { AccessService, ActorContext } from '../access-service';
import { AuditService } from '../audit-service';
import type { User } from '../domain';
import { AppError, badRequest, forbidden } from '../errors';
import { emitDomainEvent } from '../events';
import type { RealtimeHub } from '../realtime';
import type { InMemoryStore } from '../store';
import type { AutomationLog } from './types';
import { AUTOMATION_PERMISSIONS as P } from './types';

export type Json = Record<string, unknown>;

export const MAX_AUTOMATION_DEPTH = 5;
export const LEASE_MS = 5 * 60 * 1000;

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, inner]) => inner !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stableStringify(inner)}`).join(',')}}`;
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shared plumbing for the Automation services: permissions, audit, outbox events, realtime hints and diagnostics. */
export class AutomationSupport {
  constructor(
    readonly store: InMemoryStore,
    readonly access: AccessService,
    readonly realtime: RealtimeHub,
  ) {}

  get state() {
    return this.store.state;
  }

  actor(user: User, workspaceId: string): ActorContext {
    return this.access.actor(user, workspaceId);
  }

  /** Configuration and operational commands are workspace-wide capabilities. */
  requireWorkspace(actor: ActorContext, permission: string) {
    this.access.requireWorkspaceScope(actor, permission);
  }

  requireAny(actor: ActorContext, ...permissions: string[]) {
    if (!permissions.some((permission) => this.access.scopeFor(actor, permission) !== null)) throw forbidden(`${permissions[0]} permission is required.`);
  }

  canViewLogs(actor: ActorContext) {
    return this.access.scopeFor(actor, P.viewLogs) !== null;
  }

  audit(actor: ActorContext | { user: { id: string }; workspaceId: string }, action: string, entityType: string, entityId: string, before: unknown, after: unknown, metadata?: unknown) {
    new AuditService(this.store).write({ workspaceId: actor.workspaceId, actorUserId: actor.user.id, action, entityType, entityId, beforeData: before, afterData: after, metadata });
  }

  /** Domain event through the shared outbox. Automation's own events never re-enter Automation (they are marked consumed). */
  emit(workspaceId: string, actorUserId: string | null, eventType: string, entityType: string, entityId: string, changes: Json, correlationId?: string | null) {
    const event = emitDomainEvent(this.store, { workspaceId, eventType, entityType, entityId, actorUserId, changes, correlationId: correlationId ?? null });
    event.automationProcessedAt = new Date();
    this.realtime.enqueue({ type: eventType, workspaceId, data: { entityType, entityId, ...scalars(changes) }, audienceUserIds: this.auditors(workspaceId) });
    return event;
  }

  /** Members allowed to see Automation activity (advisory hints only carry ids/status). */
  private auditors(workspaceId: string): string[] {
    const out: string[] = [];
    for (const userId of this.access.activeMemberIds(workspaceId)) {
      const user = this.state.users.find((item) => item.id === userId);
      if (!user || user.meta?.service === 'AUTOMATION') continue;
      try {
        const actor = this.access.actor(user, workspaceId);
        if (this.access.scopeFor(actor, P.read) || this.access.scopeFor(actor, P.viewLogs)) out.push(userId);
      } catch {
        // membership changed concurrently; skip
      }
    }
    return out;
  }

  log(workspaceId: string, level: AutomationLog['level'], code: string, message: string, refs: { ruleId?: string | null; executionId?: string | null; jobId?: string | null; correlationId?: string | null } = {}, data: Json | null = null) {
    const row: AutomationLog = {
      id: this.store.id(),
      workspaceId,
      ruleId: refs.ruleId ?? null,
      executionId: refs.executionId ?? null,
      jobId: refs.jobId ?? null,
      level,
      code,
      message: message.slice(0, 500),
      data,
      correlationId: refs.correlationId ?? null,
      createdAt: new Date(),
    };
    this.state.automationLogs.push(row);
    return row;
  }

  assertVersion(current: number, provided: unknown) {
    if (typeof provided !== 'number' || !Number.isInteger(provided)) throw badRequest('AUTOMATION_RULE_VERSION_REQUIRED', 'The current Rule version is required.', { field: 'version' });
    if (provided !== current) throw new AppError('AUTOMATION_RULE_VERSION_CONFLICT', 'The Rule changed after you loaded it.', 409, { currentVersion: current });
  }
}

function scalars(changes: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(changes)) if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  return out;
}
