import type { PermissionScope, User } from './domain';
import { AuditService } from './audit-service';
import { badRequest, conflict, forbidden, notFound } from './errors';
import type { InMemoryStore } from './store';
import { WorkspaceService } from './workspace-service';

export class RoleService {
  constructor(private readonly store: InMemoryStore) {}

  permissions() {
    return this.store.state.permissions.filter((permission) => !permission.isDeleted);
  }

  list(user: User, workspaceId: string) {
    new WorkspaceService(this.store).assertMembership(user.id, workspaceId);
    return this.store.state.roles.filter((role) => role.workspaceId === workspaceId && !role.isDeleted);
  }

  create(user: User, workspaceId: string, input: { name: string; description?: string | null }) {
    const { role } = new WorkspaceService(this.store).assertMembership(user.id, workspaceId);
    if (!role.isOwnerRole) throw forbidden();
    const created = {
      id: this.store.id(),
      workspaceId,
      name: input.name,
      description: input.description ?? null,
      isSystem: false,
      isOwnerRole: false,
      isDeleted: false,
    };
    this.store.state.roles.push(created);
    new AuditService(this.store).write({
      workspaceId,
      actorUserId: user.id,
      action: 'ROLE.CREATED',
      entityType: 'Role',
      entityId: created.id,
      afterData: created,
    });
    return created;
  }

  replacePermissions(user: User, workspaceId: string, roleId: string, permissions: { permissionId: string; scope: PermissionScope }[]) {
    const { role: actorRole } = new WorkspaceService(this.store).assertMembership(user.id, workspaceId);
    if (!actorRole.isOwnerRole) throw forbidden();
    const role = this.store.state.roles.find((item) => item.id === roleId && item.workspaceId === workspaceId && !item.isDeleted);
    if (!role) throw notFound('Role');
    if (role.isOwnerRole) throw forbidden('Owner/Admin role permissions are implicit and protected.');
    const ids = new Set(this.store.state.permissions.map((permission) => permission.id));
    if (permissions.some((permission) => !ids.has(permission.permissionId))) {
      throw badRequest('PERMISSION_INVALID', 'All permissions must exist in the registry.');
    }
    this.store.state.rolePermissions = this.store.state.rolePermissions.filter((item) => item.roleId !== roleId);
    const created = permissions.map((permission) => ({
      id: this.store.id(),
      roleId,
      permissionId: permission.permissionId,
      scope: permission.scope,
      isDeleted: false,
    }));
    this.store.state.rolePermissions.push(...created);
    new AuditService(this.store).write({
      workspaceId,
      actorUserId: user.id,
      action: 'ROLE.PERMISSIONS_UPDATED',
      entityType: 'Role',
      entityId: roleId,
      afterData: created,
    });
    return created;
  }

  delete(user: User, workspaceId: string, roleId: string, hard = false) {
    const { role: actorRole } = new WorkspaceService(this.store).assertMembership(user.id, workspaceId);
    if (!actorRole.isOwnerRole) throw forbidden();
    const role = this.store.state.roles.find((item) => item.id === roleId && item.workspaceId === workspaceId);
    if (!role) throw notFound('Role');
    if (role.isOwnerRole) throw forbidden('Owner/Admin role is protected.');
    if (this.store.state.workspaceMemberships.some((membership) => membership.roleId === roleId && !membership.isDeleted)) {
      throw conflict('ROLE_IN_USE', 'Role is assigned to active workspace members.');
    }
    if (hard) {
      if (!role.isDeleted) throw conflict('SOFT_DELETE_REQUIRED', 'Role must be soft-deleted before hard deletion.');
      this.store.state.roles = this.store.state.roles.filter((item) => item.id !== roleId);
      this.store.state.rolePermissions = this.store.state.rolePermissions.filter((item) => item.roleId !== roleId);
    } else {
      role.isDeleted = true;
    }
    new AuditService(this.store).write({
      workspaceId,
      actorUserId: user.id,
      action: hard ? 'ROLE.HARD_DELETED' : 'ROLE.SOFT_DELETED',
      entityType: 'Role',
      entityId: roleId,
    });
    return { id: roleId };
  }
}
