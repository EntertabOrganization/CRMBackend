import { AuthModule, DomainError, PermissionScope } from '../src';

const password = 'Password1';

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

function verified(module: AuthModule, email = `user-${Math.random()}@example.com`) {
  const signup = module.signup({ firstName: 'Faris', lastName: 'Hassan', email, password });
  return module.verifyEmail(signup.verificationToken);
}

function inviteAndAccept(module: AuthModule, ownerId: string, workspaceId: string, roleId: string, email: string) {
  const invite = module.inviteUser(ownerId, workspaceId, { email, roleId });
  return module.acceptInvitation(invite.invitationToken, { email, firstName: 'Mona', lastName: 'Ali', password });
}

describe('Authentication module', () => {
  it('signs up pending users, stores token hashes only, then verifies and bootstraps workspace atomically', () => {
    const module = new AuthModule();
    const signup = module.signup({ firstName: 'Faris', lastName: 'Hassan', email: ' FARIS@Example.COM ', password });

    expect(signup.user.email).toBe('faris@example.com');
    expect(signup.user.status).toBe('PENDING_VERIFICATION');
    expect(module.state.workspaces).toHaveLength(0);
    expect((module.state as any).verificationTokens[0].tokenHash).not.toBe(signup.verificationToken);
    expect((module.state as any).verificationTokens[0].expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    expectCode(() => module.signup({ firstName: 'Other', lastName: 'User', email: 'faris@example.com', password }), 'EMAIL_ALREADY_EXISTS');

    const session = module.verifyEmail(signup.verificationToken);
    expect(session.context.user.status).toBe('ACTIVE');
    expect(session.context.workspace.name).toBe("Faris's Workspace");
    expect(session.context.role.isOwnerRole).toBe(true);
    expect(session.context.permissions.map((p) => p.key)).toContain('workspace.update');
    expect((module.state as any).verificationTokens[0].consumedAt).toBeInstanceOf(Date);
    expect(module.state.auditLogs.map((l) => l.action)).toEqual(expect.arrayContaining(['AUTH.USER_SIGNED_UP', 'AUTH.EMAIL_VERIFIED', 'WORKSPACE.CREATED']));
  });

  it('rolls back verification bootstrap failures without exposing half-created workspaces', () => {
    const module = new AuthModule();
    const signup = module.signup({ firstName: 'Faris', lastName: 'Hassan', email: 'rollback@example.com', password });
    module.failNextBootstrap = true;
    expectCode(() => module.verifyEmail(signup.verificationToken), 'BOOTSTRAP_FAILED');
    expect(module.state.workspaces).toHaveLength(0);
    expect(module.state.users[0].status).toBe('PENDING_VERIFICATION');
  });

  it('supports signin, last-workspace validation, refresh rotation, logout and reset-password revocation', () => {
    const module = new AuthModule();
    const session = verified(module, 'signin@example.com');
    const userId = session.context.user.id;
    const firstWorkspaceId = session.context.workspace.id;
    const secondWorkspace = module.createWorkspace(userId, { name: 'Second Workspace' });

    module.switchWorkspace(userId, secondWorkspace.id);
    expect(module.signin({ email: 'signin@example.com', password }).context.workspace.id).toBe(secondWorkspace.id);
    module.softDeleteWorkspace(userId, secondWorkspace.id);
    expect(module.signin({ email: 'signin@example.com', password }).context.workspace.id).toBe(firstWorkspaceId);

    const signedIn = module.signin({ email: 'signin@example.com', password });
    const rotated = module.refresh(signedIn.refreshToken);
    expect(rotated.refreshToken).not.toBe(signedIn.refreshToken);
    expectCode(() => module.refresh(signedIn.refreshToken), 'INVALID_REFRESH_TOKEN');
    module.logout(rotated.refreshToken);
    expectCode(() => module.refresh(rotated.refreshToken), 'INVALID_REFRESH_TOKEN');

    const active = module.signin({ email: 'signin@example.com', password });
    const reset = module.forgotPassword('signin@example.com');
    module.resetPassword(reset.resetToken!, 'NewPassword1');
    expectCode(() => module.refresh(active.refreshToken), 'INVALID_REFRESH_TOKEN');
    expect(module.signin({ email: 'signin@example.com', password: 'NewPassword1' }).context.user.id).toBe(userId);
  });

  it('rejects unverified, suspended and soft-deleted users and supports Google auth linking', async () => {
    const module = new AuthModule();
    module.signup({ firstName: 'Pending', lastName: 'User', email: 'pending@example.com', password });
    expectCode(() => module.signin({ email: 'pending@example.com', password }), 'USER_NOT_ACTIVE');

    const session = verified(module, 'google@example.com');
    module.googleVerifier = async () => ({ email: ' GOOGLE@example.com ', emailVerified: true, providerUserId: 'g-1', firstName: 'Google', lastName: 'User' });
    const googleSession = await module.googleAuth('credential');
    expect(googleSession.context.user.id).toBe(session.context.user.id);
    expect(module.state.users.filter((u) => u.email === 'google@example.com')).toHaveLength(1);

    module.googleVerifier = async () => ({ email: 'new@example.com', emailVerified: false, providerUserId: 'g-2', firstName: 'New', lastName: 'User' });
    await expect(module.googleAuth('bad')).rejects.toMatchObject({ code: 'GOOGLE_EMAIL_UNVERIFIED' });

    module.softDeleteUser(session.context.user.id, session.context.user.id);
    expectCode(() => module.signin({ email: 'google@example.com', password }), 'USER_NOT_ACTIVE');
  });
});

describe('Workspace and authorization modules', () => {
  it('enforces workspace isolation, unique slugs, owner protection and role permission behavior', () => {
    const module = new AuthModule();
    const owner = verified(module, 'owner@example.com');
    const ownerId = owner.context.user.id;
    const workspaceId = owner.context.workspace.id;
    const sameName = module.createWorkspace(ownerId, { name: owner.context.workspace.name });
    expect(sameName.name).toBe(owner.context.workspace.name);
    expect(sameName.slug).not.toBe(owner.context.workspace.slug);

    const read = module.state.permissions.find((p) => p.key === 'department.read')!;
    const role = module.createRole(ownerId, workspaceId, { name: 'Department Reader', permissions: [{ permissionId: read.id, scope: 'DEPARTMENT' }] });
    const member = inviteAndAccept(module, ownerId, workspaceId, role.id, 'member@example.com');

    expectCode(() => module.replaceRolePermissions(ownerId, workspaceId, owner.context.role.id, []), 'PROTECTED_ROLE');
    expectCode(() => module.deleteRole(ownerId, workspaceId, role.id), 'ROLE_IN_USE');
    expect(module.listPermissions({ search: 'workspace', limit: 5 }).meta.total).toBeGreaterThan(0);

    const foreign = verified(module, 'foreign@example.com');
    expectCode(() => module.getWorkspace(member.user.id, foreign.context.workspace.id), 'MEMBERSHIP_NOT_FOUND');
    expectCode(() => module.authorizeResource(member.user.id, workspaceId, 'department.read', { workspaceId: foreign.context.workspace.id }), 'PERMISSION_DENIED');
  });

  it('soft deletes, restores, hard deletes workspaces and preserves audit rows', () => {
    const module = new AuthModule();
    const session = verified(module, 'workspace-lifecycle@example.com');
    const userId = session.context.user.id;
    const workspace = module.createWorkspace(userId, { name: 'Disposable' });
    module.softDeleteWorkspace(userId, workspace.id);
    module.restoreWorkspace(userId, workspace.id);
    module.softDeleteWorkspace(userId, workspace.id);
    module.hardDeleteWorkspace(userId, workspace.id);
    expect(module.state.workspaces.some((w) => w.id === workspace.id)).toBe(false);
    expect(module.state.auditLogs.some((l) => l.entityId === workspace.id && l.action === 'WORKSPACE.HARD_DELETED')).toBe(true);
  });

  it('evaluates OWN, DEPARTMENT, DEPARTMENT_TREE, WORKSPACE and missing permissions correctly', () => {
    const module = new AuthModule();
    const owner = verified(module, 'scope-owner@example.com');
    const ownerId = owner.context.user.id;
    const workspaceId = owner.context.workspace.id;
    const departmentRead = module.state.permissions.find((p) => p.key === 'department.read')!;

    const ownRole = module.createRole(ownerId, workspaceId, { name: 'Own Scope', permissions: [{ permissionId: departmentRead.id, scope: 'OWN' }] });
    const departmentRole = module.createRole(ownerId, workspaceId, { name: 'Department Scope', permissions: [{ permissionId: departmentRead.id, scope: 'DEPARTMENT' }] });
    const treeRole = module.createRole(ownerId, workspaceId, { name: 'Tree Scope', permissions: [{ permissionId: departmentRead.id, scope: 'DEPARTMENT_TREE' }] });
    const workspaceRole = module.createRole(ownerId, workspaceId, { name: 'Workspace Scope', permissions: [{ permissionId: departmentRead.id, scope: 'WORKSPACE' }] });
    const emptyRole = module.createRole(ownerId, workspaceId, { name: 'No Permission' });

    const ownUser = inviteAndAccept(module, ownerId, workspaceId, ownRole.id, 'own-scope@example.com');
    const departmentUser = inviteAndAccept(module, ownerId, workspaceId, departmentRole.id, 'department-scope@example.com');
    const treeUser = inviteAndAccept(module, ownerId, workspaceId, treeRole.id, 'tree-scope@example.com');
    const workspaceUser = inviteAndAccept(module, ownerId, workspaceId, workspaceRole.id, 'workspace-scope@example.com');
    const deniedUser = inviteAndAccept(module, ownerId, workspaceId, emptyRole.id, 'denied-scope@example.com');

    const sales = module.createDepartment(ownerId, workspaceId, { name: 'Scope Sales' });
    const cairo = module.createDepartment(ownerId, workspaceId, { name: 'Scope Cairo', parentDepartmentId: sales.id });
    const support = module.createDepartment(ownerId, workspaceId, { name: 'Scope Support' });
    module.bulkAddDepartmentMembers(ownerId, workspaceId, sales.id, [departmentUser.user.id, treeUser.user.id]);

    expect(module.authorizeResource(ownUser.user.id, workspaceId, 'department.read', { workspaceId, ownerUserId: ownUser.user.id })).toBe(true);
    expect(module.authorizeResource(ownUser.user.id, workspaceId, 'department.read', { workspaceId, ownerUserId: ownerId })).toBe(false);

    expect(module.authorizeResource(departmentUser.user.id, workspaceId, 'department.read', { workspaceId, departmentId: sales.id })).toBe(true);
    expect(module.authorizeResource(departmentUser.user.id, workspaceId, 'department.read', { workspaceId, departmentId: cairo.id })).toBe(false);

    expect(module.authorizeResource(treeUser.user.id, workspaceId, 'department.read', { workspaceId, departmentId: sales.id })).toBe(true);
    expect(module.authorizeResource(treeUser.user.id, workspaceId, 'department.read', { workspaceId, departmentId: cairo.id })).toBe(true);
    expect(module.authorizeResource(treeUser.user.id, workspaceId, 'department.read', { workspaceId, departmentId: support.id })).toBe(false);

    expect(module.authorizeResource(workspaceUser.user.id, workspaceId, 'department.read', { workspaceId, departmentId: support.id })).toBe(true);
    expectCode(() => module.authorizeResource(deniedUser.user.id, workspaceId, 'department.read', { workspaceId, departmentId: sales.id }), 'PERMISSION_DENIED');
    expectCode(() => module.authorizeResource(workspaceUser.user.id, workspaceId, 'department.read', { workspaceId: owner.context.workspace.id + '-other' }), 'PERMISSION_DENIED');
  });
});

describe('User module and invitations', () => {
  it('handles invitation lifecycle, profile PUT/PATCH semantics, member removal and global deletion safeguards', () => {
    const module = new AuthModule();
    const owner = verified(module, 'user-owner@example.com');
    const ownerId = owner.context.user.id;
    const workspaceId = owner.context.workspace.id;
    const role = module.createRole(ownerId, workspaceId, { name: 'Agent' });

    expectCode(() => module.inviteUser(ownerId, workspaceId, { email: 'invitee@example.com' }), 'ROLE_REQUIRED');
    const accepted = inviteAndAccept(module, ownerId, workspaceId, role.id, 'invitee@example.com');
    expect(accepted.membership.roleId).toBe(role.id);
    expect(inviteAndAccept(module, ownerId, workspaceId, role.id, 'invitee@example.com').user.id).toBe(accepted.user.id);

    module.updateUser(accepted.user.id, accepted.user.id, { firstName: 'Patched' });
    expect(module.state.users.find((u) => u.id === accepted.user.id)!.lastName).toBe('Ali');
    module.updateUser(accepted.user.id, accepted.user.id, { firstName: 'Put', settings: { language: 'en' } }, true);
    expect(module.state.users.find((u) => u.id === accepted.user.id)!.lastName).toBe('');

    const otherWorkspace = module.createWorkspace(accepted.user.id, { name: 'Other Membership' });
    module.removeWorkspaceMember(ownerId, workspaceId, accepted.user.id);
    expect(module.state.users.some((u) => u.id === accepted.user.id && !u.isDeleted)).toBe(true);
    expect(module.state.memberships.some((m) => m.userId === accepted.user.id && m.workspaceId === otherWorkspace.id && !m.isDeleted)).toBe(true);
    expectCode(() => module.hardDeleteUser(ownerId, accepted.user.id), 'PERMISSION_DENIED');

    module.makePlatformAdmin(ownerId);
    module.softDeleteUser(ownerId, accepted.user.id);
    module.hardDeleteUser(ownerId, accepted.user.id);
    expect(module.state.auditLogs.some((l) => l.entityId === accepted.user.id && l.action === 'USER.HARD_DELETED')).toBe(true);
  });
});

describe('Department module', () => {
  it('supports hierarchy, dynamic query, moves, cycle prevention, delete/restore and members', () => {
    const module = new AuthModule();
    const owner = verified(module, 'dept-owner@example.com');
    const ownerId = owner.context.user.id;
    const workspaceId = owner.context.workspace.id;
    const role = module.createRole(ownerId, workspaceId, { name: 'Member' });
    const member = inviteAndAccept(module, ownerId, workspaceId, role.id, 'dept-member@example.com');

    const sales = module.createDepartment(ownerId, workspaceId, { name: 'Sales' });
    const egypt = module.createDepartment(ownerId, workspaceId, { name: 'Egypt', parentDepartmentId: sales.id });
    const cairo = module.createDepartment(ownerId, workspaceId, { name: 'Cairo', parentDepartmentId: egypt.id });
    const enterprise = module.createDepartment(ownerId, workspaceId, { name: 'Enterprise', parentDepartmentId: cairo.id });

    expect(module.children(workspaceId, sales.id).map((d) => d.id)).toEqual([egypt.id]);
    expect(module.descendants(workspaceId, sales.id).map((d) => d.id)).toEqual([egypt.id, cairo.id, enterprise.id]);
    expect(module.ancestors(workspaceId, enterprise.id).map((d) => d.id)).toEqual([sales.id, egypt.id, cairo.id]);
    expectCode(() => module.moveDepartment(ownerId, workspaceId, sales.id, enterprise.id), 'DEPARTMENT_CYCLE');
    expectCode(() => module.createDepartment(ownerId, workspaceId, { name: 'Egypt', parentDepartmentId: sales.id }), 'DEPARTMENT_SIBLING_NAME_EXISTS');
    expectCode(() => module.softDeleteDepartment(ownerId, workspaceId, sales.id), 'DEPARTMENT_HAS_CHILDREN');

    module.moveDepartment(ownerId, workspaceId, enterprise.id, null);
    expect(module.ancestors(workspaceId, enterprise.id)).toEqual([]);
    expect(module.listDepartments(ownerId, workspaceId, { search: 'ent' }).data).toHaveLength(1);

    module.bulkAddDepartmentMembers(ownerId, workspaceId, cairo.id, [member.user.id]);
    module.bulkAddDepartmentMembers(ownerId, workspaceId, egypt.id, [member.user.id]);
    expect(module.state.departmentMembers.filter((m) => m.userId === member.user.id && !m.isDeleted)).toHaveLength(2);
    expectCode(() => module.bulkAddDepartmentMembers(ownerId, workspaceId, cairo.id, ['missing-user']), 'MEMBERSHIP_NOT_FOUND');
    expectCode(() => module.bulkAddDepartmentMembers(ownerId, workspaceId, enterprise.id, [member.user.id, 'missing-user']), 'MEMBERSHIP_NOT_FOUND');
    expect(module.state.departmentMembers.some((m) => m.departmentId === enterprise.id && m.userId === member.user.id && !m.isDeleted)).toBe(false);
  });
});

describe('Partner and audit modules', () => {
  it('keeps partner membership separate, approves applications atomically, provisions customer workspaces and manages access', () => {
    const module = new AuthModule();
    const admin = verified(module, 'admin@example.com');
    module.makePlatformAdmin(admin.context.user.id);

    const application = module.submitPartnerApplication({
      firstName: 'Partner',
      lastName: 'Owner',
      email: 'partner@example.com',
      phone: '+200000000',
      partnerName: 'Acme Partner',
      country: 'EG',
      website: 'https://example.com',
      businessDescription: 'Implementation partner',
      acceptedTerms: true,
    });
    expectCode(() => module.approvePartnerApplication(application.userId, application.id), 'PERMISSION_DENIED');
    const partner = module.approvePartnerApplication(admin.context.user.id, application.id);
    module.updatePartnerDiscount(admin.context.user.id, partner.id, 12, { Subscription: 20 });
    expect(module.state.partners[0].discountOverrides.Subscription).toBe(20);

    const customer = verified(module, 'customer@example.com');
    const workspace = module.provisionCustomerWorkspace(application.userId, partner.id, customer.context.user.id, 'Customer Workspace');
    expect(workspace.ownerUserId).toBe(customer.context.user.id);
    expect(module.state.memberships.some((m) => m.userId === application.userId && m.workspaceId === workspace.id)).toBe(false);
    expectCode(() => module.getWorkspace(application.userId, workspace.id), 'MEMBERSHIP_NOT_FOUND');

    const access = module.grantPartnerWorkspaceAccess(customer.context.user.id, partner.id, workspace.id);
    module.revokePartnerWorkspaceAccess(customer.context.user.id, access.id);
    expect(module.state.partnerWorkspaceRelations.find((r) => r.workspaceId === workspace.id)!.status).toBe('ACTIVE');
    expect(module.state.partnerWorkspaceAccess.find((a) => a.id === access.id)!.status).toBe('REVOKED');
  });

  it('enforces immutable audit access, filtering, sanitization and transaction rollback on audit failure', () => {
    const module = new AuthModule();
    const owner = verified(module, 'audit-owner@example.com');
    const workspaceId = owner.context.workspace.id;

    module.failNextAuditInsert = true;
    expectCode(() => module.createWorkspace(owner.context.user.id, { name: 'Should Roll Back' }), 'AUDIT_INSERT_FAILED');
    expect(module.state.workspaces.map((w) => w.name)).not.toContain('Should Roll Back');

    const logs = module.listAuditLogs(owner.context.user.id, workspaceId, { filter: { action: { eq: 'WORKSPACE.CREATED' } }, sortBy: 'occurredAt', sortOrder: 'desc' });
    expect(logs.data).toHaveLength(1);
    expect(JSON.stringify(module.state.auditLogs)).not.toMatch(/Password1|verificationToken|refreshToken/);

    const foreign = verified(module, 'audit-foreign@example.com');
    expect(module.listAuditLogs(foreign.context.user.id, foreign.context.workspace.id).data.some((l) => l.workspaceId === workspaceId)).toBe(false);
    expect((module as any).createAuditLog).toBeUndefined();
    expect((module as any).updateAuditLog).toBeUndefined();
    expect((module as any).deleteAuditLog).toBeUndefined();
  });
});
