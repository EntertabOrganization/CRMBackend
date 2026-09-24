import type { ActorContext } from '../access-service';
import type { AccessService } from '../access-service';
import type { InMemoryStore } from '../store';
import type { Activity, ActivityBinding } from './types';

export type ActivityPermission =
  | 'activity.create'
  | 'activity.read'
  | 'activity.update'
  | 'activity.delete'
  | 'activity.complete'
  | 'activity.reopen'
  | 'activity.assign';

/**
 * Activity authorization. Rules:
 *  - each action needs its own permission key plus a scope that covers the Activity's owner;
 *  - OWN means the responsible user (creator only when nobody is responsible), never every Activity the user touches;
 *  - reading a bound Activity needs an authorized binding (the responsible user keeps access, with all bindings redacted).
 */
export class ActivityAccessPolicy {
  constructor(
    private readonly store: InMemoryStore,
    private readonly access: AccessService,
  ) {}

  ownerOf(activity: Pick<Activity, 'responsibleUserId' | 'createdByUserId'>) {
    return activity.responsibleUserId ?? activity.createdByUserId ?? null;
  }

  scopeCovers(actor: ActorContext, permission: ActivityPermission, activity: Activity): boolean {
    const scope = this.access.scopeFor(actor, permission);
    if (!scope) return false;
    return this.access.scopeCoversUser(scope, actor.user.id, this.ownerOf(activity), actor.workspaceId);
  }

  private bindingIndex: { source: ActivityBinding[]; length: number; byActivity: Map<string, ActivityBinding[]> } | null = null;

  /** Bindings of one Activity. Indexed lazily; the index is rebuilt whenever the binding collection changes. */
  bindingsOf(activityId: string): ActivityBinding[] {
    const source = this.store.state.crmActivityBindings;
    if (!this.bindingIndex || this.bindingIndex.source !== source || this.bindingIndex.length !== source.length) {
      const byActivity = new Map<string, ActivityBinding[]>();
      for (const binding of source) {
        const list = byActivity.get(binding.activityId);
        if (list) list.push(binding);
        else byActivity.set(binding.activityId, [binding]);
      }
      this.bindingIndex = { source, length: source.length, byActivity };
    }
    return this.bindingIndex.byActivity.get(activityId) ?? [];
  }

  canReadBinding(actor: ActorContext, binding: ActivityBinding) {
    return this.access.canAccessCrmRecord(actor, binding.entityType, binding.entityId, 'read');
  }

  visibleBindings(actor: ActorContext, activityId: string) {
    return this.bindingsOf(activityId).filter((binding) => this.canReadBinding(actor, binding));
  }

  canRead(actor: ActorContext, activity: Activity): boolean {
    if (activity.workspaceId !== actor.workspaceId) return false;
    if (!this.scopeCovers(actor, 'activity.read', activity)) return false;
    const bindings = this.bindingsOf(activity.id);
    if (bindings.length === 0) return true;
    if (activity.responsibleUserId === actor.user.id) return true;
    return bindings.some((binding) => this.canReadBinding(actor, binding));
  }

  canDo(actor: ActorContext, permission: Exclude<ActivityPermission, 'activity.create' | 'activity.read'>, activity: Activity) {
    return this.canRead(actor, activity) && this.scopeCovers(actor, permission, activity);
  }

  /** May the actor assign work to `targetUserId`? Needs activity.assign with a scope covering that user. */
  canAssignTo(actor: ActorContext, targetUserId: string) {
    const scope = this.access.scopeFor(actor, 'activity.assign');
    if (!scope) return false;
    return this.access.scopeCoversUser(scope, actor.user.id, targetUserId, actor.workspaceId) && this.access.isActiveMember(actor.workspaceId, targetUserId);
  }
}
