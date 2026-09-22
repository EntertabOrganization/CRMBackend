import 'reflect-metadata';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { ApiExceptionFilter } from '../src/modules/auth/http/api-exception.filter';
import { AuthDomainService } from '../src/modules/auth/http/auth-domain.service';

describe('Auth module HTTP API', () => {
  let app: NestFastifyApplication;
  let auth: AuthDomainService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new ApiExceptionFilter());
    auth = moduleRef.get(AuthDomainService);
    auth.reset();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function api(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, options: { body?: unknown; token?: string; workspaceId?: string; status?: number } = {}) {
    const response = await app.inject({
      method,
      url,
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.workspaceId ? { 'x-workspace-id': options.workspaceId } : {}),
      },
      payload: options.body as any,
    });
    expect(response.statusCode).toBe(options.status ?? 200);
    return response.json();
  }

  async function signupAndVerify(email: string) {
    const signup = await api('POST', '/api/v1/auth/signup', {
      body: { firstName: 'Faris', lastName: 'Hassan', email, password: 'Password1' },
    });
    const verified = await api('POST', '/api/v1/auth/verify-email', { body: { token: signup.data.verificationToken } });
    return verified.data;
  }

  it('runs signup, verification, signin, current-session and refresh through /api/v1/auth', async () => {
    const session = await signupAndVerify('api-auth@example.com');
    expect(session.context.workspace.name).toBe("Faris's Workspace");
    expect(session.context.role.isOwnerRole).toBe(true);

    const signin = await api('POST', '/api/v1/auth/signin', { body: { email: ' API-AUTH@example.com ', password: 'Password1' } });
    expect(signin.data.context.user.email).toBe('api-auth@example.com');

    const me = await api('GET', '/api/v1/auth/me', { token: signin.data.accessToken });
    expect(me.data.workspace.id).toBe(session.context.workspace.id);

    const refreshed = await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: signin.data.refreshToken } });
    await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: signin.data.refreshToken }, status: 401 });
    expect(refreshed.data.refreshToken).not.toBe(signin.data.refreshToken);
  });

  it('does not expose stored password hashes or token hashes in API responses', async () => {
    const signup = await api('POST', '/api/v1/auth/signup', {
      body: { firstName: 'Secret', lastName: 'Safe', email: 'secret-safe@example.com', password: 'Password1' },
    });
    const verify = await api('POST', '/api/v1/auth/verify-email', { body: { token: signup.data.verificationToken } });
    const signin = await api('POST', '/api/v1/auth/signin', { body: { email: 'secret-safe@example.com', password: 'Password1' } });
    const forgot = await api('POST', '/api/v1/auth/forgot-password', { body: { email: 'secret-safe@example.com' } });
    const me = await api('GET', '/api/v1/auth/me', { token: signin.data.accessToken });

    const serialized = JSON.stringify({ signup, verify, signin, forgot, me });
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('tokenHash');
    expect(serialized).not.toContain('scrypt:');
    expect(serialized).not.toContain(auth.state.identities[0]?.passwordHash);
    expect(serialized).not.toContain(auth.state.refreshSessions[0]?.tokenHash);
    expect(serialized).not.toContain(auth.state.verificationTokens[0]?.tokenHash);
  });

  it('exposes workspace routes and rejects cross-workspace access by membership', async () => {
    const owner = await signupAndVerify('api-workspace@example.com');
    const foreign = await signupAndVerify('api-foreign@example.com');

    const created = await api('POST', '/api/v1/workspaces', { token: owner.accessToken, body: { name: 'Operations' } });
    expect(created.data.slug).toBe('operations');

    const list = await api('GET', '/api/v1/workspaces', { token: owner.accessToken });
    expect(list.data.map((w: any) => w.id)).toEqual(expect.arrayContaining([owner.context.workspace.id, created.data.id]));

    await api('GET', `/api/v1/workspaces/${foreign.context.workspace.id}`, { token: owner.accessToken, status: 404 });

    const switched = await api('POST', `/api/v1/workspaces/${created.data.id}/switch`, { token: owner.accessToken });
    expect(switched.data.workspace.id).toBe(created.data.id);
  });

  it('supports workspace member suspend and reactivate over HTTP', async () => {
    const owner = await signupAndVerify('api-member-owner@example.com');
    const workspaceId = owner.context.workspace.id;
    const role = auth.createRole(owner.context.user.id, workspaceId, { name: 'Workspace Member' });
    const invite = await api('POST', '/api/v1/users', {
      token: owner.accessToken,
      workspaceId,
      body: { email: 'api-workspace-member@example.com', roleId: role.id },
    });
    const member = await api('POST', '/api/v1/users/invitations/accept', {
      body: { token: invite.data.invitationToken, email: 'api-workspace-member@example.com', firstName: 'Member', lastName: 'User', password: 'Password1' },
    });
    const memberSignin = await api('POST', '/api/v1/auth/signin', {
      body: { email: 'api-workspace-member@example.com', password: 'Password1' },
    });

    await api('PATCH', `/api/v1/workspaces/${workspaceId}/members/${member.data.user.id}/suspend`, { token: owner.accessToken });
    await api('GET', `/api/v1/workspaces/${workspaceId}`, { token: memberSignin.data.accessToken, status: 404 });

    await api('PATCH', `/api/v1/workspaces/${workspaceId}/members/${member.data.user.id}/reactivate`, { token: owner.accessToken });
    const restored = await api('GET', `/api/v1/workspaces/${workspaceId}`, { token: memberSignin.data.accessToken });
    expect(restored.data.id).toBe(workspaceId);
    expect(auth.state.auditLogs.map((l) => l.action)).toEqual(expect.arrayContaining(['WORKSPACE.MEMBER_SUSPENDED', 'WORKSPACE.MEMBER_REACTIVATED']));
  });

  it('protects Owner/Admin role assignment and transfers ownership explicitly', async () => {
    const owner = await signupAndVerify('api-transfer-owner@example.com');
    const workspaceId = owner.context.workspace.id;
    const ownerRoleId = owner.context.role.id;
    const memberRole = auth.createRole(owner.context.user.id, workspaceId, { name: 'Transfer Target' });

    await api('POST', '/api/v1/users', {
      token: owner.accessToken,
      workspaceId,
      body: { email: 'api-owner-role-invite@example.com', roleId: ownerRoleId },
      status: 409,
    });
    await api('DELETE', `/api/v1/users/${owner.context.user.id}/workspace-membership`, { token: owner.accessToken, workspaceId, status: 409 });

    const invite = await api('POST', '/api/v1/users', {
      token: owner.accessToken,
      workspaceId,
      body: { email: 'api-transfer-target@example.com', roleId: memberRole.id },
    });
    const target = await api('POST', '/api/v1/users/invitations/accept', {
      body: { token: invite.data.invitationToken, email: 'api-transfer-target@example.com', firstName: 'Target', lastName: 'Owner', password: 'Password1' },
    });

    await api('POST', `/api/v1/workspaces/${workspaceId}/transfer-owner`, {
      token: owner.accessToken,
      body: { targetUserId: target.data.user.id },
    });

    const workspace = auth.state.workspaces.find((w) => w.id === workspaceId)!;
    const ownerRoleMemberships = auth.state.memberships.filter((m) => m.workspaceId === workspaceId && m.roleId === ownerRoleId && !m.isDeleted);
    const formerOwnerMembership = auth.state.memberships.find((m) => m.workspaceId === workspaceId && m.userId === owner.context.user.id && !m.isDeleted)!;
    expect(workspace.ownerUserId).toBe(target.data.user.id);
    expect(ownerRoleMemberships).toHaveLength(1);
    expect(ownerRoleMemberships[0].userId).toBe(target.data.user.id);
    expect(formerOwnerMembership.roleId).not.toBe(ownerRoleId);
    expect(auth.state.auditLogs.map((l) => l.action)).toEqual(expect.arrayContaining(['WORKSPACE.OWNER_TRANSFERRED', 'USER.ROLE_CHANGED']));
  });

  it('retains audit log rows after referenced workspace hard deletion', async () => {
    const owner = await signupAndVerify('api-audit-retention@example.com');
    const workspace = await api('POST', '/api/v1/workspaces', { token: owner.accessToken, body: { name: 'Audit Retention Workspace' } });
    await api('DELETE', `/api/v1/workspaces/${workspace.data.id}`, { token: owner.accessToken });
    await api('DELETE', `/api/v1/workspaces/${workspace.data.id}/hard`, { token: owner.accessToken });

    const retained = auth.state.auditLogs.filter((log) => log.workspaceId === workspace.data.id);
    expect(retained.map((log) => log.action)).toEqual(expect.arrayContaining(['WORKSPACE.CREATED', 'WORKSPACE.SOFT_DELETED', 'WORKSPACE.HARD_DELETED']));
  });

  it('supports role invitation, user listing, departments, department members and audit logs over HTTP', async () => {
    const owner = await signupAndVerify('api-owner@example.com');
    const workspaceId = owner.context.workspace.id;
    const departmentRead = auth.state.permissions.find((p) => p.key === 'department.read')!;
    const role = auth.createRole(owner.context.user.id, workspaceId, { name: 'Agent', permissions: [{ permissionId: departmentRead.id, scope: 'WORKSPACE' }] });

    const invite = await api('POST', '/api/v1/users', {
      token: owner.accessToken,
      workspaceId,
      body: { email: 'api-invitee@example.com', roleId: role.id },
    });
    const accepted = await api('POST', '/api/v1/users/invitations/accept', {
      body: { token: invite.data.invitationToken, email: 'api-invitee@example.com', firstName: 'Mona', lastName: 'Ali', password: 'Password1' },
    });

    const users = await api('GET', '/api/v1/users?search=mona', { token: owner.accessToken, workspaceId });
    expect(users.data[0].email).toBe('api-invitee@example.com');

    const sales = await api('POST', '/api/v1/departments', { token: owner.accessToken, workspaceId, body: { name: 'Sales' } });
    const cairo = await api('POST', `/api/v1/departments/${sales.data.id}/sub-departments`, { token: owner.accessToken, workspaceId, body: { name: 'Cairo' } });
    await api('POST', '/api/v1/department-members', {
      token: owner.accessToken,
      workspaceId,
      body: { departmentId: cairo.data.id, userIds: [accepted.data.user.id] },
    });

    const descendants = await api('GET', `/api/v1/departments/${sales.data.id}/descendants`, { token: owner.accessToken, workspaceId });
    expect(descendants.data.map((d: any) => d.name)).toEqual(['Cairo']);

    const logs = await api('GET', '/api/v1/audit-logs?filter[action][eq]=DEPARTMENT.CREATED&page=1&limit=5&sortBy=action&sortOrder=asc', { token: owner.accessToken, workspaceId });
    expect(logs.meta).toMatchObject({ page: 1, limit: 5 });
    expect(logs.data.length).toBeGreaterThan(0);
    expect(logs.data.every((l: any) => l.action === 'DEPARTMENT.CREATED')).toBe(true);
  });

  it('enforces department manager eligibility and manager removal protection over HTTP', async () => {
    const owner = await signupAndVerify('api-manager-owner@example.com');
    const workspaceId = owner.context.workspace.id;
    const role = auth.createRole(owner.context.user.id, workspaceId, { name: 'Manager Candidate' });
    const invite = await api('POST', '/api/v1/users', {
      token: owner.accessToken,
      workspaceId,
      body: { email: 'api-manager@example.com', roleId: role.id },
    });
    const manager = await api('POST', '/api/v1/users/invitations/accept', {
      body: { token: invite.data.invitationToken, email: 'api-manager@example.com', firstName: 'Manager', lastName: 'Candidate', password: 'Password1' },
    });
    const department = await api('POST', '/api/v1/departments', { token: owner.accessToken, workspaceId, body: { name: 'Managed Department' } });

    await api('PATCH', `/api/v1/departments/${department.data.id}`, {
      token: owner.accessToken,
      workspaceId,
      body: { managerId: manager.data.user.id },
      status: 400,
    });

    await api('POST', '/api/v1/department-members', {
      token: owner.accessToken,
      workspaceId,
      body: { departmentId: department.data.id, userIds: [manager.data.user.id] },
    });
    const assigned = await api('PATCH', `/api/v1/departments/${department.data.id}`, {
      token: owner.accessToken,
      workspaceId,
      body: { managerId: manager.data.user.id },
    });
    expect(assigned.data.managerId).toBe(manager.data.user.id);

    await api('DELETE', `/api/v1/department-members/${department.data.id}/${manager.data.user.id}`, {
      token: owner.accessToken,
      workspaceId,
      status: 400,
    });
    const cleared = await api('PATCH', `/api/v1/departments/${department.data.id}`, {
      token: owner.accessToken,
      workspaceId,
      body: { managerId: null },
    });
    expect(cleared.data.managerId).toBeNull();
    await api('DELETE', `/api/v1/department-members/${department.data.id}/${manager.data.user.id}`, { token: owner.accessToken, workspaceId });
    expect(auth.state.auditLogs.map((l) => l.action)).toEqual(expect.arrayContaining(['DEPARTMENT.MANAGER_ASSIGNED', 'DEPARTMENT.MANAGER_CLEARED', 'DEPARTMENT.MEMBER_REMOVED']));
  });

  it('supports role and department-member lifecycle endpoints over HTTP', async () => {
    const owner = await signupAndVerify('api-lifecycle@example.com');
    const workspaceId = owner.context.workspace.id;
    const token = owner.accessToken;
    const departmentRead = auth.state.permissions.find((p) => p.key === 'department.read')!;

    const role = await api('POST', '/api/v1/roles', {
      token,
      workspaceId,
      body: { name: 'Lifecycle Role', description: 'temporary', permissions: [{ permissionId: departmentRead.id, scope: 'WORKSPACE' }] },
    });
    expect(role.data.name).toBe('Lifecycle Role');

    const roles = await api('GET', '/api/v1/roles?search=Lifecycle', { token, workspaceId });
    expect(roles.data.map((r: any) => r.id)).toContain(role.data.id);

    const patched = await api('PATCH', `/api/v1/roles/${role.data.id}`, { token, workspaceId, body: { description: 'patched' } });
    expect(patched.data.description).toBe('patched');

    const replaced = await api('PUT', `/api/v1/roles/${role.data.id}`, { token, workspaceId, body: { name: 'Lifecycle Replaced', description: null } });
    expect(replaced.data.name).toBe('Lifecycle Replaced');

    await api('PUT', `/api/v1/roles/${role.data.id}/permissions`, {
      token,
      workspaceId,
      body: { permissions: [{ permissionId: departmentRead.id, scope: 'DEPARTMENT' }] },
    });

    await api('DELETE', `/api/v1/roles/${role.data.id}/hard`, { token, workspaceId, status: 409 });
    await api('DELETE', `/api/v1/roles/${role.data.id}`, { token, workspaceId });
    await api('PATCH', `/api/v1/roles/${role.data.id}/restore`, { token, workspaceId });
    await api('DELETE', `/api/v1/roles/${role.data.id}`, { token, workspaceId });
    await api('DELETE', `/api/v1/roles/${role.data.id}/hard`, { token, workspaceId });
    expect(auth.state.auditLogs.map((l) => l.action)).toEqual(expect.arrayContaining(['ROLE.RESTORED', 'ROLE.HARD_DELETED']));

    const memberRole = auth.createRole(owner.context.user.id, workspaceId, { name: 'Member Role' });
    const invite = await api('POST', '/api/v1/users', {
      token,
      workspaceId,
      body: { email: 'api-member-lifecycle@example.com', roleId: memberRole.id },
    });
    const accepted = await api('POST', '/api/v1/users/invitations/accept', {
      body: { token: invite.data.invitationToken, email: 'api-member-lifecycle@example.com', firstName: 'Nour', lastName: 'Ali', password: 'Password1' },
    });
    const department = await api('POST', '/api/v1/departments', { token, workspaceId, body: { name: 'Lifecycle Department' } });
    const memberCreate = await api('POST', '/api/v1/department-members', {
      token,
      workspaceId,
      body: { departmentId: department.data.id, userIds: [accepted.data.user.id] },
    });
    const memberId = memberCreate.data[0].id;

    const members = await api('GET', `/api/v1/department-members?filter[departmentId][eq]=${department.data.id}`, { token, workspaceId });
    expect(members.data.map((m: any) => m.id)).toContain(memberId);

    await api('DELETE', `/api/v1/department-members/${memberId}/hard`, { token, workspaceId, status: 409 });
    await api('DELETE', `/api/v1/department-members/${department.data.id}/${accepted.data.user.id}`, { token, workspaceId });
    await api('PATCH', `/api/v1/department-members/${memberId}/restore`, { token, workspaceId });
    await api('DELETE', `/api/v1/department-members/${department.data.id}/${accepted.data.user.id}`, { token, workspaceId });
    await api('DELETE', `/api/v1/department-members/${memberId}/hard`, { token, workspaceId });
    expect(auth.state.departmentMembers.some((m) => m.id === memberId)).toBe(false);

    await api('PUT', `/api/v1/departments/${department.data.id}`, {
      token,
      workspaceId,
      body: { name: 'Lifecycle Department Replaced', description: null },
    });
    await api('DELETE', `/api/v1/departments/${department.data.id}/hard`, { token, workspaceId, status: 409 });
    await api('DELETE', `/api/v1/departments/${department.data.id}`, { token, workspaceId });
    await api('PATCH', `/api/v1/departments/${department.data.id}/restore`, { token, workspaceId });
    await api('DELETE', `/api/v1/departments/${department.data.id}`, { token, workspaceId });
    await api('DELETE', `/api/v1/departments/${department.data.id}/hard`, { token, workspaceId });
    expect(auth.state.auditLogs.map((l) => l.action)).toEqual(expect.arrayContaining(['DEPARTMENT.RESTORED', 'DEPARTMENT.HARD_DELETED', 'DEPARTMENT.MEMBER_HARD_DELETED']));
  });

  it('supports platform user lifecycle endpoints over HTTP', async () => {
    const admin = await signupAndVerify('api-user-admin@example.com');
    auth.makePlatformAdmin(admin.context.user.id);
    const target = await signupAndVerify('api-user-target@example.com');

    await api('PATCH', `/api/v1/users/${target.context.user.id}/suspend`, { token: admin.accessToken });
    await api('POST', '/api/v1/auth/signin', { body: { email: 'api-user-target@example.com', password: 'Password1' }, status: 400 });

    await api('PATCH', `/api/v1/users/${target.context.user.id}/reactivate`, { token: admin.accessToken });
    await api('POST', '/api/v1/auth/signin', { body: { email: 'api-user-target@example.com', password: 'Password1' } });

    await api('DELETE', `/api/v1/users/${target.context.user.id}/hard`, { token: admin.accessToken, status: 409 });
    await api('DELETE', `/api/v1/users/${target.context.user.id}`, { token: admin.accessToken });
    await api('PATCH', `/api/v1/users/${target.context.user.id}/restore`, { token: admin.accessToken });
    await api('DELETE', `/api/v1/users/${target.context.user.id}`, { token: admin.accessToken });
    await api('DELETE', `/api/v1/users/${target.context.user.id}/hard`, { token: admin.accessToken });

    expect(auth.state.users.some((u) => u.id === target.context.user.id)).toBe(false);
    expect(auth.state.auditLogs.map((l) => l.action)).toEqual(expect.arrayContaining(['USER.SUSPENDED', 'USER.REACTIVATED', 'USER.RESTORED', 'USER.HARD_DELETED']));
  });

  it('supports invitation resend, revoke and reject lifecycle over HTTP', async () => {
    const owner = await signupAndVerify('api-invite-owner@example.com');
    const workspaceId = owner.context.workspace.id;
    const token = owner.accessToken;
    const role = auth.createRole(owner.context.user.id, workspaceId, { name: 'Invite Role' });

    const invite = await api('POST', '/api/v1/users', {
      token,
      workspaceId,
      body: { email: 'api-resend@example.com', roleId: role.id },
    });
    const resent = await api('POST', `/api/v1/users/invitations/${invite.data.invitation.id}/resend`, { token, workspaceId });
    expect(resent.data.invitationToken).not.toBe(invite.data.invitationToken);
    await api('POST', '/api/v1/users/invitations/accept', {
      body: { token: invite.data.invitationToken, email: 'api-resend@example.com', firstName: 'Old', lastName: 'Token', password: 'Password1' },
      status: 404,
    });
    const accepted = await api('POST', '/api/v1/users/invitations/accept', {
      body: { token: resent.data.invitationToken, email: 'api-resend@example.com', firstName: 'New', lastName: 'Token', password: 'Password1' },
    });
    expect(accepted.data.user.email).toBe('api-resend@example.com');

    const revokeInvite = await api('POST', '/api/v1/users', {
      token,
      workspaceId,
      body: { email: 'api-revoke@example.com', roleId: role.id },
    });
    await api('DELETE', `/api/v1/users/invitations/${revokeInvite.data.invitation.id}`, { token, workspaceId });
    await api('POST', '/api/v1/users/invitations/accept', {
      body: { token: revokeInvite.data.invitationToken, email: 'api-revoke@example.com', firstName: 'Revoked', lastName: 'Invite', password: 'Password1' },
      status: 404,
    });

    const rejectInvite = await api('POST', '/api/v1/users', {
      token,
      workspaceId,
      body: { email: 'api-reject@example.com', roleId: role.id },
    });
    await api('POST', '/api/v1/users/invitations/reject', {
      body: { token: rejectInvite.data.invitationToken, email: 'api-reject@example.com' },
    });
    await api('POST', '/api/v1/users/invitations/accept', {
      body: { token: rejectInvite.data.invitationToken, email: 'api-reject@example.com', firstName: 'Rejected', lastName: 'Invite', password: 'Password1' },
      status: 404,
    });

    expect(auth.state.auditLogs.map((l) => l.action)).toEqual(expect.arrayContaining(['USER.INVITATION_RESENT', 'USER.INVITATION_REVOKED', 'USER.INVITATION_REJECTED']));
  });

  it('supports Google auth and partner approval flows through HTTP plus provider/platform test hooks', async () => {
    const admin = await signupAndVerify('api-admin@example.com');
    auth.makePlatformAdmin(admin.context.user.id);
    auth.googleVerifier = async () => ({
      email: 'google-api@example.com',
      emailVerified: true,
      providerUserId: 'google-api-1',
      firstName: 'Google',
      lastName: 'User',
    });

    const google = await api('POST', '/api/v1/auth/google/signup', { body: { credential: 'valid' } });
    expect(google.data.context.user.status).toBe('ACTIVE');

    const application = await api('POST', '/api/v1/partners/applications', {
      body: {
        firstName: 'Partner',
        lastName: 'Owner',
        email: 'partner-api@example.com',
        phone: '+200000000',
        partnerName: 'Partner API',
        country: 'EG',
        website: 'https://example.com',
        businessDescription: 'Partner services',
        acceptedTerms: true,
      },
    });
    const applications = await api('GET', '/api/v1/partners/applications?filter[status][eq]=PENDING&search=Partner API', { token: admin.accessToken });
    expect(applications.data.map((a: any) => a.id)).toContain(application.data.id);

    const approved = await api('POST', `/api/v1/partners/applications/${application.data.id}/approve`, { token: admin.accessToken });
    expect(approved.data.name).toBe('Partner API');

    const platformPartners = await api('GET', '/api/v1/partners?filter[country][eq]=EG&search=Partner', { token: admin.accessToken });
    expect(platformPartners.data.map((p: any) => p.id)).toContain(approved.data.id);

    const partnerScoped = await api('GET', `/api/v1/partners/${approved.data.id}`, { token: google.data.accessToken, status: 403 });
    expect(partnerScoped.error.code).toBe('PERMISSION_DENIED');
    const applicantUser = auth.state.users.find((u) => u.email === 'partner-api@example.com')!;
    const applicantSession = auth.verifyEmail(auth.resendVerification('partner-api@example.com').verificationToken!);
    expect(applicantSession.context.user.id).toBe(applicantUser.id);
    const ownPartner = await api('GET', `/api/v1/partners/${approved.data.id}`, { token: applicantSession.accessToken });
    expect(ownPartner.data.id).toBe(approved.data.id);

    const customer = await signupAndVerify('api-partner-customer@example.com');
    const provisioned = await api('POST', `/api/v1/partners/${approved.data.id}/customer-workspaces`, {
      token: applicantSession.accessToken,
      body: { customerUserId: customer.context.user.id, name: 'Partner Customer Workspace' },
    });
    const noDelegatedAccess = await api('GET', `/api/v1/partners/${approved.data.id}/workspaces/${provisioned.data.id}/access`, { token: applicantSession.accessToken });
    expect(noDelegatedAccess.data.allowed).toBe(false);

    const delegatedAccess = await api('POST', `/api/v1/partners/${approved.data.id}/workspaces/${provisioned.data.id}/access`, { token: customer.accessToken });
    const withDelegatedAccess = await api('GET', `/api/v1/partners/${approved.data.id}/workspaces/${provisioned.data.id}/access`, { token: applicantSession.accessToken });
    expect(withDelegatedAccess.data.allowed).toBe(true);

    await api('DELETE', `/api/v1/partners/workspace-access/${delegatedAccess.data.id}`, { token: customer.accessToken });
    const revokedDelegatedAccess = await api('GET', `/api/v1/partners/${approved.data.id}/workspaces/${provisioned.data.id}/access`, { token: applicantSession.accessToken });
    expect(revokedDelegatedAccess.data.allowed).toBe(false);

    const secondApplication = await api('POST', '/api/v1/partners/applications', {
      body: {
        firstName: 'Second',
        lastName: 'Partner',
        email: 'second-partner-api@example.com',
        phone: '+200000001',
        partnerName: 'Second Partner API',
        country: 'EG',
        businessDescription: 'Second partner services',
        acceptedTerms: true,
      },
    });
    const secondPartner = await api('POST', `/api/v1/partners/applications/${secondApplication.data.id}/approve`, { token: admin.accessToken });
    await api('POST', `/api/v1/partners/${secondPartner.data.id}/workspaces/${provisioned.data.id}/relation`, { token: admin.accessToken, status: 409 });
    const activeRelation = auth.state.partnerWorkspaceRelations.find((r) => r.partnerId === approved.data.id && r.workspaceId === provisioned.data.id)!;
    await api('DELETE', `/api/v1/partners/workspace-relations/${activeRelation.id}`, { token: admin.accessToken });
    const replacementRelation = await api('POST', `/api/v1/partners/${secondPartner.data.id}/workspaces/${provisioned.data.id}/relation`, { token: admin.accessToken });
    expect(replacementRelation.data.partnerId).toBe(secondPartner.data.id);

    const updated = await api('PATCH', `/api/v1/partners/${approved.data.id}`, { token: admin.accessToken, body: { website: 'https://partner.example.com' } });
    expect(updated.data.website).toBe('https://partner.example.com');

    const replaced = await api('PUT', `/api/v1/partners/${approved.data.id}`, {
      token: admin.accessToken,
      body: { name: 'Partner API Replaced', country: 'EG', website: null, businessDescription: 'Updated services' },
    });
    expect(replaced.data.name).toBe('Partner API Replaced');

    await api('PATCH', `/api/v1/partners/${approved.data.id}/suspend`, { token: admin.accessToken });
    expect(auth.state.partners.find((p) => p.id === approved.data.id)!.status).toBe('SUSPENDED');
    await api('PATCH', `/api/v1/partners/${approved.data.id}/reactivate`, { token: admin.accessToken });
    expect(auth.state.partners.find((p) => p.id === approved.data.id)!.status).toBe('ACTIVE');

    await api('DELETE', `/api/v1/partners/${approved.data.id}/hard`, { token: admin.accessToken, status: 409 });
    await api('DELETE', `/api/v1/partners/${approved.data.id}`, { token: admin.accessToken });
    await api('PATCH', `/api/v1/partners/${approved.data.id}/restore`, { token: admin.accessToken });
    await api('DELETE', `/api/v1/partners/${approved.data.id}`, { token: admin.accessToken });
    await api('DELETE', `/api/v1/partners/${approved.data.id}/hard`, { token: admin.accessToken });
    expect(auth.state.partners.some((p) => p.id === approved.data.id)).toBe(false);
    expect(auth.state.auditLogs.map((l) => l.action)).toEqual(expect.arrayContaining(['PARTNER.UPDATED', 'PARTNER.SUSPENDED', 'PARTNER.REACTIVATED', 'PARTNER.RESTORED', 'PARTNER.HARD_DELETED']));
  });

  it('uses the stable API error shape', async () => {
    const response = await api('POST', '/api/v1/auth/signup', {
      body: { firstName: 'Bad', lastName: 'Password', email: 'bad@example.com', password: 'weak' },
      status: 409,
    });
    expect(response).toMatchObject({
      success: false,
      error: { code: 'WEAK_PASSWORD' },
      requestId: expect.any(String),
    });
  });

  it('rate limits repeated auth-sensitive attempts', async () => {
    for (let index = 0; index < 10; index += 1) {
      await api('POST', '/api/v1/auth/signin', {
        body: { email: 'rate-limit@example.com', password: 'WrongPassword1' },
        status: 401,
      });
    }
    const limited = await api('POST', '/api/v1/auth/signin', {
      body: { email: 'rate-limit@example.com', password: 'WrongPassword1' },
      status: 429,
    });
    expect(limited.error.code).toBe('RATE_LIMITED');
  });
});
