import type { CrmRecordEntityType, PermissionScope, Role, User, Workspace, WorkspaceMembership } from './domain';
import { forbidden, notFound } from './errors';
import type { InMemoryStore } from './store';

const SCOPE_RANK: Record<PermissionScope, number> = { OWN: 1, DEPARTMENT: 2, DEPARTMENT_TREE: 3, WORKSPACE: 4 };

export type ActorContext = {
  user: User;
  workspaceId: string;
  membership: WorkspaceMembership;
  role: Role;
  workspace: Workspace;
};

/**
 * Shared workspace/permission evaluation for the Custom Fields, Activities and Timeline modules.
 * CRM record access deliberately mirrors CrmCoreService (OWN/WORKSPACE + observers) so that field, timeline
 * and activity access can never be broader than the record access users already have in CRM.
 */
export class AccessService {
  private readonly recordOwners = new Map<string, { find(workspaceId: string, id: string): { responsibleUserId: string } | undefined;
    allowed(actor: ActorContext, id: string, action: 'read' | 'update'): boolean }>();
  registerRecordOwner(type: string, owner: { find(workspaceId: string, id: string): { responsibleUserId: string } | undefined;
    allowed(actor: ActorContext, id: string, action: 'read' | 'update'): boolean }) { this.recordOwners.set(type, owner); }
  constructor(private readonly store: InMemoryStore) {}

  /** Resolves the actor inside the server-resolved workspace. Never trusts a client-supplied workspace claim. */
  actor(user: User, workspaceId: string): ActorContext {
    const workspace = this.store.state.workspaces.find((item) => item.id === workspaceId && !item.isDeleted);
    if (!workspace) throw notFound('Workspace');
    const membership = this.store.state.workspaceMemberships.find(
      (item) => item.userId === user.id && item.workspaceId === workspaceId && item.status === 'ACTIVE' && !item.isDeleted,
    );
    if (!membership) throw forbidden('Workspace membership is required.');
    const role = this.store.state.roles.find((item) => item.id === membership.roleId && !item.isDeleted);
    if (!role) throw forbidden('Workspace role is required.');
    return { user, workspaceId, membership, role, workspace };
  }

  /** Returns the widest scope granted for a permission key, or null when the role does not hold it. */
  scopeFor(actor: ActorContext, permissionKey: string): PermissionScope | null {
    if (actor.role.isOwnerRole) return 'WORKSPACE';
    let best: PermissionScope | null = null;
    for (const item of this.store.state.rolePermissions) {
      if (item.roleId !== actor.role.id || item.isDeleted) continue;
      const permission = this.store.state.permissions.find((candidate) => candidate.id === item.permissionId);
      if (permission?.key !== permissionKey) continue;
      if (!best || SCOPE_RANK[item.scope] > SCOPE_RANK[best]) best = item.scope;
    }
    return best;
  }

  requireScope(actor: ActorContext, permissionKey: string): PermissionScope {
    const scope = this.scopeFor(actor, permissionKey);
    if (!scope) throw forbidden(`${permissionKey} permission is required.`);
    return scope;
  }

  /** Configuration permissions (custom_fields.manage etc.) are workspace-wide by nature. */
  requireWorkspaceScope(actor: ActorContext, permissionKey: string) {
    const scope = this.requireScope(actor, permissionKey);
    if (scope !== 'WORKSPACE') throw forbidden(`${permissionKey} requires workspace scope.`);
  }

  activeMemberIds(workspaceId: string): Set<string> {
    return new Set(
      this.store.state.workspaceMemberships
        .filter((item) => item.workspaceId === workspaceId && item.status === 'ACTIVE' && !item.isDeleted)
        .map((item) => item.userId),
    );
  }

  isActiveMember(workspaceId: string, userId: string) {
    return this.store.state.workspaceMemberships.some(
      (item) => item.workspaceId === workspaceId && item.userId === userId && item.status === 'ACTIVE' && !item.isDeleted,
    );
  }

  /** Does the scope cover a record whose responsible/owning user is `targetUserId`? */
  scopeCoversUser(scope: PermissionScope, actorUserId: string, targetUserId: string | null | undefined, workspaceId: string) {
    if (scope === 'WORKSPACE') return true;
    if (!targetUserId) return false;
    if (targetUserId === actorUserId) return true;
    if (scope === 'OWN') return false;
    const actorDepartments = this.userDepartments(workspaceId, actorUserId);
    const targetDepartments = this.userDepartments(workspaceId, targetUserId);
    if (scope === 'DEPARTMENT') {
      return [...actorDepartments].some((id) => targetDepartments.has(id));
    }
    const reachable = new Set<string>();
    for (const id of actorDepartments) this.collectDescendants(workspaceId, id, reachable);
    return [...reachable].some((id) => targetDepartments.has(id));
  }

  userDepartments(workspaceId: string, userId: string): Set<string> {
    return new Set(
      this.store.state.departmentMembers
        .filter((item) => item.workspaceId === workspaceId && item.userId === userId && !item.isDeleted)
        .map((item) => item.departmentId),
    );
  }

  private collectDescendants(workspaceId: string, departmentId: string, into: Set<string>) {
    if (into.has(departmentId)) return;
    into.add(departmentId);
    for (const child of this.store.state.departments) {
      if (child.workspaceId === workspaceId && !child.isDeleted && child.parentDepartmentId === departmentId) {
        this.collectDescendants(workspaceId, child.id, into);
      }
    }
  }

  // ---- CRM record access (mirrors CrmCoreService) ------------------------------------------------------------

  crmRecord(workspaceId: string, entityType: string, entityId: string) {
    const owner = this.recordOwners.get(entityType); if (owner) return owner.find(workspaceId, entityId);
    const s = this.store.state;
    switch (entityType) {
      case 'LEAD':
        return s.crmLeads.find((item) => item.id === entityId && item.workspaceId === workspaceId && !item.isDeleted);
      case 'DEAL':
        return s.crmDeals.find((item) => item.id === entityId && item.workspaceId === workspaceId && !item.isDeleted);
      case 'CONTACT':
        return s.crmContacts.find((item) => item.id === entityId && item.workspaceId === workspaceId && !item.isDeleted);
      case 'COMPANY':
        return s.crmCompanies.find((item) => item.id === entityId && item.workspaceId === workspaceId && !item.isDeleted);
      default:
        return undefined;
    }
  }

  private crmPermissionKey(entityType: CrmRecordEntityType, action: 'read' | 'update' | 'create') {
    return `crm.${entityType.toLowerCase()}.${action}`;
  }

  canAccessCrmRecord(actor: ActorContext, entityType: string, entityId: string, action: 'read' | 'update'): boolean {
    const owner = this.recordOwners.get(entityType); if (owner) return owner.allowed(actor, entityId, action);
    const record = this.crmRecord(actor.workspaceId, entityType, entityId);
    if (!record) return false;
    const scope = this.scopeFor(actor, this.crmPermissionKey(entityType as CrmRecordEntityType, action));
    if (scope) {
      if (scope === 'WORKSPACE') return true;
      if (scope === 'OWN' && record.responsibleUserId === actor.user.id) return true;
    }
    if (action === 'read') {
      return this.store.state.crmRecordObservers.some(
        (observer) =>
          observer.workspaceId === actor.workspaceId &&
          observer.entityType === entityType &&
          observer.recordId === entityId &&
          observer.userId === actor.user.id,
      );
    }
    return false;
  }

  canCreateCrmRecord(actor: ActorContext, entityType: string) {
    return this.scopeFor(actor, this.crmPermissionKey(entityType as CrmRecordEntityType, 'create')) !== null;
  }
}
