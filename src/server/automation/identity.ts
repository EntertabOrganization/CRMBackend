import type { AccessService, ActorContext } from '../access-service';
import type { Role, User } from '../domain';
import type { InMemoryStore } from '../store';
import type { ActionDescriptor } from './actions';
import type { AutomationRegistry } from './registry';
import type { AutomationJob } from './types';

export const SERVICE_USER_MARK = 'AUTOMATION';

export type ResolvedIdentity = { kind: 'SERVICE' | 'INITIATING_USER'; user: User; actor: ActorContext };

/**
 * Explicit execution identity. Automation never runs as an unrestricted superuser: the service identity is an ordinary
 * workspace member holding a dedicated, non-owner "Automation Service" role whose permissions are exactly the union of
 * what the REGISTERED actions need. Every owning domain service therefore applies its normal permission and state checks
 * to Automation, and an action code that is not registered can never be executed by it.
 */
export class AutomationIdentityService {
  constructor(
    private readonly store: InMemoryStore,
    private readonly access: AccessService,
    private readonly registry: AutomationRegistry,
  ) {}

  private get state() {
    return this.store.state;
  }

  isServiceUser(userId: string | null | undefined): boolean {
    if (!userId) return false;
    return this.state.users.some((user) => user.id === userId && user.meta?.service === SERVICE_USER_MARK);
  }

  /** Every permission any registered action can require; the service role never holds anything beyond this. */
  registeredPermissions(workspaceId: string): string[] {
    const all = new Set<string>();
    for (const action of this.registry.actionsFor(workspaceId)) for (const permission of action.allPermissions) all.add(permission);
    return [...all].sort();
  }

  /** Idempotently creates (or reconciles) the workspace's service user, role, membership and role permissions. */
  serviceIdentity(workspaceId: string): ResolvedIdentity {
    const wanted = this.registeredPermissions(workspaceId);
    let role = this.state.roles.find((item) => item.workspaceId === workspaceId && item.isSystem && item.name === 'Automation Service' && !item.isDeleted);
    if (!role) {
      const created: Role = { id: this.store.id(), workspaceId, name: 'Automation Service', description: 'Scoped identity used by Automation for delayed/system execution.', isSystem: true, isOwnerRole: false, isDeleted: false };
      this.state.roles.push(created);
      role = created;
    }
    // Role permissions reference the permission ROW id (a uuid in the database), never the key.
    const idByKey = new Map(this.state.permissions.filter((permission) => !permission.isDeleted).map((permission) => [permission.key, permission.id]));
    const keyById = new Map([...idByKey.entries()].map(([key, id]) => [id, key]));
    const existing = this.state.rolePermissions.filter((item) => item.roleId === role!.id && !item.isDeleted);
    const wantedSet = new Set(wanted);
    for (const key of wanted) {
      const permissionId = idByKey.get(key);
      if (permissionId && !existing.some((item) => item.permissionId === permissionId)) {
        this.state.rolePermissions.push({ id: this.store.id(), roleId: role.id, permissionId, scope: 'WORKSPACE', isDeleted: false });
      }
    }
    // Permissions no registered action needs any more are withdrawn.
    for (const row of existing) if (!wantedSet.has(keyById.get(row.permissionId) ?? row.permissionId)) row.isDeleted = true;

    const email = `automation+${workspaceId}@service.entertab.invalid`;
    let user = this.state.users.find((item) => item.email === email);
    if (!user) {
      user = { id: this.store.id(), firstName: 'Automation', lastName: 'Service', email, settings: {}, meta: { service: SERVICE_USER_MARK, workspaceId }, status: 'ACTIVE', emailVerifiedAt: new Date(), isDeleted: false };
      this.state.users.push(user);
    }
    let membership = this.state.workspaceMemberships.find((item) => item.workspaceId === workspaceId && item.userId === user!.id);
    if (!membership) {
      membership = { id: this.store.id(), workspaceId, userId: user.id, roleId: role.id, status: 'ACTIVE', isDeleted: false };
      this.state.workspaceMemberships.push(membership);
    } else if (membership.roleId !== role.id || membership.status !== 'ACTIVE' || membership.isDeleted) {
      membership.roleId = role.id;
      membership.status = 'ACTIVE';
      membership.isDeleted = false;
    }
    return { kind: 'SERVICE', user, actor: this.access.actor(user, workspaceId) };
  }

  /** Resolves the identity a job runs as. INITIATING_USER must still be an active member; permissions are theirs. */
  resolve(job: Pick<AutomationJob, 'workspaceId' | 'identityKind' | 'initiatorId' | 'initiatorType'>): ResolvedIdentity | null {
    if (job.identityKind === 'SERVICE') return this.serviceIdentity(job.workspaceId);
    if (job.initiatorType !== 'USER' || !job.initiatorId) return null;
    const user = this.state.users.find((item) => item.id === job.initiatorId && !item.isDeleted);
    if (!user || !this.access.isActiveMember(job.workspaceId, user.id)) return null;
    return { kind: 'INITIATING_USER', user, actor: this.access.actor(user, job.workspaceId) };
  }

  /** The identity must hold what the action needs; owning services still make the final decision. */
  missingPermissions(identity: ResolvedIdentity, action: ActionDescriptor, targetType: string): string[] {
    return action.requiredPermissions(targetType).filter((permission) => this.access.scopeFor(identity.actor, permission) === null);
  }
}
