import type { EffectivePermission, Role, SessionContext, User, Workspace } from './domain';
import { conflict, forbidden, notFound } from './errors';
import { PERMISSION_CATALOG } from './permissions';
import type { InMemoryStore } from './store';
import { AuditService } from './audit-service';
import { safeUser } from './sanitize';

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'workspace';
}

export class WorkspaceService {
  constructor(private readonly store: InMemoryStore) {}

  async bootstrapFirstWorkspace(user: User, name = `${user.firstName}'s Workspace`) {
    return this.store.transaction(async (tx) => {
      const workspace = await new WorkspaceService(tx).createOwnedWorkspace(user, name);
      new AuditService(tx).write({
        workspaceId: workspace.id,
        actorUserId: user.id,
        action: 'AUTH.EMAIL_VERIFIED',
        entityType: 'User',
        entityId: user.id,
      });
      return workspace;
    });
  }

  async createOwnedWorkspace(user: User, name: string) {
    const slugBase = slugify(name);
    let slug = slugBase;
    let suffix = 1;
    while (this.store.state.workspaces.some((workspace) => workspace.slug === slug)) {
      suffix += 1;
      slug = `${slugBase}-${suffix}`;
    }

    const workspace: Workspace = {
      id: this.store.id(),
      name,
      slug,
      description: null,
      settings: {},
      meta: null,
      ownerUserId: user.id,
      isDeleted: false,
    };
    const role: Role = {
      id: this.store.id(),
      workspaceId: workspace.id,
      name: 'Owner/Admin',
      description: 'Protected workspace owner role',
      isSystem: true,
      isOwnerRole: true,
      isDeleted: false,
    };
    const membership = {
      id: this.store.id(),
      workspaceId: workspace.id,
      userId: user.id,
      roleId: role.id,
      status: 'ACTIVE' as const,
      isDeleted: false,
    };

    this.store.state.workspaces.push(workspace);
    this.store.state.roles.push(role);
    this.store.state.workspaceMemberships.push(membership);
    new AuditService(this.store).write({
      workspaceId: workspace.id,
      actorUserId: user.id,
      action: 'WORKSPACE.CREATED',
      entityType: 'Workspace',
      entityId: workspace.id,
      afterData: { id: workspace.id, name: workspace.name },
    });
    return workspace;
  }

  resolveSession(user: User): SessionContext {
    const userMemberships = this.store.state.workspaceMemberships.filter(
      (membership) => membership.userId === user.id && membership.status === 'ACTIVE' && !membership.isDeleted,
    );
    const lastActiveWorkspaceId = typeof user.settings.lastActiveWorkspaceId === 'string'
      ? user.settings.lastActiveWorkspaceId
      : null;
    let membership: typeof userMemberships[number] | null = userMemberships.find((item) => item.workspaceId === lastActiveWorkspaceId) ?? userMemberships[0] ?? null;
    const membershipWorkspaceId = membership?.workspaceId;
    const workspace = membershipWorkspaceId
      ? this.store.state.workspaces.find((item) => item.id === membershipWorkspaceId && !item.isDeleted) ?? null
      : null;
    if (!workspace) {
      membership = null;
    }
    const role = membership
      ? this.store.state.roles.find((item) => item.id === membership.roleId && !item.isDeleted) ?? null
      : null;
    const permissions: EffectivePermission[] = role?.isOwnerRole
      ? PERMISSION_CATALOG.map((key) => ({ key, scope: 'WORKSPACE' }))
      : this.store.state.rolePermissions
        .filter((item) => item.roleId === role?.id && !item.isDeleted)
        .map((item) => ({
          key: this.store.state.permissions.find((permission) => permission.id === item.permissionId)?.key ?? item.permissionId,
          scope: item.scope,
        }));

    return { user: safeUser(user), workspace, membership, role, permissions };
  }

  assertMembership(userId: string, workspaceId: string) {
    const workspace = this.store.state.workspaces.find((item) => item.id === workspaceId && !item.isDeleted);
    if (!workspace) throw notFound('Workspace');
    const membership = this.store.state.workspaceMemberships.find(
      (item) => item.userId === userId && item.workspaceId === workspaceId && item.status === 'ACTIVE' && !item.isDeleted,
    );
    if (!membership) throw forbidden('Workspace membership is required.');
    const role = this.store.state.roles.find((item) => item.id === membership.roleId && !item.isDeleted);
    if (!role) throw forbidden('Workspace role is required.');
    return { workspace, membership, role };
  }

  switchWorkspace(user: User, workspaceId: string) {
    const { workspace, membership, role } = this.assertMembership(user.id, workspaceId);
    user.settings = { ...user.settings, lastActiveWorkspaceId: workspaceId };
    new AuditService(this.store).write({
      workspaceId,
      actorUserId: user.id,
      action: 'WORKSPACE.SWITCHED',
      entityType: 'Workspace',
      entityId: workspaceId,
    });
    return { workspace, membership, role, permissions: this.resolveSession(user).permissions };
  }

  updateWorkspace(user: User, workspaceId: string, input: Partial<Pick<Workspace, 'name' | 'description' | 'settings' | 'meta'>>) {
    const { workspace, role } = this.assertMembership(user.id, workspaceId);
    if (!role.isOwnerRole) throw forbidden();
    const before = { ...workspace };
    Object.assign(workspace, input);
    new AuditService(this.store).write({
      workspaceId,
      actorUserId: user.id,
      action: 'WORKSPACE.UPDATED',
      entityType: 'Workspace',
      entityId: workspaceId,
      beforeData: before,
      afterData: workspace,
    });
    return workspace;
  }

  softDelete(user: User, workspaceId: string) {
    const { workspace, role } = this.assertMembership(user.id, workspaceId);
    if (!role.isOwnerRole) throw forbidden();
    workspace.isDeleted = true;
    new AuditService(this.store).write({
      workspaceId,
      actorUserId: user.id,
      action: 'WORKSPACE.SOFT_DELETED',
      entityType: 'Workspace',
      entityId: workspaceId,
    });
    return workspace;
  }

  restore(user: User, workspaceId: string) {
    const workspace = this.store.state.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) throw notFound('Workspace');
    const membership = this.store.state.workspaceMemberships.find((item) => item.userId === user.id && item.workspaceId === workspaceId);
    const role = membership ? this.store.state.roles.find((item) => item.id === membership.roleId) : null;
    if (!role?.isOwnerRole) throw forbidden();
    workspace.isDeleted = false;
    new AuditService(this.store).write({
      workspaceId,
      actorUserId: user.id,
      action: 'WORKSPACE.RESTORED',
      entityType: 'Workspace',
      entityId: workspaceId,
    });
    return workspace;
  }

  hardDelete(user: User, workspaceId: string) {
    const workspace = this.store.state.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) throw notFound('Workspace');
    if (!workspace.isDeleted) throw conflict('SOFT_DELETE_REQUIRED', 'Workspace must be soft-deleted before hard deletion.');
    if (workspace.ownerUserId !== user.id) throw forbidden();
    this.store.state.workspaces = this.store.state.workspaces.filter((item) => item.id !== workspaceId);
    this.store.state.workspaceMemberships = this.store.state.workspaceMemberships.filter((item) => item.workspaceId !== workspaceId);
    this.store.state.roles = this.store.state.roles.filter((item) => item.workspaceId !== workspaceId);
    new AuditService(this.store).write({
      workspaceId,
      actorUserId: user.id,
      action: 'WORKSPACE.HARD_DELETED',
      entityType: 'Workspace',
      entityId: workspaceId,
    });
    return { id: workspaceId };
  }
}
