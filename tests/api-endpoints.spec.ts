/**
 * HTTP-level tests for every route handler under app/. Requests go through the real Next route
 * handlers, the real persistence layer and a throwaway Postgres database (entertabcrm_test),
 * which is recreated and migrated at the start of the run.
 */
import { api, coveredAuthenticatedEndpoints, coveredEndpoints, disconnectTestDatabase, discoverEndpoints, prepareTestDatabase } from './support/api';

jest.setTimeout(120_000);

const RUN = Date.now();
const PASSWORD = 'Password1';
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

type Session = {
  token: string;
  refreshToken: string;
  userId: string;
  workspaceId: string;
  email: string;
};

const ws = { owner: undefined as unknown as Session };
const ctx: Record<string, any> = {};

async function register(label: string, domain = 'example.com'): Promise<Session> {
  const email = `apitest-${label}-${RUN}@${domain}`;
  const signup = await api('POST', '/api/v1/auth/signup', {
    body: { firstName: 'Api', lastName: label, email, password: PASSWORD },
  });
  expect(signup.status).toBe(200);
  const verified = await api('POST', '/api/v1/auth/verify-email', { body: { token: signup.data.verificationToken } });
  expect(verified.status).toBe(200);
  return {
    token: verified.data.accessToken,
    refreshToken: verified.data.refreshToken,
    userId: verified.data.user.id,
    workspaceId: verified.data.workspace.id,
    email,
  };
}

function authed(extra: Record<string, unknown> = {}) {
  return { token: ws.owner.token, workspaceId: ws.owner.workspaceId, ...extra } as any;
}

function expectOk(result: { status: number; body: any }, status = 200) {
  if (result.status !== status) throw new Error(`Expected ${status}, got ${result.status}: ${JSON.stringify(result.body)}`);
  expect(result.body.success).toBe(true);
}

function expectError(result: { status: number; body: any }, status: number, code?: string) {
  if (result.status !== status || (code && result.body?.error?.code !== code)) {
    throw new Error(`Expected ${status} ${code ?? ''}, got ${result.status}: ${JSON.stringify(result.body)}`);
  }
  expect(result.body.success).toBe(false);
}

beforeAll(async () => {
  await prepareTestDatabase();
  ws.owner = await register('owner');
});

afterAll(async () => {
  await disconnectTestDatabase();
});

describe('Public routes', () => {
  it('GET / redirects to the API documentation', async () => {
    const res = await api('GET', '/');
    expect([307, 308]).toContain(res.status);
  });

  it('GET /swagger serves the Swagger UI', async () => {
    const res = await api('GET', '/swagger');
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain('html');
  });

  it('GET /api/docs serves the OpenAPI document', async () => {
    const res = await api('GET', '/api/docs');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(Object.keys(res.body.paths).length).toBeGreaterThan(50);
  });
});

describe('Auth', () => {
  it('POST /auth/signup creates a pending user and rejects duplicates and bad input', async () => {
    const email = `apitest-signup-${RUN}@example.com`;
    const created = await api('POST', '/api/v1/auth/signup', { body: { firstName: 'Sign', lastName: 'Up', email, password: PASSWORD } });
    expectOk(created);
    expect(created.data.user.status).toBe('PENDING_VERIFICATION');
    expect(created.data.verificationToken).toBeTruthy();
    ctx.signup = { email, token: created.data.verificationToken };

    expectError(await api('POST', '/api/v1/auth/signup', { body: { firstName: 'Sign', lastName: 'Up', email, password: PASSWORD } }), 409);
    expectError(await api('POST', '/api/v1/auth/signup', { body: { firstName: 'X', lastName: 'Y', email: 'not-an-email', password: PASSWORD } }), 400);
    expectError(await api('POST', '/api/v1/auth/signup', { body: { firstName: 'X', lastName: 'Y', email: `weak-${RUN}@example.com`, password: 'short' } }), 400);
  });

  it('POST /auth/signin refuses unverified users', async () => {
    const res = await api('POST', '/api/v1/auth/signin', { body: { email: ctx.signup.email, password: PASSWORD } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('POST /auth/resend-verification issues a new token and POST /auth/verify-email consumes it', async () => {
    expectOk(await api('POST', '/api/v1/auth/resend-verification', { body: { email: ctx.signup.email } }));
    expectError(await api('POST', '/api/v1/auth/verify-email', { body: { token: 'not-a-real-token' } }), 400);

    const { appContext } = await import('@/src/server/app-context');
    const mail = [...appContext.mailer.sent].reverse().find((item) => item.to === ctx.signup.email && item.token);
    expect(mail).toBeDefined();
    const verified = await api('POST', '/api/v1/auth/verify-email', { body: { token: mail!.token } });
    expectOk(verified);
    expect(verified.data.workspace.id).toBeTruthy();
    expect(verified.data.accessToken).toBeTruthy();
    expect(verified.data.refreshToken).toBeTruthy();
  });

  it('POST /auth/signin returns tokens for valid credentials and 401 otherwise', async () => {
    const good = await api('POST', '/api/v1/auth/signin', { body: { email: ws.owner.email, password: PASSWORD } });
    expectOk(good);
    expect(good.data.accessToken).toBeTruthy();
    expect(good.data.workspace.id).toBe(ws.owner.workspaceId);
    expectError(await api('POST', '/api/v1/auth/signin', { body: { email: ws.owner.email, password: 'WrongPassword1' } }), 401);
    expectError(await api('POST', '/api/v1/auth/signin', { body: { email: `nobody-${RUN}@example.com`, password: PASSWORD } }), 401);
  });

  it('GET /auth/me returns the current user and requires a token', async () => {
    const me = await api('GET', '/api/v1/auth/me', { token: ws.owner.token });
    expectOk(me);
    expect(me.data.user.email).toBe(ws.owner.email);
    expectError(await api('GET', '/api/v1/auth/me'), 401);
    expectError(await api('GET', '/api/v1/auth/me', { token: 'garbage' }), 401);
  });

  it('POST /auth/refresh rotates the refresh token and POST /auth/logout revokes it', async () => {
    const signin = await api('POST', '/api/v1/auth/signin', { body: { email: ws.owner.email, password: PASSWORD } });
    const refreshed = await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: signin.data.refreshToken } });
    expectOk(refreshed);
    expect(refreshed.data.refreshToken).not.toBe(signin.data.refreshToken);
    expectError(await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: 'bogus' } }), 401);

    expectOk(await api('POST', '/api/v1/auth/logout', { body: { refreshToken: refreshed.data.refreshToken } }));
    expectError(await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: refreshed.data.refreshToken } }), 401);
  });

  it('POST /auth/logout-all revokes every session of the user', async () => {
    const user = await register('logoutall');
    const second = await api('POST', '/api/v1/auth/signin', { body: { email: user.email, password: PASSWORD } });
    expectOk(await api('POST', '/api/v1/auth/logout-all', { token: user.token }));
    expectError(await api('POST', '/api/v1/auth/refresh', { body: { refreshToken: second.data.refreshToken } }), 401);
    expectError(await api('POST', '/api/v1/auth/logout-all'), 401);
  });

  it('POST /auth/forgot-password and /auth/reset-password change the password', async () => {
    const user = await register('reset');
    expectOk(await api('POST', '/api/v1/auth/forgot-password', { body: { email: user.email } }));
    // Unknown addresses must not leak whether an account exists.
    expectOk(await api('POST', '/api/v1/auth/forgot-password', { body: { email: `ghost-${RUN}@example.com` } }));

    const { appContext } = await import('@/src/server/app-context');
    const mail = [...appContext.mailer.sent].reverse().find((item) => item.to === user.email && item.subject.startsWith('Reset'));
    expect(mail?.token).toBeTruthy();

    expectError(await api('POST', '/api/v1/auth/reset-password', { body: { token: mail!.token, password: 'weak' } }), 400);
    expectOk(await api('POST', '/api/v1/auth/reset-password', { body: { token: mail!.token, password: 'NewPassword1' } }));
    expectError(await api('POST', '/api/v1/auth/reset-password', { body: { token: mail!.token, password: 'NewPassword2' } }), 400);
    expectOk(await api('POST', '/api/v1/auth/signin', { body: { email: user.email, password: 'NewPassword1' } }));
    expectError(await api('POST', '/api/v1/auth/signin', { body: { email: user.email, password: PASSWORD } }), 401);
  });

  it('POST /auth/google/signup and /auth/google/signin authenticate a verified Google profile', async () => {
    const { appContext } = await import('@/src/server/app-context');
    const email = `apitest-google-${RUN}@example.com`;
    appContext.google.addCredential(`cred-${RUN}`, {
      providerUserId: `google-${RUN}`,
      email,
      emailVerified: true,
      firstName: 'Goo',
      lastName: 'Gle',
    });
    appContext.google.addCredential(`unverified-${RUN}`, {
      providerUserId: `google-unverified-${RUN}`,
      email: `apitest-google-unverified-${RUN}@example.com`,
      emailVerified: false,
      firstName: 'Un',
      lastName: 'Verified',
    });

    const signup = await api('POST', '/api/v1/auth/google/signup', { body: { credential: `cred-${RUN}` } });
    expectOk(signup);
    expect(signup.data.user.email).toBe(email);
    expect(signup.data.workspace.id).toBeTruthy();

    const signin = await api('POST', '/api/v1/auth/google/signin', { body: { credential: `cred-${RUN}` } });
    expectOk(signin);
    expect(signin.data.user.id).toBe(signup.data.user.id);

    expectError(await api('POST', '/api/v1/auth/google/signin', { body: { credential: 'unknown' } }), 401);
    expectError(await api('POST', '/api/v1/auth/google/signup', { body: { credential: `unverified-${RUN}` } }), 403);
  });
});

describe('Permissions and roles', () => {
  it('GET /permissions lists the permission catalog', async () => {
    const res = await api('GET', '/api/v1/permissions', { token: ws.owner.token });
    expectOk(res);
    expect(res.data.length).toBeGreaterThanOrEqual(45);
    expect(res.data.map((p: any) => p.key)).toEqual(expect.arrayContaining(['crm.lead.read', 'role.create', 'audit.read']));
    ctx.permissions = Object.fromEntries(res.data.map((p: any) => [p.key, p.id]));
  });

  it('POST /roles and GET /roles manage workspace roles', async () => {
    const created = await api('POST', '/api/v1/roles', authed({ body: { name: `Sales ${RUN}`, description: 'Sales team' } }));
    expectOk(created);
    ctx.role = created.data;
    const listed = await api('GET', '/api/v1/roles', authed());
    expectOk(listed);
    expect(listed.data.map((r: any) => r.id)).toEqual(expect.arrayContaining([ctx.role.id]));
    expectError(await api('GET', '/api/v1/roles', { token: ws.owner.token }), 400, 'WORKSPACE_REQUIRED');
  });

  it('PUT /roles/[id]/permissions replaces the permissions of a role', async () => {
    const res = await api('PUT', '/api/v1/roles/[id]/permissions', authed({
      params: { id: ctx.role.id },
      body: { permissions: [{ permissionId: ctx.permissions['crm.lead.read'], scope: 'WORKSPACE' }] },
    }));
    expectOk(res);
    expectError(await api('PUT', '/api/v1/roles/[id]/permissions', authed({
      params: { id: ctx.role.id },
      body: { permissions: [{ permissionId: MISSING_ID, scope: 'WORKSPACE' }] },
    })), 400, 'PERMISSION_INVALID');
  });

  it('DELETE /roles/[id] removes an unused role', async () => {
    const extra = await api('POST', '/api/v1/roles', authed({ body: { name: `Disposable ${RUN}` } }));
    expectOk(extra);
    expectOk(await api('DELETE', '/api/v1/roles/[id]', authed({ params: { id: extra.data.id } })));
    expectError(await api('DELETE', '/api/v1/roles/[id]', authed({ params: { id: MISSING_ID } })), 404);
  });
});

describe('Users', () => {
  it('GET /users lists users', async () => {
    const res = await api('GET', '/api/v1/users', { token: ws.owner.token });
    expectOk(res);
    expect(res.data.map((u: any) => u.id)).toContain(ws.owner.userId);
  });

  it('POST /users invites a user into the workspace', async () => {
    const res = await api('POST', '/api/v1/users', {
      token: ws.owner.token,
      body: { workspaceId: ws.owner.workspaceId, email: `apitest-invited-${RUN}@example.com`, roleId: ctx.role.id },
    });
    expectOk(res);
    expect(res.data.invitation.email).toBe(`apitest-invited-${RUN}@example.com`);
    expectError(await api('POST', '/api/v1/users', {
      token: ws.owner.token,
      body: { workspaceId: ws.owner.workspaceId, email: `apitest-invited2-${RUN}@example.com`, roleId: MISSING_ID },
    }), 400);
  });

  it('GET /users/[id] returns the profile of the caller and hides other users', async () => {
    const own = await api('GET', '/api/v1/users/[id]', { token: ws.owner.token, params: { id: ws.owner.userId } });
    expectOk(own);
    expect(own.data.id).toBe(ws.owner.userId);
    ctx.other = await register('other');
    const foreign = await api('GET', '/api/v1/users/[id]', { token: ws.owner.token, params: { id: ctx.other.userId } });
    expect(foreign.status).toBeGreaterThanOrEqual(403);
    expect(foreign.status).toBeLessThanOrEqual(404);
  });

  it('PATCH and PUT /users/[id] update the profile', async () => {
    const patched = await api('PATCH', '/api/v1/users/[id]', {
      token: ws.owner.token,
      params: { id: ws.owner.userId },
      body: { firstName: 'Patched' },
    });
    expectOk(patched);
    expect(patched.data.firstName).toBe('Patched');
    const put = await api('PUT', '/api/v1/users/[id]', {
      token: ws.owner.token,
      params: { id: ws.owner.userId },
      body: { lastName: 'Putted' },
    });
    expectOk(put);
    expect(put.data.lastName).toBe('Putted');
    const foreign = await api('PATCH', '/api/v1/users/[id]', { token: ws.owner.token, params: { id: ctx.other.userId }, body: { firstName: 'Nope' } });
    expect(foreign.status).toBeGreaterThanOrEqual(403);
  });

  it('DELETE /users/[id] soft-deletes the caller', async () => {
    const doomed = await register('doomed');
    expectOk(await api('DELETE', '/api/v1/users/[id]', { token: doomed.token, params: { id: doomed.userId } }));
    expectError(await api('POST', '/api/v1/auth/signin', { body: { email: doomed.email, password: PASSWORD } }), 403);
  });
});

describe('Workspaces', () => {
  it('GET /workspaces lists the workspaces the caller belongs to', async () => {
    const res = await api('GET', '/api/v1/workspaces', { token: ws.owner.token });
    expectOk(res);
    expect(res.data.map((w: any) => w.id)).toContain(ws.owner.workspaceId);
  });

  it('POST /workspaces creates a workspace with default CRM pipelines', async () => {
    const created = await api('POST', '/api/v1/workspaces', { token: ws.owner.token, body: { name: `Second ${RUN}` } });
    expectOk(created);
    ctx.workspace = created.data;
    const pipelines = await api('GET', '/api/v1/crm/pipelines', { token: ws.owner.token, workspaceId: ctx.workspace.id });
    expectOk(pipelines);
    expect(pipelines.data.map((p: any) => p.entityType).sort()).toEqual(['DEAL', 'LEAD']);
  });

  it('GET, PUT and PATCH /workspaces/[id] read and update a workspace', async () => {
    const got = await api('GET', '/api/v1/workspaces/[id]', { token: ws.owner.token, params: { id: ctx.workspace.id } });
    expectOk(got);
    expect(got.data.id).toBe(ctx.workspace.id);
    const patched = await api('PATCH', '/api/v1/workspaces/[id]', { token: ws.owner.token, params: { id: ctx.workspace.id }, body: { name: `Patched ${RUN}` } });
    expectOk(patched);
    expect(patched.data.name).toBe(`Patched ${RUN}`);
    const put = await api('PUT', '/api/v1/workspaces/[id]', { token: ws.owner.token, params: { id: ctx.workspace.id }, body: { description: 'Put description' } });
    expectOk(put);
    expect(put.data.description).toBe('Put description');
    const outsider = await api('GET', '/api/v1/workspaces/[id]', { token: ctx.other.token, params: { id: ctx.workspace.id } });
    expect(outsider.status).toBeGreaterThanOrEqual(403);
  });

  it('POST /workspaces/[id]/switch changes the active workspace', async () => {
    const res = await api('POST', '/api/v1/workspaces/[id]/switch', { token: ws.owner.token, params: { id: ctx.workspace.id } });
    expectOk(res);
    expectError(await api('POST', '/api/v1/workspaces/[id]/switch', { token: ws.owner.token, params: { id: MISSING_ID } }), 404);
  });

  it('DELETE /workspaces/[id], PATCH /workspaces/[id]/restore and DELETE /workspaces/[id]/hard manage the lifecycle', async () => {
    const params = { id: ctx.workspace.id };
    expectOk(await api('DELETE', '/api/v1/workspaces/[id]', { token: ws.owner.token, params }));
    const listed = await api('GET', '/api/v1/workspaces', { token: ws.owner.token });
    expect(listed.data.map((w: any) => w.id)).not.toContain(ctx.workspace.id);

    expectOk(await api('PATCH', '/api/v1/workspaces/[id]/restore', { token: ws.owner.token, params }));
    expectOk(await api('DELETE', '/api/v1/workspaces/[id]', { token: ws.owner.token, params }));
    expectOk(await api('DELETE', '/api/v1/workspaces/[id]/hard', { token: ws.owner.token, params }));
    expectError(await api('GET', '/api/v1/workspaces/[id]', { token: ws.owner.token, params }), 404);
  });
});

describe('Departments', () => {
  it('POST /departments and GET /departments build the department tree', async () => {
    const root = await api('POST', '/api/v1/departments', authed({ body: { name: `Root ${RUN}`, description: 'Root dept' } }));
    expectOk(root);
    ctx.dept = root.data;
    const tree = await api('GET', '/api/v1/departments', authed());
    expectOk(tree);
    expect(JSON.stringify(tree.data)).toContain(ctx.dept.id);
    expectError(await api('POST', '/api/v1/departments', authed({ body: { name: `Root ${RUN}` } })), 409);
  });

  it('GET /departments/tree returns the same tree', async () => {
    const res = await api('GET', '/api/v1/departments/tree', authed());
    expectOk(res);
    expect(JSON.stringify(res.data)).toContain(ctx.dept.id);
  });

  it('POST /departments/[id]/sub-departments creates a child and the hierarchy endpoints see it', async () => {
    const child = await api('POST', '/api/v1/departments/[id]/sub-departments', authed({ params: { id: ctx.dept.id }, body: { name: `Child ${RUN}` } }));
    expectOk(child);
    expect(child.data.parentDepartmentId).toBe(ctx.dept.id);
    ctx.child = child.data;

    const children = await api('GET', '/api/v1/departments/[id]/children', authed({ params: { id: ctx.dept.id } }));
    expectOk(children);
    expect(children.data.map((d: any) => d.id)).toEqual([ctx.child.id]);

    const descendants = await api('GET', '/api/v1/departments/[id]/descendants', authed({ params: { id: ctx.dept.id } }));
    expectOk(descendants);
    expect(descendants.data.map((d: any) => d.id)).toContain(ctx.child.id);

    const ancestors = await api('GET', '/api/v1/departments/[id]/ancestors', authed({ params: { id: ctx.child.id } }));
    expectOk(ancestors);
    expect(ancestors.data.map((d: any) => d.id)).toContain(ctx.dept.id);
  });

  it('PATCH /departments/[id]/move re-parents a department and blocks cycles', async () => {
    const other = await api('POST', '/api/v1/departments', authed({ body: { name: `Other ${RUN}` } }));
    expectOk(other);
    ctx.otherDept = other.data;
    const moved = await api('PATCH', '/api/v1/departments/[id]/move', authed({ params: { id: ctx.child.id }, body: { parentDepartmentId: ctx.otherDept.id } }));
    expectOk(moved);
    expect(moved.data.parentDepartmentId).toBe(ctx.otherDept.id);
    expectError(await api('PATCH', '/api/v1/departments/[id]/move', authed({ params: { id: ctx.otherDept.id }, body: { parentDepartmentId: ctx.child.id } })), 400, 'DEPARTMENT_CYCLE');
  });

  it('POST /department-members adds workspace members and rejects duplicates and bad input', async () => {
    const res = await api('POST', '/api/v1/department-members', authed({ body: { departmentId: ctx.dept.id, userIds: [ws.owner.userId] } }));
    expectOk(res);
    expectError(await api('POST', '/api/v1/department-members', authed({ body: { departmentId: ctx.dept.id, userIds: [ws.owner.userId] } })), 409, 'DEPARTMENT_MEMBER_EXISTS');
    expectError(await api('POST', '/api/v1/department-members', authed({ body: { departmentId: ctx.dept.id } })), 400);
  });

  it('DELETE /departments/[id] soft-deletes leaf departments and refuses parents with children', async () => {
    expectError(await api('DELETE', '/api/v1/departments/[id]', authed({ params: { id: ctx.otherDept.id } })), 409);
    expectOk(await api('DELETE', '/api/v1/departments/[id]', authed({ params: { id: ctx.child.id } })));
    expectOk(await api('DELETE', '/api/v1/departments/[id]', authed({ params: { id: ctx.otherDept.id } })));
  });
});

describe('Audit logs', () => {
  it('GET /audit-logs lists workspace audit entries for the owner', async () => {
    const res = await api('GET', '/api/v1/audit-logs', authed());
    expectOk(res);
    expect(res.data.length).toBeGreaterThan(0);
    ctx.audit = res.data[0];
  });

  it('GET /audit-logs/[id] returns a single entry', async () => {
    const res = await api('GET', '/api/v1/audit-logs/[id]', authed({ params: { id: ctx.audit.id } }));
    expectOk(res);
    expect(res.data.id).toBe(ctx.audit.id);
    expectError(await api('GET', '/api/v1/audit-logs/[id]', authed({ params: { id: MISSING_ID } })), 404);
  });
});

describe('Partners', () => {
  const application = { phone: '+15550001111', partnerName: `Partner ${RUN}`, country: 'US', businessDescription: 'Reseller' };

  it('POST /partners/applications submits an application and validates the payload', async () => {
    const res = await api('POST', '/api/v1/partners/applications', { token: ws.owner.token, body: application });
    expectOk(res);
    expect(res.data.status).toBe('PENDING');
    ctx.application = res.data;
    expectError(await api('POST', '/api/v1/partners/applications', { token: ws.owner.token, body: { partnerName: 'Only name' } }), 400);
  });

  it('POST /partners/applications/[id]/approve is limited to platform admins', async () => {
    expectError(await api('POST', '/api/v1/partners/applications/[id]/approve', { token: ws.owner.token, params: { id: ctx.application.id } }), 403);
    const admin = await register('platform', 'entertabcrm.local');
    const approved = await api('POST', '/api/v1/partners/applications/[id]/approve', { token: admin.token, params: { id: ctx.application.id } });
    expectOk(approved);
    expectError(await api('POST', '/api/v1/partners/applications/[id]/approve', { token: admin.token, params: { id: ctx.application.id } }), 404);
  });
});

describe('CRM sources', () => {
  it('POST /crm/sources, GET /crm/sources and POST /crm/sources/[id]/deactivate manage the source catalog', async () => {
    const created = await api('POST', '/api/v1/crm/sources', authed({ body: { name: `Website ${RUN}` } }));
    expectOk(created);
    ctx.source = created.data;
    expect(ctx.source.isActive).toBe(true);

    const listed = await api('GET', '/api/v1/crm/sources', authed());
    expectOk(listed);
    expect(listed.data.map((s: any) => s.id)).toContain(ctx.source.id);

    expectOk(await api('POST', '/api/v1/crm/sources/[id]/deactivate', authed({ params: { id: ctx.source.id } })));
    const after = await api('GET', '/api/v1/crm/sources', authed());
    expect(after.data.map((s: any) => s.id)).not.toContain(ctx.source.id);
    const withInactive = await api('GET', '/api/v1/crm/sources', authed({ query: { includeInactive: 'true' } }));
    expect(withInactive.data.map((s: any) => s.id)).toContain(ctx.source.id);

    const active = await api('POST', '/api/v1/crm/sources', authed({ body: { name: `Referral ${RUN}` } }));
    expectOk(active);
    ctx.source = active.data;
  });
});

describe('CRM pipelines and stages', () => {
  const stageSet = (prefix: string) => [
    { name: `${prefix} New`, semanticType: 'PROGRESS', isDefault: true, position: 10 },
    { name: `${prefix} Working`, semanticType: 'PROGRESS', position: 20 },
    { name: `${prefix} Won`, semanticType: 'SUCCESS', position: 30 },
    { name: `${prefix} Lost`, semanticType: 'FAILURE', position: 40 },
  ];

  it('GET /crm/pipelines lists the default pipelines and filters by entity type', async () => {
    const all = await api('GET', '/api/v1/crm/pipelines', authed());
    expectOk(all);
    expect(all.data.map((p: any) => p.entityType).sort()).toEqual(['DEAL', 'LEAD']);
    ctx.defaultLeadPipeline = all.data.find((p: any) => p.entityType === 'LEAD');
    ctx.defaultDealPipeline = all.data.find((p: any) => p.entityType === 'DEAL');
    const leads = await api('GET', '/api/v1/crm/pipelines', authed({ query: { entityType: 'LEAD' } }));
    expect(leads.data.every((p: any) => p.entityType === 'LEAD')).toBe(true);
  });

  it('GET /crm/pipelines?includeStages=true adds ordered active stages and leaves the default list unchanged', async () => {
    const plain = await api('GET', '/api/v1/crm/pipelines', authed({ query: { entityType: 'DEAL' } }));
    expect(plain.data[0].stages).toBeUndefined();
    const withStages = await api('GET', '/api/v1/crm/pipelines', authed({ query: { entityType: 'DEAL', includeStages: 'true' } }));
    expectOk(withStages);
    const stages = withStages.data[0].stages as Array<{ id: string; name: string; position: number; semanticType: string }>;
    expect(stages.length).toBeGreaterThan(1);
    expect(stages.map((stage) => stage.position)).toEqual([...stages.map((stage) => stage.position)].sort((a, b) => a - b));
    expect(Object.keys(stages[0]).sort()).toEqual(['id', 'name', 'position', 'semanticType']);
  });

  it('POST /crm/pipelines creates pipelines with stages and validates their structure', async () => {
    const lead = await api('POST', '/api/v1/crm/pipelines', authed({ body: { entityType: 'LEAD', name: `Custom Lead ${RUN}`, stages: stageSet('L') } }));
    expectOk(lead);
    expect(lead.data.stages).toHaveLength(4);
    ctx.leadPipeline = lead.data.pipeline;
    ctx.leadStages = lead.data.stages;

    const deal = await api('POST', '/api/v1/crm/pipelines', authed({ body: { entityType: 'DEAL', name: `Custom Deal ${RUN}`, stages: stageSet('D') } }));
    expectOk(deal);
    ctx.dealPipeline = deal.data.pipeline;
    ctx.dealStages = deal.data.stages;

    expectError(await api('POST', '/api/v1/crm/pipelines', authed({ body: { entityType: 'LEAD', name: `Custom Lead ${RUN}`, stages: stageSet('X') } })), 409, 'CRM_PIPELINE_NAME_EXISTS');
    expectError(await api('POST', '/api/v1/crm/pipelines', authed({ body: { entityType: 'LEAD', name: `Broken ${RUN}`, stages: [{ name: 'Only', semanticType: 'PROGRESS', isDefault: true }] } })), 400, 'CRM_PIPELINE_STRUCTURE_INVALID');
  });

  it('PUT /crm/stages/[id]/permissions/[roleId] sets per-role stage permissions', async () => {
    const stage = ctx.leadStages[0];
    const res = await api('PUT', '/api/v1/crm/stages/[id]/permissions/[roleId]', authed({
      params: { id: stage.id, roleId: ctx.role.id },
      body: { canView: true, canEnter: true, canLeave: false },
    }));
    expectOk(res);
    expect(res.data).toEqual(expect.objectContaining({ roleId: ctx.role.id, stageId: stage.id, canView: true, canEnter: true, canLeave: false }));
    const ownerRole = await api('GET', '/api/v1/roles', authed());
    const owner = ownerRole.data.find((r: any) => r.isOwnerRole);
    expectError(await api('PUT', '/api/v1/crm/stages/[id]/permissions/[roleId]', authed({
      params: { id: stage.id, roleId: owner.id },
      body: { canView: true },
    })), 403);
  });

  it('POST /crm/stages/[id]/deactivate retires a stage but keeps the pipeline valid', async () => {
    const working = ctx.leadStages[1];
    expectOk(await api('POST', '/api/v1/crm/stages/[id]/deactivate', authed({ params: { id: working.id }, body: {} })));
    const failure = ctx.leadStages[3];
    expectError(await api('POST', '/api/v1/crm/stages/[id]/deactivate', authed({ params: { id: failure.id }, body: {} })), 400, 'CRM_PIPELINE_STRUCTURE_INVALID');
  });

  it('POST /crm/pipelines/[id]/deactivate retires a pipeline and protects the last one', async () => {
    const throwaway = await api('POST', '/api/v1/crm/pipelines', authed({ body: { entityType: 'LEAD', name: `Throwaway ${RUN}`, stages: stageSet('T') } }));
    expectOk(throwaway);
    expectOk(await api('POST', '/api/v1/crm/pipelines/[id]/deactivate', authed({ params: { id: throwaway.data.pipeline.id }, body: {} })));
    const after = await api('GET', '/api/v1/crm/pipelines', authed({ query: { entityType: 'LEAD' } }));
    expect(after.data.map((p: any) => p.id)).not.toContain(throwaway.data.pipeline.id);

    const other = await api('POST', '/api/v1/workspaces', { token: ws.owner.token, body: { name: `Solo ${RUN}` } });
    expectOk(other);
    const solo = await api('GET', '/api/v1/crm/pipelines', { token: ws.owner.token, workspaceId: other.data.id, query: { entityType: 'LEAD' } });
    expectError(await api('POST', '/api/v1/crm/pipelines/[id]/deactivate', {
      token: ws.owner.token,
      workspaceId: other.data.id,
      params: { id: solo.data[0].id },
      body: {},
    }), 409, 'CRM_LAST_PIPELINE_PROTECTED');
  });

  it('POST /crm/pipelines/backfill is idempotent on an already configured workspace', async () => {
    const res = await api('POST', '/api/v1/crm/pipelines/backfill', authed({ body: {} }));
    expectOk(res);
    expect(res.data).toEqual(expect.objectContaining({ leadPipelineId: expect.any(String), dealPipelineId: expect.any(String) }));
  });
});

describe('CRM companies, contacts and relationships', () => {
  it('POST and GET /crm/companies create and list companies', async () => {
    const created = await api('POST', '/api/v1/crm/companies', authed({ body: { name: `Acme ${RUN}`, city: 'Cairo' } }));
    expectOk(created);
    ctx.company = created.data;
    const listed = await api('GET', '/api/v1/crm/companies', authed({ query: { search: `Acme ${RUN}` } }));
    expectOk(listed);
    expect(listed.data.map((c: any) => c.id)).toContain(ctx.company.id);
    expect(listed.body.meta).toEqual(expect.objectContaining({ limit: expect.any(Number) }));
    expectError(await api('POST', '/api/v1/crm/companies', authed({ body: {} })), 400);
    expectError(await api('GET', '/api/v1/crm/companies', { token: ws.owner.token }), 400, 'WORKSPACE_REQUIRED');
  });

  it('POST and GET /crm/contacts create and list contacts', async () => {
    const created = await api('POST', '/api/v1/crm/contacts', authed({
      body: { firstName: 'Nadine', lastName: `Saleh${RUN}`, communications: [{ type: 'EMAIL', value: `nadine-${RUN}@example.com` }] },
    }));
    expectOk(created);
    ctx.contact = created.data;
    const listed = await api('GET', '/api/v1/crm/contacts', authed({ query: { search: `Saleh${RUN}`, limit: '5' } }));
    expectOk(listed);
    expect(listed.data.map((c: any) => c.id)).toContain(ctx.contact.id);
    expect(listed.body.meta.limit).toBe(5);
    expectError(await api('POST', '/api/v1/crm/contacts', authed({ body: { firstName: 'NoLast' } })), 400);
  });

  it('POST /crm/companies/[id]/communications and /crm/contacts/[id]/communications add channels', async () => {
    const company = await api('POST', '/api/v1/crm/companies/[id]/communications', authed({
      params: { id: ctx.company.id },
      body: { type: 'EMAIL', value: `info-${RUN}@acme.example` },
    }));
    expectOk(company);
    expect(company.data.isPrimary).toBe(true);
    const contact = await api('POST', '/api/v1/crm/contacts/[id]/communications', authed({
      params: { id: ctx.contact.id },
      body: { type: 'PHONE', value: '+20 100 000 0000' },
    }));
    expectOk(contact);
    expectError(await api('POST', '/api/v1/crm/contacts/[id]/communications', authed({ params: { id: ctx.contact.id }, body: { type: 'PHONE', value: '   ' } })), 400);
    expectError(await api('POST', '/api/v1/crm/contacts/[id]/communications', authed({ params: { id: MISSING_ID }, body: { type: 'PHONE', value: '123' } })), 404);
  });

  it('POST /crm/contacts/[id]/companies links a company and DELETE /crm/contact-companies/[id] removes the link', async () => {
    const link = await api('POST', '/api/v1/crm/contacts/[id]/companies', authed({
      params: { id: ctx.contact.id },
      body: { companyId: ctx.company.id, jobTitle: 'CTO', isPrimary: true },
    }));
    expectOk(link);
    expect(link.data).toEqual(expect.objectContaining({ contactId: ctx.contact.id, companyId: ctx.company.id }));
    expectOk(await api('DELETE', '/api/v1/crm/contact-companies/[id]', authed({ params: { id: link.data.id } })));
    expectError(await api('DELETE', '/api/v1/crm/contact-companies/[id]', authed({ params: { id: link.data.id } })), 404);
  });

  it('POST /crm/contacts/[id]/assign and /crm/companies/[id]/assign reassign the responsible user', async () => {
    const contact = await api('POST', '/api/v1/crm/contacts/[id]/assign', authed({
      params: { id: ctx.contact.id },
      body: { responsibleUserId: ws.owner.userId, expectedVersion: ctx.contact.version },
    }));
    expectOk(contact);
    const company = await api('POST', '/api/v1/crm/companies/[id]/assign', authed({
      params: { id: ctx.company.id },
      body: { responsibleUserId: ws.owner.userId, expectedVersion: ctx.company.version },
    }));
    expectOk(company);
    expectError(await api('POST', '/api/v1/crm/companies/[id]/assign', authed({
      params: { id: ctx.company.id },
      body: { responsibleUserId: ws.owner.userId, expectedVersion: 999 },
    })), 409, 'CRM_VERSION_CONFLICT');
  });
});

describe('CRM leads', () => {
  it('POST and GET /crm/leads create leads in the default pipeline and list them', async () => {
    const created = await api('POST', '/api/v1/crm/leads', authed({
      body: { title: `Lead ${RUN}`, firstName: 'Lena', lastName: 'One', sourceId: ctx.source.id },
      headers: { 'idempotency-key': `lead-${RUN}` },
    }));
    expectOk(created);
    ctx.lead = created.data;
    expect(ctx.lead.pipelineId).toBe(ctx.defaultLeadPipeline.id);
    expect(ctx.lead.stageId).toBeTruthy();

    const replay = await api('POST', '/api/v1/crm/leads', authed({
      body: { title: `Lead ${RUN}`, firstName: 'Lena', lastName: 'One', sourceId: ctx.source.id },
      headers: { 'idempotency-key': `lead-${RUN}` },
    }));
    expectOk(replay);
    expect(replay.data.id).toBe(ctx.lead.id);

    const listed = await api('GET', '/api/v1/crm/leads', authed({ query: { search: `Lead ${RUN}` } }));
    expectOk(listed);
    expect(listed.data.map((l: any) => l.id)).toEqual([ctx.lead.id]);
    expectError(await api('POST', '/api/v1/crm/leads', authed({ body: {} })), 400);
    expectError(await api('POST', '/api/v1/crm/leads', authed({ body: { title: 'Bad source', sourceId: MISSING_ID } })), 404);
  });

  it('POST /crm/leads/[id]/assign updates the responsible user with optimistic locking', async () => {
    const assigned = await api('POST', '/api/v1/crm/leads/[id]/assign', authed({
      params: { id: ctx.lead.id },
      body: { responsibleUserId: ws.owner.userId, expectedVersion: ctx.lead.version },
    }));
    expectOk(assigned);
    expectError(await api('POST', '/api/v1/crm/leads/[id]/assign', authed({
      params: { id: ctx.lead.id },
      body: { responsibleUserId: ws.owner.userId, expectedVersion: ctx.lead.version },
    })), 409, 'CRM_VERSION_CONFLICT');
  });

  it('POST /crm/leads/[id]/archive and /restore-archive toggle archival', async () => {
    const archived = await api('POST', '/api/v1/crm/leads/[id]/archive', authed({ params: { id: ctx.lead.id } }));
    expectOk(archived);
    expect(archived.data.isArchived).toBe(true);
    const restored = await api('POST', '/api/v1/crm/leads/[id]/restore-archive', authed({ params: { id: ctx.lead.id } }));
    expectOk(restored);
    expect(restored.data.isArchived).toBe(false);
  });

  it('POST /crm/leads/[id]/delete and /restore soft-delete and bring a lead back', async () => {
    const deleted = await api('POST', '/api/v1/crm/leads/[id]/delete', authed({ params: { id: ctx.lead.id } }));
    expectOk(deleted);
    expect(deleted.data.isDeleted).toBe(true);
    const hidden = await api('GET', '/api/v1/crm/leads', authed({ query: { search: `Lead ${RUN}` } }));
    expect(hidden.data).toHaveLength(0);
    const restored = await api('POST', '/api/v1/crm/leads/[id]/restore', authed({ params: { id: ctx.lead.id } }));
    expectOk(restored);
    expect(restored.data.isDeleted).toBe(false);
  });

  it('POST /crm/leads/[id]/transition moves a lead to another pipeline stage', async () => {
    const current = (await api('GET', '/api/v1/crm/leads', authed({ query: { search: `Lead ${RUN}` } }))).data[0];
    const target = ctx.leadStages.find((s: any) => s.semanticType === 'SUCCESS');
    const moved = await api('POST', '/api/v1/crm/leads/[id]/transition', authed({
      params: { id: ctx.lead.id },
      body: { expectedVersion: current.version, targetPipelineId: ctx.leadPipeline.id, targetStageId: target.id },
    }));
    expectOk(moved);
    expect(moved.data.stageId).toBe(target.id);
    expectError(await api('POST', '/api/v1/crm/leads/[id]/transition', authed({
      params: { id: ctx.lead.id },
      body: { expectedVersion: moved.data.version, targetStageId: ctx.defaultDealPipeline.id },
    })), 404);
  });

  it('POST /crm/leads/[id]/convert creates a contact and a deal from a lead', async () => {
    const lead = await api('POST', '/api/v1/crm/leads', authed({
      body: { title: `Convertible ${RUN}`, firstName: 'Cora', lastName: 'Vert', estimatedAmount: 5000, currencyCode: 'USD', sourceId: ctx.source.id },
    }));
    expectOk(lead);
    const converted = await api('POST', '/api/v1/crm/leads/[id]/convert', authed({
      params: { id: lead.data.id },
      body: { expectedVersion: lead.data.version, contact: { action: 'CREATE' }, company: { action: 'NONE' }, deal: { action: 'CREATE' } },
      headers: { 'idempotency-key': `convert-${RUN}` },
    }));
    expectOk(converted);
    expect(converted.data.deal).toEqual(expect.objectContaining({ amount: 5000, sourceId: ctx.source.id }));
    expect(converted.data.contact).toBeTruthy();
    expectError(await api('POST', '/api/v1/crm/leads/[id]/convert', authed({
      params: { id: lead.data.id },
      body: { expectedVersion: lead.data.version + 5, contact: { action: 'CREATE' }, company: { action: 'NONE' }, deal: { action: 'CREATE' } },
    })), 409);
  });
});

describe('CRM deals', () => {
  it('POST and GET /crm/deals create deals and list them', async () => {
    const created = await api('POST', '/api/v1/crm/deals', authed({
      body: { title: `Deal ${RUN}`, companyId: ctx.company.id, contactIds: [ctx.contact.id], amount: 1200, currencyCode: 'USD' },
    }));
    expectOk(created);
    ctx.deal = created.data;
    expect(ctx.deal.pipelineId).toBe(ctx.defaultDealPipeline.id);
    const listed = await api('GET', '/api/v1/crm/deals', authed({ query: { search: `Deal ${RUN}` } }));
    expectOk(listed);
    expect(listed.data.map((d: any) => d.id)).toContain(ctx.deal.id);
    expectError(await api('POST', '/api/v1/crm/deals', authed({ body: { title: 'No customer' } })), 400, 'CRM_CUSTOMER_REQUIRED');
  });

  it('POST /crm/deals/[id]/assign reassigns the responsible user', async () => {
    expectOk(await api('POST', '/api/v1/crm/deals/[id]/assign', authed({
      params: { id: ctx.deal.id },
      body: { responsibleUserId: ws.owner.userId, expectedVersion: ctx.deal.version },
    })));
  });

  it('POST /crm/deals/[id]/observers and DELETE /crm/deals/[id]/observers/[userId] manage observers', async () => {
    const added = await api('POST', '/api/v1/crm/deals/[id]/observers', authed({ params: { id: ctx.deal.id }, body: { userId: ws.owner.userId } }));
    expectOk(added);
    expectOk(await api('DELETE', '/api/v1/crm/deals/[id]/observers/[userId]', authed({ params: { id: ctx.deal.id, userId: ws.owner.userId } })));
    expectError(await api('POST', '/api/v1/crm/deals/[id]/observers', authed({ params: { id: ctx.deal.id }, body: { userId: MISSING_ID } })), 404);
  });

  it('POST /crm/deals/[id]/transition moves a deal to another pipeline stage', async () => {
    const current = (await api('GET', '/api/v1/crm/deals', authed({ query: { search: `Deal ${RUN}` } }))).data[0];
    const target = ctx.dealStages.find((s: any) => s.semanticType === 'PROGRESS' && !s.isDefault);
    const moved = await api('POST', '/api/v1/crm/deals/[id]/transition', authed({
      params: { id: ctx.deal.id },
      body: { expectedVersion: current.version, targetPipelineId: ctx.dealPipeline.id, targetStageId: target.id },
    }));
    expectOk(moved);
    expect(moved.data.stageId).toBe(target.id);
    expectError(await api('POST', '/api/v1/crm/deals/[id]/transition', authed({
      params: { id: ctx.deal.id },
      body: { expectedVersion: 1, targetPipelineId: ctx.dealPipeline.id, targetStageId: target.id },
    })), 409);
  });

  it('DELETE /crm/companies/[id] refuses companies with active deals and deletes free ones', async () => {
    expectError(await api('DELETE', '/api/v1/crm/companies/[id]', authed({ params: { id: ctx.company.id } })), 409, 'CRM_ACTIVE_REFERENCES_EXIST');
    const free = await api('POST', '/api/v1/crm/companies', authed({ body: { name: `Free ${RUN}` } }));
    expectOk(free);
    expectOk(await api('DELETE', '/api/v1/crm/companies/[id]', authed({ params: { id: free.data.id } })));
  });
});

describe('Custom fields API', () => {
  const fields: Record<string, any> = {};
  ctx.fields = fields;

  it('POST /crm/custom-fields creates fields (with options) and GET lists/filters them', async () => {
    const post = (body: Record<string, unknown>) => api('POST', '/api/v1/crm/custom-fields', authed({ body: { entityType: 'DEAL', ...body } }));
    const list = await post({ label: 'API Industry', code: 'api_industry', fieldType: 'LIST', options: [{ label: 'Finance' }, { label: 'Health' }], filterable: true });
    expectOk(list);
    fields.industry = list.data;
    expect(list.data.options).toHaveLength(2);
    fields.users = (await post({ label: 'API Users', code: 'api_users', fieldType: 'INTEGER', validationConfig: { minimum: 1 } })).data;
    fields.money = (await post({ label: 'API Budget', code: 'api_budget', fieldType: 'MONEY' })).data;
    fields.renewal = (await post({ label: 'API Renewal', code: 'api_renewal', fieldType: 'DATE' })).data;
    fields.signed = (await post({ label: 'API Signed', code: 'api_signed', fieldType: 'DATETIME' })).data;
    fields.address = (await post({ label: 'API Office', code: 'api_office', fieldType: 'ADDRESS' })).data;
    fields.tags = (await post({ label: 'API Tags', code: 'api_tags', fieldType: 'MULTI_LIST', options: [{ label: 'One' }, { label: 'Two' }, { label: 'Three' }] })).data;
    fields.ratio = (await post({ label: 'API Ratio', code: 'api_ratio', fieldType: 'DECIMAL' })).data;
    fields.note = (await post({ label: 'API Note', code: 'api_note', fieldType: 'TEXT' })).data;
    for (const field of Object.values(fields)) expect(field.id).toBeTruthy();

    const listed = await api('GET', '/api/v1/crm/custom-fields', authed({ query: { entityType: 'DEAL', isActive: 'true', limit: '3', sortBy: 'sortOrder' } }));
    expectOk(listed);
    expect(listed.data).toHaveLength(3);
    expect(listed.body.meta).toMatchObject({ page: 1, limit: 3, total: 9 });
    expect((await api('GET', '/api/v1/crm/custom-fields', authed({ query: { fieldType: 'LIST' } }))).data.map((f: any) => f.code)).toEqual(['api_industry']);
    // The requirement condition builder offers only the operators each type supports, straight from the server.
    const operatorsOf = async (fieldType: string) => (await api('GET', '/api/v1/crm/custom-fields', authed({ query: { entityType: 'DEAL', fieldType, limit: '1' } }))).data[0]?.conditionOperators;
    expect(await operatorsOf('LIST')).toEqual(['EQ', 'NEQ', 'IN', 'NOT_IN', 'IS_EMPTY', 'IS_NOT_EMPTY']);
    expect(await operatorsOf('DATE')).toEqual(['EQ', 'NEQ', 'GT', 'GTE', 'LT', 'LTE', 'IS_EMPTY', 'IS_NOT_EMPTY']);
    expect(await operatorsOf('TEXT')).toContain('CONTAINS');
    expectError(await post({ label: 'Dup', code: 'api_industry', fieldType: 'TEXT' }), 409, 'CUSTOM_FIELD_CODE_CONFLICT');
    expectError(await post({ entityType: 'ROBOT', label: 'X', fieldType: 'TEXT' }), 400, 'ENTITY_TYPE_NOT_FIELD_CAPABLE');
    expectError(await post({ label: 'X', fieldType: 'TEXT', validationConfig: { pattern: '(a+)+' } }), 400, 'FIELD_VALIDATION_FAILED');
  });

  it('GET and PATCH /crm/custom-fields/[fieldId] read and update with optimistic concurrency', async () => {
    const got = await api('GET', '/api/v1/crm/custom-fields/[fieldId]', authed({ params: { fieldId: fields.industry.id } }));
    expectOk(got);
    expect(got.data.code).toBe('api_industry');
    const patched = await api('PATCH', '/api/v1/crm/custom-fields/[fieldId]', authed({ params: { fieldId: fields.industry.id }, body: { version: got.data.version, label: 'Industry (renamed)' } }));
    expectOk(patched);
    expect(patched.data).toMatchObject({ label: 'Industry (renamed)', code: 'api_industry', version: got.data.version + 1 });
    expectError(await api('PATCH', '/api/v1/crm/custom-fields/[fieldId]', authed({ params: { fieldId: fields.industry.id }, body: { version: got.data.version, label: 'stale' } })), 409, 'CONFIGURATION_VERSION_CONFLICT');
    expectError(await api('PATCH', '/api/v1/crm/custom-fields/[fieldId]', authed({ params: { fieldId: fields.industry.id }, body: { version: patched.data.version, code: 'nope' } })), 400, 'CUSTOM_FIELD_IMMUTABLE');
    expectError(await api('GET', '/api/v1/crm/custom-fields/[fieldId]', authed({ params: { fieldId: MISSING_ID } })), 404, 'CUSTOM_FIELD_NOT_FOUND');
    // A caller outside the workspace cannot administer its fields.
    expectError(await api('GET', '/api/v1/crm/custom-fields/[fieldId]', { token: ctx.other.token, workspaceId: ws.owner.workspaceId, params: { fieldId: fields.industry.id } }), 403);
  });

  it('manages list options through the option endpoints', async () => {
    const fieldId = fields.industry.id;
    const created = await api('POST', '/api/v1/crm/custom-fields/[fieldId]/options', authed({ params: { fieldId }, body: { label: 'Retail' } }));
    expectOk(created);
    const listed = await api('GET', '/api/v1/crm/custom-fields/[fieldId]/options', authed({ params: { fieldId } }));
    expectOk(listed);
    expect(listed.data.map((o: any) => o.label)).toEqual(['Finance', 'Health', 'Retail']);
    const updated = await api('PATCH', '/api/v1/crm/custom-fields/[fieldId]/options/[optionId]', authed({ params: { fieldId, optionId: created.data.id }, body: { label: 'Retail & E-commerce', version: created.data.version } }));
    expectOk(updated);
    expect(updated.data).toMatchObject({ id: created.data.id, code: created.data.code, label: 'Retail & E-commerce' });
    expectOk(await api('POST', '/api/v1/crm/custom-fields/[fieldId]/options/[optionId]/deactivate', authed({ params: { fieldId, optionId: created.data.id } })));
    expectOk(await api('POST', '/api/v1/crm/custom-fields/[fieldId]/options/[optionId]/activate', authed({ params: { fieldId, optionId: created.data.id } })));
    const field = (await api('GET', '/api/v1/crm/custom-fields/[fieldId]', authed({ params: { fieldId } }))).data;
    const order = [...listed.data].reverse().map((o: any) => o.id);
    const reordered = await api('POST', '/api/v1/crm/custom-fields/[fieldId]/options/reorder', authed({ params: { fieldId }, body: { orderedOptionIds: order, expectedSchemaVersion: field.schemaVersion } }));
    expectOk(reordered);
    expect(reordered.data.options.map((o: any) => o.id)).toEqual(order);
    expectError(await api('POST', '/api/v1/crm/custom-fields/[fieldId]/options/reorder', authed({ params: { fieldId }, body: { orderedOptionIds: order, expectedSchemaVersion: field.schemaVersion } })), 409, 'CONFIGURATION_VERSION_CONFLICT');
    expectError(await api('POST', '/api/v1/crm/custom-fields/[fieldId]/options', authed({ params: { fieldId: fields.users.id }, body: { label: 'x' } })), 400, 'CUSTOM_FIELD_TYPE_UNSUPPORTED');
    expectError(await api('PATCH', '/api/v1/crm/custom-fields/[fieldId]/options/[optionId]', authed({ params: { fieldId, optionId: MISSING_ID }, body: { label: 'x', version: 1 } })), 404, 'FIELD_OPTION_NOT_FOUND');
  });

  it('POST /crm/custom-fields/reorder atomically reorders the fields of an entity', async () => {
    const all = (await api('GET', '/api/v1/crm/custom-fields', authed({ query: { entityType: 'DEAL', limit: '100' } }))).data;
    const ids = all.map((f: any) => f.id).reverse();
    const version = all[0].schemaVersion;
    const res = await api('POST', '/api/v1/crm/custom-fields/reorder', authed({ body: { orderedFieldIds: ids, expectedSchemaVersion: version } }));
    expectOk(res);
    expect(res.data.fields.map((f: any) => f.id)).toEqual(ids);
    expectError(await api('POST', '/api/v1/crm/custom-fields/reorder', authed({ body: { orderedFieldIds: ids, expectedSchemaVersion: version } })), 409, 'CONFIGURATION_VERSION_CONFLICT');
    expectError(await api('POST', '/api/v1/crm/custom-fields/reorder', authed({ body: { orderedFieldIds: ids.slice(1), expectedSchemaVersion: version + 1 } })), 400, 'FIELD_REORDER_INVALID');
  });

  it('writes and reads every typed value through Postgres (typed columns, exact decimals, dates, JSON)', async () => {
    const created = await api('POST', '/api/v1/crm/deals', authed({
      body: {
        title: `Typed deal ${RUN}`,
        companyId: ctx.company.id,
        customFields: {
          api_industry: fields.industry.options[0].id,
          api_users: 400,
          api_budget: { amount: '125000.50', currency: 'usd' },
          api_renewal: '2027-03-01',
          api_signed: '2027-01-01T10:00:00+02:00',
          api_office: { line1: '100 Main St', city: 'Edmonton', countryCode: 'CA' },
          api_tags: [fields.tags.options[2].id, fields.tags.options[0].id],
          api_ratio: '0.00000001',
          api_note: 'hello',
        },
      },
    }));
    expectOk(created);
    ctx.typedDeal = created.data;
    expect(created.data.customFields).toEqual({
      api_industry: fields.industry.options[0].id,
      api_users: 400,
      api_budget: { amount: '125000.5', currency: 'USD' },
      api_renewal: '2027-03-01',
      api_signed: '2027-01-01T08:00:00.000Z',
      api_office: { line1: '100 Main St', city: 'Edmonton', countryCode: 'CA' },
      api_tags: [fields.tags.options[2].id, fields.tags.options[0].id],
      api_ratio: '0.00000001',
      api_note: 'hello',
    });
    // The request that reads it back re-hydrated everything from the database.
    const detail = await api('GET', '/api/v1/crm/deals/[id]', authed({ params: { id: ctx.typedDeal.id } }));
    expectOk(detail);
    expect(detail.data.customFields).toEqual(created.data.customFields);

    const { prisma } = await import('@/src/server/prisma-client');
    const rows = await prisma.crmCustomFieldValue.findMany({ where: { entityId: ctx.typedDeal.id }, orderBy: [{ fieldId: 'asc' }, { ordinal: 'asc' }] });
    expect(rows).toHaveLength(10);
    const byField = (id: string) => rows.filter((row) => row.fieldId === id);
    expect(byField(fields.users.id)[0]).toMatchObject({ valueInteger: 400, valueText: null, valueDecimal: null });
    expect(byField(fields.money.id)[0].valueDecimal!.toFixed()).toBe('125000.5');
    expect(byField(fields.money.id)[0].valueText).toBe('USD');
    expect(byField(fields.ratio.id)[0].valueDecimal!.toFixed()).toBe('0.00000001'); // no float rounding, no exponent form
    expect(byField(fields.renewal.id)[0].valueDate!.toISOString()).toBe('2027-03-01T00:00:00.000Z');
    expect(byField(fields.signed.id)[0].valueDateTime!.toISOString()).toBe('2027-01-01T08:00:00.000Z');
    expect(byField(fields.address.id)[0].valueJson).toEqual({ line1: '100 Main St', city: 'Edmonton', countryCode: 'CA' });
    expect(byField(fields.tags.id).map((row) => [row.ordinal, row.valueUuid])).toEqual([[0, fields.tags.options[2].id], [1, fields.tags.options[0].id]]);
    expect(byField(fields.industry.id)[0].valueUuid).toBe(fields.industry.options[0].id);
  });

  it('returns all safe field errors in one response and rejects unknown or hidden codes', async () => {
    const res = await api('POST', '/api/v1/crm/deals', authed({ body: { title: 'Bad deal', companyId: ctx.company.id, customFields: { api_users: 0, api_budget: { amount: 'x', currency: 'usd' }, nope: 1 } } }));
    expectError(res, 400, 'FIELD_VALIDATION_FAILED');
    expect(Object.keys(res.body.error.details.fields).sort()).toEqual(['api_budget', 'api_users', 'nope']);
    expect(res.body.error.details.fields.nope[0].code).toBe('UNKNOWN_FIELD');
    // Nothing was written: the failed create left no deal behind.
    const { prisma } = await import('@/src/server/prisma-client');
    expect(await prisma.crmDeal.count({ where: { title: 'Bad deal' } })).toBe(0);
  });

  it('PATCH /crm/deals/[id] updates system and custom values atomically with stale-version detection', async () => {
    const detail = (await api('GET', '/api/v1/crm/deals/[id]', authed({ params: { id: ctx.typedDeal.id } }))).data;
    const patched = await api('PATCH', '/api/v1/crm/deals/[id]', authed({ params: { id: ctx.typedDeal.id }, body: { expectedVersion: detail.version, title: 'Typed deal (patched)', amount: 9000, customFields: { api_users: 500, api_tags: [fields.tags.options[1].id] } } }));
    expectOk(patched);
    expect(patched.data).toMatchObject({ title: 'Typed deal (patched)', amount: 9000, version: detail.version + 1 });
    expect(patched.data.customFields).toMatchObject({ api_users: 500, api_tags: [fields.tags.options[1].id], api_note: 'hello' });
    const failed = await api('PATCH', '/api/v1/crm/deals/[id]', authed({ params: { id: ctx.typedDeal.id }, body: { expectedVersion: patched.data.version, title: 'Should not stick', customFields: { api_users: -5 } } }));
    expectError(failed, 400, 'FIELD_VALIDATION_FAILED');
    const after = (await api('GET', '/api/v1/crm/deals/[id]', authed({ params: { id: ctx.typedDeal.id } }))).data;
    expect(after).toMatchObject({ title: 'Typed deal (patched)', version: patched.data.version });
    expect(after.customFields.api_users).toBe(500);
    expectError(await api('PATCH', '/api/v1/crm/deals/[id]', authed({ params: { id: ctx.typedDeal.id }, body: { expectedVersion: detail.version, title: 'stale' } })), 409, 'CRM_VERSION_CONFLICT');
    expectError(await api('PATCH', '/api/v1/crm/deals/[id]', authed({ params: { id: ctx.typedDeal.id }, body: { expectedVersion: after.version, status: 'WON' } })), 400, 'CRM_FIELD_NOT_UPDATABLE');
    const list = await api('GET', '/api/v1/crm/deals', authed({ query: { search: 'Typed deal' } }));
    expect(list.data[0].customFields.api_users).toBe(500);
  });

  it('serves lead, contact and company create/detail/update with custom fields', async () => {
    const make = (entityType: string, body: Record<string, unknown>) => api('POST', '/api/v1/crm/custom-fields', authed({ body: { entityType, ...body } }));
    expectOk(await make('LEAD', { label: 'Lead score', code: 'lead_score', fieldType: 'INTEGER' }));
    expectOk(await make('CONTACT', { label: 'Nickname', code: 'nickname', fieldType: 'TEXT' }));
    expectOk(await make('COMPANY', { label: 'Employees', code: 'employees', fieldType: 'INTEGER' }));
    const lead = await api('POST', '/api/v1/crm/leads', authed({ body: { title: `Scored lead ${RUN}`, customFields: { lead_score: 9 } } }));
    const contact = await api('POST', '/api/v1/crm/contacts', authed({ body: { firstName: 'Nick', lastName: `Name${RUN}`, customFields: { nickname: 'Nicky' } } }));
    const company = await api('POST', '/api/v1/crm/companies', authed({ body: { name: `Sized Co ${RUN}`, customFields: { employees: 250 } } }));
    for (const res of [lead, contact, company]) expectOk(res);
    expect(lead.data.customFields).toEqual({ lead_score: 9 });
    ctx.customLead = lead.data;
    ctx.customContact = contact.data;
    ctx.customCompany = company.data;
    const getLead = await api('GET', '/api/v1/crm/leads/[id]', authed({ params: { id: lead.data.id } }));
    const getContact = await api('GET', '/api/v1/crm/contacts/[id]', authed({ params: { id: contact.data.id } }));
    const getCompany = await api('GET', '/api/v1/crm/companies/[id]', authed({ params: { id: company.data.id } }));
    expect([getLead.data.customFields.lead_score, getContact.data.customFields.nickname, getCompany.data.customFields.employees]).toEqual([9, 'Nicky', 250]);
    const patchedLead = await api('PATCH', '/api/v1/crm/leads/[id]', authed({ params: { id: lead.data.id }, body: { expectedVersion: getLead.data.version, title: 'Lead renamed', customFields: { lead_score: 10 } } }));
    const patchedContact = await api('PATCH', '/api/v1/crm/contacts/[id]', authed({ params: { id: contact.data.id }, body: { expectedVersion: getContact.data.version, lastName: 'Renamed', customFields: { nickname: null } } }));
    const patchedCompany = await api('PATCH', '/api/v1/crm/companies/[id]', authed({ params: { id: company.data.id }, body: { expectedVersion: getCompany.data.version, city: 'Cairo', customFields: { employees: 300 } } }));
    expect([patchedLead.data.customFields, patchedContact.data.customFields, patchedCompany.data.customFields]).toEqual([{ lead_score: 10 }, { nickname: null }, { employees: 300 }]);
    expect([patchedLead.data.title, patchedContact.data.displayName, patchedCompany.data.city]).toEqual(['Lead renamed', 'Nick Renamed', 'Cairo']);
    const lists = await Promise.all([
      api('GET', '/api/v1/crm/leads', authed({ query: { search: 'Lead renamed' } })),
      api('GET', '/api/v1/crm/contacts', authed({ query: { search: 'Renamed' } })),
      api('GET', '/api/v1/crm/companies', authed({ query: { search: 'Sized Co' } })),
    ]);
    expect(lists.map((res) => res.data[0].customFields)).toEqual([{ lead_score: 10 }, { nickname: null }, { employees: 300 }]);
    expectError(await api('GET', '/api/v1/crm/leads/[id]', authed({ params: { id: MISSING_ID } })), 404);
  });

  it('serves the authorized field schema for creating, editing and listing', async () => {
    const create = await api('GET', '/api/v1/crm/field-schema/[entityType]', authed({ params: { entityType: 'deals' }, query: { surface: 'create' } }));
    expectOk(create);
    expect(create.data.fields.map((f: any) => f.code)).toEqual(expect.arrayContaining(['api_industry', 'api_users', 'api_budget']));
    expect(create.data.systemFields.map((f: any) => f.key)).toContain('amount');
    const edit = await api('GET', '/api/v1/crm/field-schema/[entityType]/[entityId]', authed({ params: { entityType: 'DEAL', entityId: ctx.typedDeal.id }, query: { surface: 'edit' } }));
    expectOk(edit);
    expect(edit.data.fields.find((f: any) => f.code === 'api_industry').options.map((o: any) => o.label)).toEqual(['Retail & E-commerce', 'Health', 'Finance']);
    expectError(await api('GET', '/api/v1/crm/field-schema/[entityType]/[entityId]', authed({ params: { entityType: 'DEAL', entityId: MISSING_ID } })), 404, 'RESOURCE_NOT_FOUND_OR_FORBIDDEN');
    expectError(await api('GET', '/api/v1/crm/field-schema/[entityType]', authed({ params: { entityType: 'robots' } })), 400);
    expectError(await api('GET', '/api/v1/crm/field-schema/[entityType]', authed({ params: { entityType: 'deal' }, query: { surface: 'sideways' } })), 400, 'SCHEMA_SURFACE_INVALID');
    expectOk(await api('GET', '/api/v1/crm/field-schema/[entityType]', authed({ params: { entityType: 'activities' }, query: { surface: 'create' } })));
  });

  it('runs the required-field rule lifecycle through the API and enforces it on create', async () => {
    const created = await api('POST', '/api/v1/crm/field-requirements', authed({ body: { entityType: 'DEAL', target: { kind: 'CUSTOM', fieldId: fields.note.id }, conditions: { operator: 'ALL', children: [{ type: 'PREDICATE', field: { kind: 'SYSTEM', key: 'amount' }, operator: 'GTE', value: '5000' }] } } }));
    expectOk(created);
    ctx.rule = created.data;
    const listed = await api('GET', '/api/v1/crm/field-requirements', authed({ query: { entityType: 'DEAL', isActive: 'true' } }));
    expect(listed.data.map((r: any) => r.id)).toContain(created.data.id);
    expectOk(await api('GET', '/api/v1/crm/field-requirements/[ruleId]', authed({ params: { ruleId: created.data.id } })));
    const descriptors = await api('GET', '/api/v1/crm/field-requirements/system-fields', authed({ query: { entityType: 'DEAL' } }));
    expect(descriptors.data.find((d: any) => d.key === 'amount').operators).toContain('GTE');
    // Conditional rule: a big deal without the note is refused, a small one is not.
    expectError(await api('POST', '/api/v1/crm/deals', authed({ body: { title: 'Big', companyId: ctx.company.id, amount: 10000 } })), 400, 'FIELD_VALIDATION_FAILED');
    expectOk(await api('POST', '/api/v1/crm/deals', authed({ body: { title: 'Small', companyId: ctx.company.id, amount: 100 } })));
    expectOk(await api('POST', '/api/v1/crm/deals', authed({ body: { title: 'Big with note', companyId: ctx.company.id, amount: 10000, customFields: { api_note: 'justified' } } })));
    const patched = await api('PATCH', '/api/v1/crm/field-requirements/[ruleId]', authed({ params: { ruleId: created.data.id }, body: { version: created.data.version, conditions: null } }));
    expectOk(patched);
    expectError(await api('PATCH', '/api/v1/crm/field-requirements/[ruleId]', authed({ params: { ruleId: created.data.id }, body: { version: created.data.version, conditions: null } })), 409, 'CONFIGURATION_VERSION_CONFLICT');
    expectError(await api('POST', '/api/v1/crm/field-requirements', authed({ body: { entityType: 'DEAL', target: { kind: 'CUSTOM', fieldId: fields.note.id }, conditions: { type: 'PREDICATE', field: { kind: 'SYSTEM', key: 'amount' }, operator: 'CONTAINS', value: 'x' } } })), 400, 'FIELD_REQUIREMENT_INVALID');
    // Dependencies block deactivating the target while the rule is active.
    const deps = await api('GET', '/api/v1/crm/custom-fields/[fieldId]/dependencies', authed({ params: { fieldId: fields.note.id } }));
    expectOk(deps);
    expect(deps.data.blocking).toBe(1);
    expectError(await api('POST', '/api/v1/crm/custom-fields/[fieldId]/deactivate', authed({ params: { fieldId: fields.note.id }, body: {} })), 409, 'CUSTOM_FIELD_DEPENDENCIES_EXIST');
    expectOk(await api('POST', '/api/v1/crm/field-requirements/[ruleId]/deactivate', authed({ params: { ruleId: created.data.id }, body: {} })));
    expectOk(await api('POST', '/api/v1/crm/deals', authed({ body: { title: 'Big again', companyId: ctx.company.id, amount: 10000 } })));
    expectOk(await api('POST', '/api/v1/crm/field-requirements/[ruleId]/activate', authed({ params: { ruleId: created.data.id }, body: {} })));
    expectOk(await api('POST', '/api/v1/crm/field-requirements/[ruleId]/deactivate', authed({ params: { ruleId: created.data.id }, body: {} })));
    expectOk(await api('DELETE', '/api/v1/crm/field-requirements/[ruleId]', authed({ params: { ruleId: created.data.id } })));
    expectError(await api('GET', '/api/v1/crm/field-requirements/[ruleId]', authed({ params: { ruleId: created.data.id } })), 404, 'FIELD_REQUIREMENT_NOT_FOUND');
  });

  it('migrates a field type through preview, start and status endpoints', async () => {
    const field = (await api('POST', '/api/v1/crm/custom-fields', authed({ body: { entityType: 'CONTACT', label: 'Headcount', code: 'headcount', fieldType: 'TEXT' } }))).data;
    expectOk(await api('POST', '/api/v1/crm/contacts', authed({ body: { firstName: 'H', lastName: 'One', customFields: { headcount: '42' } } })));
    expectOk(await api('POST', '/api/v1/crm/contacts', authed({ body: { firstName: 'H', lastName: 'Two', customFields: { headcount: 'many' } } })));
    expectError(await api('PATCH', '/api/v1/crm/custom-fields/[fieldId]', authed({ params: { fieldId: field.id }, body: { version: field.version, fieldType: 'INTEGER' } })), 409, 'CUSTOM_FIELD_TYPE_MIGRATION_REQUIRED');
    const preview = await api('POST', '/api/v1/crm/custom-fields/[fieldId]/type-migration/preview', authed({ params: { fieldId: field.id }, body: { targetType: 'INTEGER' } }));
    expectOk(preview);
    expect(preview.data.summary).toMatchObject({ totalValues: 2, convertible: 1, nonConvertible: 1 });
    const failed = await api('POST', '/api/v1/crm/custom-fields/[fieldId]/type-migration', authed({ params: { fieldId: field.id }, body: { targetType: 'INTEGER', version: field.version } }));
    expectOk(failed);
    expect(failed.data.status).toBe('FAILED');
    const status = await api('GET', '/api/v1/crm/custom-fields/[fieldId]/type-migration/[migrationId]', authed({ params: { fieldId: field.id, migrationId: failed.data.id } }));
    expect(status.data.status).toBe('FAILED');
    expectError(await api('GET', '/api/v1/crm/custom-fields/[fieldId]/type-migration/[migrationId]', authed({ params: { fieldId: field.id, migrationId: MISSING_ID } })), 404, 'CUSTOM_FIELD_MIGRATION_NOT_FOUND');
    const { prisma } = await import('@/src/server/prisma-client');
    expect((await prisma.crmCustomField.findUnique({ where: { id: field.id } }))!.fieldType).toBe('TEXT');
    expect(await prisma.crmCustomFieldMigration.count({ where: { fieldId: field.id, status: 'FAILED' } })).toBe(1);
    // Fix the offending value and migrate for real.
    const two = (await api('GET', '/api/v1/crm/contacts', authed({ query: { search: 'Two' } }))).data[0];
    expectOk(await api('PATCH', '/api/v1/crm/contacts/[id]', authed({ params: { id: two.id }, body: { expectedVersion: two.version, customFields: { headcount: '7' } } })));
    const current = (await api('GET', '/api/v1/crm/custom-fields/[fieldId]', authed({ params: { fieldId: field.id } }))).data;
    const done = await api('POST', '/api/v1/crm/custom-fields/[fieldId]/type-migration', authed({ params: { fieldId: field.id }, body: { targetType: 'INTEGER', version: current.version } }));
    expect(done.data.status).toBe('COMPLETED');
    expect((await api('GET', '/api/v1/crm/contacts/[id]', authed({ params: { id: two.id } }))).data.customFields.headcount).toBe(7);
    expect((await prisma.crmCustomFieldValue.findMany({ where: { fieldId: field.id } })).every((row) => row.valueInteger !== null && row.valueText === null)).toBe(true);
  });

  it('activates, deactivates and hard-deletes fields through the lifecycle endpoints', async () => {
    const field = (await api('POST', '/api/v1/crm/custom-fields', authed({ body: { entityType: 'COMPANY', label: 'Disposable', code: 'disposable', fieldType: 'TEXT' } }))).data;
    expectError(await api('DELETE', '/api/v1/crm/custom-fields/[fieldId]/hard', authed({ params: { fieldId: field.id } })), 409, 'CUSTOM_FIELD_IN_USE');
    const off = await api('POST', '/api/v1/crm/custom-fields/[fieldId]/deactivate', authed({ params: { fieldId: field.id }, body: { version: field.version } }));
    expectOk(off);
    expect(off.data.isActive).toBe(false);
    const on = await api('POST', '/api/v1/crm/custom-fields/[fieldId]/activate', authed({ params: { fieldId: field.id }, body: {} }));
    expect(on.data.isActive).toBe(true);
    expectOk(await api('POST', '/api/v1/crm/custom-fields/[fieldId]/deactivate', authed({ params: { fieldId: field.id }, body: {} })));
    expectOk(await api('DELETE', '/api/v1/crm/custom-fields/[fieldId]/hard', authed({ params: { fieldId: field.id } })));
    expectError(await api('GET', '/api/v1/crm/custom-fields/[fieldId]', authed({ params: { fieldId: field.id } })), 404);
  });

  it('keeps field configuration isolated per workspace', async () => {
    const mine = (await api('GET', '/api/v1/crm/custom-fields', authed({ query: { limit: '100' } }))).data;
    const foreignWorkspace = (await api('POST', '/api/v1/workspaces', { token: ws.owner.token, body: { name: `Fields Iso ${RUN}` } })).data;
    const theirs = await api('GET', '/api/v1/crm/custom-fields', { token: ws.owner.token, workspaceId: foreignWorkspace.id, query: { limit: '100' } });
    expect(theirs.data).toEqual([]);
    expect(mine.length).toBeGreaterThan(5);
    expectError(await api('GET', '/api/v1/crm/custom-fields/[fieldId]', { token: ws.owner.token, workspaceId: foreignWorkspace.id, params: { fieldId: fields.industry.id } }), 404, 'CUSTOM_FIELD_NOT_FOUND');
    // Field codes of another workspace are simply unknown fields here.
    const foreignDeal = await api('POST', '/api/v1/crm/deals', { token: ws.owner.token, workspaceId: foreignWorkspace.id, body: { title: 'x', companyId: ctx.company.id, customFields: { api_users: 5 } } });
    expectError(foreignDeal, 404);
  });
});

describe('Activities API', () => {
  const act: Record<string, any> = {};
  ctx.act = act;

  it('GET/POST/PATCH /crm/activity-types manages custom types and enable/disable', async () => {
    const created = await api('POST', '/api/v1/crm/activity-types', authed({ body: { code: 'SITE_VISIT', name: 'Site visit', icon: 'map-pin', defaultDurationMinutes: 45, defaultPriority: 'HIGH' } }));
    expectOk(created);
    act.type = created.data;
    const listed = await api('GET', '/api/v1/crm/activity-types', authed());
    // Custom types carry the version the editor must send back; built-ins have none.
    expect(listed.data.find((type: any) => type.id === created.data.id).version).toBe(created.data.version);
    expect(listed.data.find((type: any) => type.code === 'CALL').version).toBeUndefined();
    expectOk(listed);
    expect(listed.data.map((t: any) => t.code)).toEqual(expect.arrayContaining(['CALL', 'MEETING', 'SITE_VISIT']));
    expect(listed.data.map((t: any) => t.code)).not.toContain('REMINDER');
    expectOk(await api('GET', '/api/v1/crm/activity-types/[typeId]', authed({ params: { typeId: created.data.id } })));
    const patched = await api('PATCH', '/api/v1/crm/activity-types/[typeId]', authed({ params: { typeId: created.data.id }, body: { version: created.data.version, name: 'Site visit (on-site)' } }));
    expectOk(patched);
    expectError(await api('PATCH', '/api/v1/crm/activity-types/[typeId]', authed({ params: { typeId: created.data.id }, body: { version: created.data.version, name: 'stale' } })), 409, 'CONFIGURATION_VERSION_CONFLICT');
    expectError(await api('POST', '/api/v1/crm/activity-types', authed({ body: { code: 'CALL', name: 'Fake' } })), 409, 'ACTIVITY_TYPE_CODE_CONFLICT');
    expectOk(await api('POST', '/api/v1/crm/activity-types/[typeId]/disable', authed({ params: { typeId: created.data.id } })));
    expectError(await api('POST', '/api/v1/crm/activities', authed({ body: { typeCode: 'SITE_VISIT', subject: 'blocked' } })), 409, 'ACTIVITY_TYPE_DISABLED');
    expectOk(await api('POST', '/api/v1/crm/activity-types/[typeId]/enable', authed({ params: { typeId: created.data.id } })));
    expectError(await api('GET', '/api/v1/crm/activity-types/[typeId]', authed({ params: { typeId: MISSING_ID } })), 404, 'ACTIVITY_TYPE_NOT_FOUND');
    // Somebody outside the workspace cannot manage its types.
    expectError(await api('POST', '/api/v1/crm/activity-types', { token: ctx.other.token, workspaceId: ws.owner.workspaceId, body: { code: 'NOPE', name: 'x' } }), 403);
  });

  it('POST /crm/activities creates an Activity with bindings, communications, reminders and custom fields', async () => {
    const activityField = await api('POST', '/api/v1/crm/custom-fields', authed({ body: { entityType: 'ACTIVITY', label: 'Call outcome', code: 'call_outcome', fieldType: 'TEXT' } }));
    expectOk(activityField);
    const start = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const body = {
      typeCode: 'CALL',
      subject: 'Follow up on proposal',
      priority: 'HIGH',
      startAt: start,
      endAt: new Date(new Date(start).getTime() + 1_800_000).toISOString(),
      deadline: start,
      bindings: [{ entityType: 'DEAL', entityId: ctx.typedDeal.id }, { entityType: 'COMPANY', entityId: ctx.company.id }],
      communications: [{ type: 'PHONE', value: '+1 (202) 555-0123', crmEntityType: 'COMPANY', crmEntityId: ctx.company.id }],
      reminders: [{ mode: 'RELATIVE', relativeTo: 'START', offsetSeconds: -3600 }],
      customFields: { call_outcome: 'pending' },
    };
    const created = await api('POST', '/api/v1/crm/activities', authed({ headers: { 'idempotency-key': `act-${RUN}` }, body }));
    expectOk(created);
    act.call = created.data;
    expect(created.data).toMatchObject({ status: 'PLANNED', priority: 'HIGH', direction: 'OUTGOING', customFields: { call_outcome: 'pending' } });
    expect(created.data.bindings).toHaveLength(2);
    expect(created.data.communications[0].value).toBe('+12025550123');
    expect(created.data.reminders).toHaveLength(1);
    // The same idempotency key returns the same logical Activity.
    const replay = await api('POST', '/api/v1/crm/activities', authed({ headers: { 'idempotency-key': `act-${RUN}` }, body }));
    expect(replay.data.id).toBe(created.data.id);
    expectError(await api('POST', '/api/v1/crm/activities', authed({ headers: { 'idempotency-key': `act-${RUN}` }, body: { typeCode: 'CALL', subject: 'A different request' } })), 409, 'IDEMPOTENCY_CONFLICT');
    expectError(await api('POST', '/api/v1/crm/activities', authed({ body: { typeCode: 'NOPE', subject: 'x' } })), 404, 'ACTIVITY_TYPE_NOT_FOUND');
    expectError(await api('POST', '/api/v1/crm/activities', authed({ body: { typeCode: 'CALL', subject: 'x', startAt: 'soon' } })), 400, 'ACTIVITY_TIME_INVALID');
    expectError(await api('POST', '/api/v1/crm/activities', authed({ body: { typeCode: 'CALL', subject: 'x', bindings: [{ entityType: 'DEAL', entityId: MISSING_ID }] } })), 403, 'ACTIVITY_BINDING_FORBIDDEN');
    const { prisma } = await import('@/src/server/prisma-client');
    expect(await prisma.crmActivity.count({ where: { subject: 'Follow up on proposal' } })).toBe(1);
    expect(await prisma.crmActivityBinding.count({ where: { activityId: created.data.id } })).toBe(2);
    expect(await prisma.crmActivityReminder.count({ where: { activityId: created.data.id, status: 'SCHEDULED' } })).toBe(1);
    expect((await prisma.crmActivityCommunication.findFirst({ where: { activityId: created.data.id } }))!.normalizedValue).toBe('+12025550123');
  });

  it('GET /crm/activities lists My Open Activities with cursor pagination and filters', async () => {
    const second = await api('POST', '/api/v1/crm/activities', authed({ body: { typeCode: 'FOLLOW_UP', subject: `Overdue follow-up ${RUN}`, deadline: new Date(Date.now() - 3_600_000).toISOString() } }));
    expectOk(second);
    ctx.overdueActivity = second.data;
    const mine = await api('GET', '/api/v1/crm/activities', authed());
    expectOk(mine);
    expect(mine.body.meta).toMatchObject({ view: 'MY_OPEN', hasMore: false });
    expect(mine.data[0].id).toBe(second.data.id); // overdue first
    expect(mine.data[0].isOverdue).toBe(true);
    const page1 = await api('GET', '/api/v1/crm/activities', authed({ query: { limit: '1', view: 'ALL' } }));
    expect(page1.body.meta.hasMore).toBe(true);
    const page2 = await api('GET', '/api/v1/crm/activities', authed({ query: { limit: '1', view: 'ALL', cursor: page1.body.meta.nextCursor } }));
    expect(page2.data[0].id).not.toBe(page1.data[0].id);
    expect((await api('GET', '/api/v1/crm/activities', authed({ query: { typeCode: 'CALL', bindingEntityId: ctx.typedDeal.id, view: 'ALL' } }))).data.map((a: any) => a.id)).toEqual([act.call.id]);
    expect((await api('GET', '/api/v1/crm/activities', authed({ query: { overdue: 'true' } }))).data.map((a: any) => a.id)).toEqual([second.data.id]);
    expectError(await api('GET', '/api/v1/crm/activities', authed({ query: { status: 'BOGUS' } })), 400, 'CRM_QUERY_INVALID');
    expectError(await api('GET', '/api/v1/crm/activities', authed({ query: { cursor: '???' } })), 400, 'CRM_CURSOR_INVALID');
  });

  it('GET/PATCH /crm/activities/[activityId] read and update with optimistic concurrency', async () => {
    const got = await api('GET', '/api/v1/crm/activities/[activityId]', authed({ params: { activityId: act.call.id } }));
    expectOk(got);
    const patched = await api('PATCH', '/api/v1/crm/activities/[activityId]', authed({ params: { activityId: act.call.id }, body: { expectedVersion: got.data.version, subject: 'Follow up (patched)', description: 'notes' } }));
    expectOk(patched);
    expect(patched.data).toMatchObject({ subject: 'Follow up (patched)', version: got.data.version + 1 });
    expectError(await api('PATCH', '/api/v1/crm/activities/[activityId]', authed({ params: { activityId: act.call.id }, body: { expectedVersion: got.data.version, subject: 'stale' } })), 409, 'ACTIVITY_VERSION_CONFLICT');
    expectError(await api('PATCH', '/api/v1/crm/activities/[activityId]', authed({ params: { activityId: act.call.id }, body: { expectedVersion: patched.data.version, status: 'COMPLETED' } })), 400, 'ACTIVITY_STATUS_PATCH_FORBIDDEN');
    expectError(await api('GET', '/api/v1/crm/activities/[activityId]', authed({ params: { activityId: MISSING_ID } })), 404, 'ACTIVITY_NOT_FOUND');
    expectError(await api('GET', '/api/v1/crm/activities/[activityId]', { token: ctx.other.token, workspaceId: ws.owner.workspaceId, params: { activityId: act.call.id } }), 403);
  });

  it('runs the lifecycle commands: start, complete, cancel, reopen (with idempotency)', async () => {
    const id = act.call.id;
    expectOk(await api('POST', '/api/v1/crm/activities/[activityId]/start', authed({ params: { activityId: id }, body: {} })));
    const completeBody = { resultText: 'Customer requested revised pricing.', customFields: { call_outcome: 'FOLLOW_UP_REQUIRED' } };
    const done = await api('POST', '/api/v1/crm/activities/[activityId]/complete', authed({ params: { activityId: id }, headers: { 'idempotency-key': `done-${RUN}` }, body: completeBody }));
    expectOk(done);
    expect(done.data).toMatchObject({ status: 'COMPLETED', resultText: 'Customer requested revised pricing.', customFields: { call_outcome: 'FOLLOW_UP_REQUIRED' } });
    const replay = await api('POST', '/api/v1/crm/activities/[activityId]/complete', authed({ params: { activityId: id }, headers: { 'idempotency-key': `done-${RUN}` }, body: completeBody }));
    expect(replay.data.version).toBe(done.data.version);
    expectError(await api('POST', '/api/v1/crm/activities/[activityId]/start', authed({ params: { activityId: id }, body: {} })), 409, 'ACTIVITY_INVALID_TRANSITION');
    expectError(await api('PATCH', '/api/v1/crm/activities/[activityId]', authed({ params: { activityId: id }, body: { expectedVersion: done.data.version, subject: 'rewrite' } })), 409, 'ACTIVITY_EDIT_REQUIRES_REOPEN');
    const reopened = await api('POST', '/api/v1/crm/activities/[activityId]/reopen', authed({ params: { activityId: id }, body: { reason: 'Customer came back' } }));
    expect(reopened.data.status).toBe('IN_PROGRESS');
    const cancelled = await api('POST', '/api/v1/crm/activities/[activityId]/cancel', authed({ params: { activityId: id }, body: { reason: 'Deal lost' } }));
    expect(cancelled.data).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Deal lost' });
    expect((await api('POST', '/api/v1/crm/activities/[activityId]/reopen', authed({ params: { activityId: id }, body: {} }))).data.status).toBe('PLANNED');
    const { prisma } = await import('@/src/server/prisma-client');
    expect((await prisma.crmActivity.findUnique({ where: { id } }))!.status).toBe('PLANNED');
    expect(await prisma.outboxEvent.count({ where: { entityId: id, eventType: 'ACTIVITY_COMPLETED' } })).toBe(1);
  });

  it('manages bindings and reminders through their dedicated endpoints', async () => {
    const id = act.call.id;
    const lead = ctx.customLead;
    const added = await api('POST', '/api/v1/crm/activities/[activityId]/bindings', authed({ params: { activityId: id }, body: { entityType: 'LEAD', entityId: lead.id } }));
    expectOk(added);
    const bindings = await api('GET', '/api/v1/crm/activities/[activityId]/bindings', authed({ params: { activityId: id } }));
    expect(bindings.data.map((b: any) => b.entityType).sort()).toEqual(['COMPANY', 'DEAL', 'LEAD']);
    expectError(await api('POST', '/api/v1/crm/activities/[activityId]/bindings', authed({ params: { activityId: id }, body: { entityType: 'LEAD', entityId: lead.id } })), 409, 'ACTIVITY_BINDING_EXISTS');
    expectOk(await api('DELETE', '/api/v1/crm/activities/[activityId]/bindings/[bindingId]', authed({ params: { activityId: id, bindingId: added.data.id } })));
    expectError(await api('DELETE', '/api/v1/crm/activities/[activityId]/bindings/[bindingId]', authed({ params: { activityId: id, bindingId: added.data.id } })), 404, 'ACTIVITY_BINDING_NOT_FOUND');

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const reminder = await api('POST', '/api/v1/crm/activities/[activityId]/reminders', authed({ params: { activityId: id }, body: { mode: 'ABSOLUTE', absoluteAt: tomorrow } }));
    expectOk(reminder);
    const listed = await api('GET', '/api/v1/crm/activities/[activityId]/reminders', authed({ params: { activityId: id } }));
    expect(listed.data).toHaveLength(2);
    const updated = await api('PATCH', '/api/v1/crm/activities/[activityId]/reminders/[reminderId]', authed({ params: { activityId: id, reminderId: reminder.data.id }, body: { mode: 'ABSOLUTE', absoluteAt: new Date(Date.now() + 2 * 86_400_000).toISOString() } }));
    expectOk(updated);
    expectOk(await api('DELETE', '/api/v1/crm/activities/[activityId]/reminders/[reminderId]', authed({ params: { activityId: id, reminderId: reminder.data.id } })));
    expectError(await api('POST', '/api/v1/crm/activities/[activityId]/reminders', authed({ params: { activityId: id }, body: { mode: 'ABSOLUTE', absoluteAt: '2020-01-01T00:00:00Z' } })), 400, 'ACTIVITY_REMINDER_INVALID');
    expectError(await api('PATCH', '/api/v1/crm/activities/[activityId]/reminders/[reminderId]', authed({ params: { activityId: id, reminderId: MISSING_ID }, body: { mode: 'ABSOLUTE', absoluteAt: tomorrow } })), 404, 'ACTIVITY_REMINDER_NOT_FOUND');
  });

  it('DELETE and POST /restore soft-delete and bring an Activity back', async () => {
    const created = await api('POST', '/api/v1/crm/activities', authed({ body: { typeCode: 'FOLLOW_UP', subject: `Recyclable ${RUN}`, bindings: [{ entityType: 'DEAL', entityId: ctx.typedDeal.id }] } }));
    const id = created.data.id;
    expectOk(await api('DELETE', '/api/v1/crm/activities/[activityId]', authed({ params: { activityId: id } })));
    expectError(await api('GET', '/api/v1/crm/activities/[activityId]', authed({ params: { activityId: id } })), 404, 'ACTIVITY_NOT_FOUND');
    expect((await api('GET', '/api/v1/crm/activities/[activityId]', authed({ params: { activityId: id }, query: { includeDeleted: 'true' } }))).data.isDeleted).toBe(true);
    const { prisma } = await import('@/src/server/prisma-client');
    expect((await prisma.crmActivity.findUnique({ where: { id } }))!.isDeleted).toBe(true);
    const restored = await api('POST', '/api/v1/crm/activities/[activityId]/restore', authed({ params: { activityId: id }, body: {} }));
    expectOk(restored);
    expect(restored.data.isDeleted).toBe(false);
    expectOk(await api('GET', '/api/v1/crm/activities/[activityId]', authed({ params: { activityId: id } })));
  });

  it('POST /crm/activities/bulk reports per-item outcomes', async () => {
    const a = (await api('POST', '/api/v1/crm/activities', authed({ body: { typeCode: 'FOLLOW_UP', subject: `Bulk A ${RUN}` } }))).data;
    const b = (await api('POST', '/api/v1/crm/activities', authed({ body: { typeCode: 'FOLLOW_UP', subject: `Bulk B ${RUN}` } }))).data;
    const res = await api('POST', '/api/v1/crm/activities/bulk', authed({ headers: { 'idempotency-key': `bulk-${RUN}` }, body: { operation: 'COMPLETE', activityIds: [a.id, MISSING_ID, b.id] } }));
    expectOk(res);
    expect(res.data).toMatchObject({ succeeded: 2, failed: 1 });
    expect(res.data.results.map((r: any) => r.code ?? 'ok')).toEqual(['ok', 'ACTIVITY_NOT_FOUND', 'ok']);
    expectError(await api('POST', '/api/v1/crm/activities/bulk', authed({ body: { operation: 'COMPLETE', activityIds: Array.from({ length: 101 }, () => MISSING_ID) } })), 400, 'ACTIVITY_BULK_LIMIT_EXCEEDED');
    expectError(await api('POST', '/api/v1/crm/activities/bulk', authed({ body: { operation: 'EXPLODE', activityIds: [a.id] } })), 400, 'ACTIVITY_BULK_OPERATION_INVALID');
  });
});

describe('Timeline API', () => {
  it('GET /crm/[entityType]/[entityId]/timeline projects activity and CRM events for the record', async () => {
    const res = await api('GET', '/api/v1/crm/[entityType]/[entityId]/timeline', authed({ params: { entityType: 'deals', entityId: ctx.typedDeal.id } }));
    expectOk(res);
    const codes = res.data.map((entry: any) => entry.summaryCode);
    expect(codes).toEqual(expect.arrayContaining(['CRM_RECORD_CREATED', 'ACTIVITY_CREATED', 'ACTIVITY_COMPLETED', 'ACTIVITY_CANCELLED', 'ACTIVITY_REOPENED']));
    expect(res.body.meta).toMatchObject({ limit: 50, hasMore: false, nextCursor: null });
    const paged = await api('GET', '/api/v1/crm/[entityType]/[entityId]/timeline', authed({ params: { entityType: 'DEAL', entityId: ctx.typedDeal.id }, query: { limit: '2' } }));
    expect(paged.body.meta.hasMore).toBe(true);
    const next = await api('GET', '/api/v1/crm/[entityType]/[entityId]/timeline', authed({ params: { entityType: 'DEAL', entityId: ctx.typedDeal.id }, query: { limit: '2', cursor: paged.body.meta.nextCursor } }));
    expect(next.data.map((e: any) => e.id).some((id: string) => paged.data.map((e: any) => e.id).includes(id))).toBe(false);
    expect((await api('GET', '/api/v1/crm/[entityType]/[entityId]/timeline', authed({ params: { entityType: 'DEAL', entityId: ctx.typedDeal.id }, query: { category: 'STAGE_CHANGE' } }))).data).toEqual([]);
    expectError(await api('GET', '/api/v1/crm/[entityType]/[entityId]/timeline', authed({ params: { entityType: 'DEAL', entityId: MISSING_ID } })), 403, 'TIMELINE_ACCESS_FORBIDDEN');
    expectError(await api('GET', '/api/v1/crm/[entityType]/[entityId]/timeline', authed({ params: { entityType: 'robots', entityId: ctx.typedDeal.id } })), 400);
    const { prisma } = await import('@/src/server/prisma-client');
    expect(await prisma.crmTimelineEntry.count({ where: { entityId: ctx.typedDeal.id } })).toBeGreaterThanOrEqual(5);
    expect(await prisma.outboxEvent.count({ where: { projectedAt: null, workspaceId: ws.owner.workspaceId } })).toBe(0);
  });

  it('POST/GET/PATCH/DELETE comments cover mentions, linked activities, edit and soft delete', async () => {
    const commentBody = { body: 'Customer confirmed the scope. <b>bold</b>', mentions: [{ userId: ws.owner.userId }], linkedActivityId: ctx.act.call.id };
    const created = await api('POST', '/api/v1/crm/[entityType]/[entityId]/timeline/comments', authed({ params: { entityType: 'deals', entityId: ctx.typedDeal.id }, headers: { 'idempotency-key': `comment-${RUN}` }, body: commentBody }));
    expectOk(created);
    expect(created.data).toMatchObject({ body: 'Customer confirmed the scope. bold', version: 1, linkedActivityId: ctx.act.call.id, mentions: [{ userId: ws.owner.userId }] });
    const replay = await api('POST', '/api/v1/crm/[entityType]/[entityId]/timeline/comments', authed({ params: { entityType: 'deals', entityId: ctx.typedDeal.id }, headers: { 'idempotency-key': `comment-${RUN}` }, body: commentBody }));
    expect(replay.data.id).toBe(created.data.id);
    expectOk(await api('GET', '/api/v1/crm/timeline/comments/[commentId]', authed({ params: { commentId: created.data.id } })));
    const timeline = await api('GET', '/api/v1/crm/[entityType]/[entityId]/timeline', authed({ params: { entityType: 'DEAL', entityId: ctx.typedDeal.id }, query: { category: 'COMMENT' } }));
    expect(timeline.data).toHaveLength(1);
    const edited = await api('PATCH', '/api/v1/crm/timeline/comments/[commentId]', authed({ params: { commentId: created.data.id }, body: { expectedVersion: 1, body: 'Edited text' } }));
    expectOk(edited);
    expect(edited.data).toMatchObject({ body: 'Edited text', version: 2, edited: true });
    expectError(await api('PATCH', '/api/v1/crm/timeline/comments/[commentId]', authed({ params: { commentId: created.data.id }, body: { expectedVersion: 1, body: 'stale' } })), 409, 'TIMELINE_COMMENT_VERSION_CONFLICT');
    const deleted = await api('DELETE', '/api/v1/crm/timeline/comments/[commentId]', authed({ params: { commentId: created.data.id } }));
    expectOk(deleted);
    expect(deleted.data).toMatchObject({ isDeleted: true, body: null });
    const { prisma } = await import('@/src/server/prisma-client');
    expect(await prisma.crmTimelineComment.findUnique({ where: { id: created.data.id } })).toMatchObject({ isDeleted: true, body: 'Edited text', version: 3 });
    expect(await prisma.crmTimelineCommentMention.count({ where: { commentId: created.data.id } })).toBe(1);
    expectError(await api('POST', '/api/v1/crm/[entityType]/[entityId]/timeline/comments', authed({ params: { entityType: 'DEAL', entityId: ctx.typedDeal.id }, body: { body: '   ' } })), 400, 'FIELD_VALIDATION_FAILED');
    expectError(await api('POST', '/api/v1/crm/[entityType]/[entityId]/timeline/comments', authed({ params: { entityType: 'DEAL', entityId: ctx.typedDeal.id }, body: { body: 'x', fileIds: [MISSING_ID] } })), 400, 'FILES_UNAVAILABLE');
    expectError(await api('GET', '/api/v1/crm/timeline/comments/[commentId]', authed({ params: { commentId: MISSING_ID } })), 404, 'TIMELINE_COMMENT_NOT_FOUND');
    expectError(await api('POST', '/api/v1/crm/[entityType]/[entityId]/timeline/comments', { token: ctx.other.token, workspaceId: ws.owner.workspaceId, params: { entityType: 'DEAL', entityId: ctx.typedDeal.id }, body: { body: 'intruder' } }), 403);
  });
});

describe('Realtime and operational jobs', () => {
  it('GET /crm/realtime opens an authenticated event stream', async () => {
    const res = await api('GET', '/api/v1/crm/realtime', authed({ stream: true }));
    expect(res.status).toBe(200);
    expectError(await api('GET', '/api/v1/crm/realtime', { workspaceId: ws.owner.workspaceId }), 401, 'UNAUTHENTICATED');
    expectError(await api('GET', '/api/v1/crm/realtime', { token: ws.owner.token }), 400, 'WORKSPACE_REQUIRED');
  });

  it('POST /internal/crm/jobs/[job] runs idempotent scheduler jobs only with the job token', async () => {
    process.env.INTERNAL_JOB_TOKEN = 'test-job-token-0123456789';
    const headers = { 'x-internal-job-token': 'test-job-token-0123456789' };
    const run = (job: string, body: Record<string, unknown> = {}, extra: Record<string, string> = headers) => api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job }, headers: extra, body });
    const overdue = await run('overdue');
    expectOk(overdue);
    expect(overdue.data.emitted).toBeGreaterThanOrEqual(1); // the overdue follow-up created above
    const again = await run('overdue');
    expect(again.data.emitted).toBe(0); // exactly once per deadline occurrence, even across requests
    const { prisma } = await import('@/src/server/prisma-client');
    expect(await prisma.crmActivityOverdueOccurrence.count({ where: { activityId: ctx.overdueActivity.id } })).toBe(1);
    expectOk(await run('reminders'));
    expectOk(await run('timeline-project'));
    const before = await prisma.crmTimelineEntry.count({ where: { workspaceId: ws.owner.workspaceId } });
    expectOk(await run('timeline-rebuild', { workspaceId: ws.owner.workspaceId }));
    expect(await prisma.crmTimelineEntry.count({ where: { workspaceId: ws.owner.workspaceId } })).toBe(before); // rebuild is idempotent
    expect(await prisma.crmTimelineComment.count({ where: { workspaceId: ws.owner.workspaceId } })).toBeGreaterThanOrEqual(1); // comments untouched
    expectError(await run('timeline-rebuild'), 400, 'WORKSPACE_REQUIRED');
    expectError(await run('bogus'), 400, 'JOB_UNKNOWN');
    expectError(await run('overdue', {}, { 'x-internal-job-token': 'wrong' }), 401, 'UNAUTHENTICATED');
    expectError(await run('overdue', {}, {}), 401, 'UNAUTHENTICATED');
    // A user bearer token is not a job credential.
    expectError(await api('POST', '/api/v1/internal/crm/jobs/[job]', authed({ params: { job: 'overdue' }, body: {} })), 401, 'UNAUTHENTICATED');
    delete process.env.INTERNAL_JOB_TOKEN;
    expectError(await run('overdue'), 401, 'UNAUTHENTICATED'); // disabled when unconfigured
  });
});

describe('Cross-cutting behaviour', () => {
  // Everything under app/ is locked behind a bearer token unless it is listed here. A newly added
  // route therefore fails this test until it either checks the token or is consciously allow-listed.
  const PUBLIC_ENDPOINTS = new Set([
    'GET /',
    'GET /swagger',
    'GET /api/docs',
    'POST /api/v1/auth/signup',
    'POST /api/v1/auth/signin',
    'POST /api/v1/auth/google/signup',
    'POST /api/v1/auth/google/signin',
    'POST /api/v1/auth/verify-email',
    'POST /api/v1/auth/resend-verification',
    'POST /api/v1/auth/forgot-password',
    'POST /api/v1/auth/reset-password',
    // Authenticated by the refresh token in the body, so an expired access token still works.
    'POST /api/v1/auth/refresh',
    'POST /api/v1/auth/logout',
  ]);

  it('only the allow-listed public endpoints exist without a bearer token', async () => {
    const all = await discoverEndpoints();
    for (const endpoint of PUBLIC_ENDPOINTS) expect(all).toContain(endpoint);

    const leaks: string[] = [];
    for (const endpoint of all.filter((item) => !PUBLIC_ENDPOINTS.has(item))) {
      const [method, template] = endpoint.split(' ');
      const params = Object.fromEntries([...template.matchAll(/\[(\w+)\]/g)].map((match) => [match[1], MISSING_ID]));
      for (const token of [undefined, 'garbage']) {
        const res = await api(method as any, template, { params, token, workspaceId: ws.owner.workspaceId });
        if (res.status !== 401 || res.body?.error?.code !== 'UNAUTHENTICATED') {
          leaks.push(`  -> ${res.status}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it('rejects a valid token that belongs to a deleted user', async () => {
    const user = await register('deleted-token');
    expectOk(await api('DELETE', '/api/v1/users/[id]', { token: user.token, params: { id: user.userId } }));
    expectError(await api('GET', '/api/v1/auth/me', { token: user.token }), 401, 'UNAUTHENTICATED');
  });
  it('isolates CRM data between workspaces', async () => {
    const other = await api('POST', '/api/v1/workspaces', { token: ws.owner.token, body: { name: `Isolated ${RUN}` } });
    expectOk(other);
    const leads = await api('GET', '/api/v1/crm/leads', { token: ws.owner.token, workspaceId: other.data.id });
    expectOk(leads);
    expect(leads.data).toHaveLength(0);
    const foreignLead = await api('POST', '/api/v1/crm/leads/[id]/archive', { token: ws.owner.token, workspaceId: other.data.id, params: { id: ctx.lead.id } });
    expectError(foreignLead, 404);
  });

  it('rejects a workspace the caller is not a member of', async () => {
    const res = await api('GET', '/api/v1/crm/leads', { token: ctx.other.token, workspaceId: ws.owner.workspaceId });
    expectError(res, 403);
  });

  it('answers malformed JSON with 400 instead of a server error', async () => {
    const { NextRequest } = await import('next/server');
    const { POST } = await import('@/app/api/v1/crm/companies/route');
    const request = new NextRequest('http://localhost/api/v1/crm/companies', {
      method: 'POST',
      headers: { authorization: `Bearer ${ws.owner.token}`, 'x-workspace-id': ws.owner.workspaceId, 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await POST(request);
    expect(res.status).toBe(400);
  });

  it('persists data across requests through the database layer', async () => {
    const { prisma } = await import('@/src/server/prisma-client');
    expect(await prisma.crmLead.count({ where: { workspaceId: ws.owner.workspaceId } })).toBeGreaterThanOrEqual(2);
    expect(await prisma.crmDeal.count({ where: { workspaceId: ws.owner.workspaceId } })).toBeGreaterThanOrEqual(2);
    expect(await prisma.user.count({ where: { email: ws.owner.email } })).toBe(1);
  });

  it('exercises every route handler exposed under app/', async () => {
    const all = await discoverEndpoints();
    const covered = coveredEndpoints();
    const missing = all.filter((endpoint) => !covered.has(endpoint));
    expect(all.length).toBeGreaterThan(130);
    expect(missing).toEqual([]);
    // Rejecting a request is not enough: every protected endpoint must also have been exercised with real credentials.
    const authenticated = coveredAuthenticatedEndpoints();
    const neverAuthenticated = all.filter((endpoint) => !PUBLIC_ENDPOINTS.has(endpoint) && !authenticated.has(endpoint));
    expect(neverAuthenticated).toEqual([]);
  });
});
