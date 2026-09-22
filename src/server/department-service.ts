import type { Department, User } from './domain';
import { AuditService } from './audit-service';
import { badRequest, conflict, forbidden, notFound } from './errors';
import type { InMemoryStore } from './store';
import { WorkspaceService } from './workspace-service';

export class DepartmentService {
  constructor(private readonly store: InMemoryStore) {}

  create(user: User, workspaceId: string, input: { name: string; description?: string | null; parentDepartmentId?: string | null; managerId?: string | null }) {
    const { role } = new WorkspaceService(this.store).assertMembership(user.id, workspaceId);
    if (!role.isOwnerRole) throw forbidden();
    this.validateParent(workspaceId, input.parentDepartmentId ?? null);
    this.assertSiblingUnique(workspaceId, input.parentDepartmentId ?? null, input.name);
    if (input.managerId) this.assertWorkspaceMember(input.managerId, workspaceId);
    const department: Department = {
      id: this.store.id(),
      workspaceId,
      parentDepartmentId: input.parentDepartmentId ?? null,
      name: input.name,
      description: input.description ?? null,
      managerId: input.managerId ?? null,
      isDeleted: false,
    };
    this.store.state.departments.push(department);
    new AuditService(this.store).write({
      workspaceId,
      actorUserId: user.id,
      action: 'DEPARTMENT.CREATED',
      entityType: 'Department',
      entityId: department.id,
      afterData: department,
    });
    return department;
  }

  children(user: User, workspaceId: string, departmentId: string) {
    new WorkspaceService(this.store).assertMembership(user.id, workspaceId);
    return this.store.state.departments.filter((department) => department.workspaceId === workspaceId && department.parentDepartmentId === departmentId && !department.isDeleted);
  }

  descendants(user: User, workspaceId: string, departmentId: string) {
    new WorkspaceService(this.store).assertMembership(user.id, workspaceId);
    return this.collectDescendants(workspaceId, departmentId);
  }

  ancestors(user: User, workspaceId: string, departmentId: string) {
    new WorkspaceService(this.store).assertMembership(user.id, workspaceId);
    const result: Department[] = [];
    let current = this.getDepartment(workspaceId, departmentId);
    while (current.parentDepartmentId) {
      current = this.getDepartment(workspaceId, current.parentDepartmentId);
      result.unshift(current);
    }
    return result;
  }

  tree(user: User, workspaceId: string) {
    new WorkspaceService(this.store).assertMembership(user.id, workspaceId);
    return this.store.state.departments.filter((department) => department.workspaceId === workspaceId && !department.isDeleted);
  }

  move(user: User, workspaceId: string, id: string, parentDepartmentId: string | null) {
    const { role } = new WorkspaceService(this.store).assertMembership(user.id, workspaceId);
    if (!role.isOwnerRole) throw forbidden();
    const department = this.getDepartment(workspaceId, id);
    if (parentDepartmentId === id) throw badRequest('DEPARTMENT_SELF_PARENT', 'Department cannot parent itself.');
    this.validateParent(workspaceId, parentDepartmentId);
    if (parentDepartmentId && this.collectDescendants(workspaceId, id).some((item) => item.id === parentDepartmentId)) {
      throw badRequest('DEPARTMENT_CYCLE', 'Department cannot move under its descendant.');
    }
    this.assertSiblingUnique(workspaceId, parentDepartmentId, department.name, id);
    department.parentDepartmentId = parentDepartmentId;
    new AuditService(this.store).write({
      workspaceId,
      actorUserId: user.id,
      action: 'DEPARTMENT.MOVED',
      entityType: 'Department',
      entityId: id,
    });
    return department;
  }

  softDelete(user: User, workspaceId: string, id: string) {
    const { role } = new WorkspaceService(this.store).assertMembership(user.id, workspaceId);
    if (!role.isOwnerRole) throw forbidden();
    const department = this.getDepartment(workspaceId, id);
    if (this.store.state.departments.some((item) => item.parentDepartmentId === id && !item.isDeleted)) {
      throw conflict('DEPARTMENT_HAS_CHILDREN', 'Move or delete child departments first.');
    }
    department.isDeleted = true;
    new AuditService(this.store).write({ workspaceId, actorUserId: user.id, action: 'DEPARTMENT.SOFT_DELETED', entityType: 'Department', entityId: id });
    return department;
  }

  addMembers(user: User, workspaceId: string, departmentId: string, userIds: string[]) {
    const { role } = new WorkspaceService(this.store).assertMembership(user.id, workspaceId);
    if (!role.isOwnerRole) throw forbidden();
    this.getDepartment(workspaceId, departmentId);
    userIds.forEach((userId) => this.assertWorkspaceMember(userId, workspaceId));
    if (userIds.some((userId) => this.store.state.departmentMembers.some((item) => item.departmentId === departmentId && item.userId === userId && !item.isDeleted))) {
      throw conflict('DEPARTMENT_MEMBER_EXISTS', 'Duplicate department membership is not allowed.');
    }
    const created = userIds.map((userId) => ({
      id: this.store.id(),
      workspaceId,
      departmentId,
      userId,
      isDeleted: false,
    }));
    this.store.state.departmentMembers.push(...created);
    new AuditService(this.store).write({
      workspaceId,
      actorUserId: user.id,
      action: 'DEPARTMENT.MEMBER_ADDED',
      entityType: 'DepartmentMember',
      metadata: { departmentId, userIds, count: userIds.length },
    });
    return created;
  }

  removeMember(user: User, workspaceId: string, departmentId: string, userId: string) {
    const { role } = new WorkspaceService(this.store).assertMembership(user.id, workspaceId);
    if (!role.isOwnerRole) throw forbidden();
    const department = this.getDepartment(workspaceId, departmentId);
    if (department.managerId === userId) throw conflict('DEPARTMENT_MANAGER_REMOVE_BLOCKED', 'Clear or change manager before removing membership.');
    const member = this.store.state.departmentMembers.find((item) => item.departmentId === departmentId && item.userId === userId && !item.isDeleted);
    if (!member) throw notFound('Department member');
    member.isDeleted = true;
    new AuditService(this.store).write({ workspaceId, actorUserId: user.id, action: 'DEPARTMENT.MEMBER_REMOVED', entityType: 'DepartmentMember', entityId: member.id });
    return member;
  }

  private getDepartment(workspaceId: string, id: string) {
    const department = this.store.state.departments.find((item) => item.id === id && item.workspaceId === workspaceId && !item.isDeleted);
    if (!department) throw notFound('Department');
    return department;
  }

  private validateParent(workspaceId: string, parentDepartmentId: string | null) {
    if (!parentDepartmentId) return;
    this.getDepartment(workspaceId, parentDepartmentId);
  }

  private assertSiblingUnique(workspaceId: string, parentDepartmentId: string | null, name: string, excludeId?: string) {
    if (this.store.state.departments.some((item) =>
      item.workspaceId === workspaceId &&
      item.parentDepartmentId === parentDepartmentId &&
      item.name.toLowerCase() === name.toLowerCase() &&
      !item.isDeleted &&
      item.id !== excludeId
    )) {
      throw conflict('DEPARTMENT_SIBLING_NAME_EXISTS', 'Department name must be unique among active siblings.');
    }
  }

  private collectDescendants(workspaceId: string, id: string): Department[] {
    const direct = this.store.state.departments.filter((item) => item.workspaceId === workspaceId && item.parentDepartmentId === id && !item.isDeleted);
    return direct.flatMap((child) => [child, ...this.collectDescendants(workspaceId, child.id)]);
  }

  private assertWorkspaceMember(userId: string, workspaceId: string) {
    if (!this.store.state.workspaceMemberships.some((item) => item.userId === userId && item.workspaceId === workspaceId && !item.isDeleted && item.status === 'ACTIVE')) {
      throw badRequest('WORKSPACE_MEMBER_REQUIRED', 'User must have active membership in the workspace.');
    }
  }
}
