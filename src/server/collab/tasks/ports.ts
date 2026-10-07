import type { ActorContext } from '../../access-service';
import type { Project, ProjectToolType, Task } from './types';

/**
 * Contracts Tasks & Projects uses to reach resources owned by other collaboration modules. The owning module registers
 * an implementation; Tasks never writes another module's tables. Calls happen inside the same request transaction.
 */

/** Lazily provisions and governs the one canonical Project Chat / Calendar / Drive. */
export interface ProjectResourceProvisioner {
  readonly toolType: Extract<ProjectToolType, 'CHAT' | 'CALENDAR' | 'DRIVE'>;
  readonly resourceType: string;
  /** Returns the canonical resource for the Project, creating it on first call. Must be idempotent. */
  provision(project: Project, actorUserId: string, memberUserIds: string[]): string;
  /** Archive makes project-owned resources operationally read-only; unarchive lifts it. */
  setReadOnly(project: Project, resourceId: string, readOnly: boolean): void;
  /** Replaces the PROJECT-derived access source; access granted through other sources is untouched. */
  syncProjectMembers(project: Project, resourceId: string, memberUserIds: string[]): void;
  /** Project hard delete: the resource keeps its own history and lifecycle, only the Project link is removed. */
  detach(project: Project, resourceId: string): void;
}

/** System-managed Task Chat (Communication). Task authorization is the only source of its membership. */
export interface TaskChatPort {
  ensureTaskChat(task: Task, audienceUserIds: string[], actorUserId: string | null): string;
  syncTaskChatAccess(task: Task, audienceUserIds: string[]): void;
  /** Soft delete freezes the chat; restore re-enables it; hard delete detaches it (messages follow chat retention). */
  onTaskLifecycle(task: Task, change: 'DELETED' | 'RESTORED' | 'HARD_DELETED'): void;
}

/** Validates non-CRM binding targets (chat message, feed post, calendar event...) owned by other modules. */
export interface BindingTargetResolver {
  readonly entityType: string;
  /** True only when the target exists in the actor's Workspace and the actor can read it. */
  canBind(actor: ActorContext, entityId: string): boolean;
}
