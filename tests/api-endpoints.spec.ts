/**
 * HTTP-level tests for every route handler under app/. Requests go through the real Next route
 * handlers, the real persistence layer and a throwaway Postgres database (entertabcrm_test),
 * which is recreated and migrated at the start of the run.
 */
import { api, coveredEndpoints, disconnectTestDatabase, discoverEndpoints, prepareTestDatabase } from './support/api';

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

describe('Cross-cutting behaviour', () => {
  const protectedEndpoints: Array<[string, string, Record<string, string>]> = [
    ['GET', '/api/v1/audit-logs', {}],
    ['GET', '/api/v1/audit-logs/[id]', { id: MISSING_ID }],
    ['GET', '/api/v1/auth/me', {}],
    ['POST', '/api/v1/auth/logout-all', {}],
    ['GET', '/api/v1/permissions', {}],
    ['GET', '/api/v1/roles', {}],
    ['POST', '/api/v1/roles', {}],
    ['DELETE', '/api/v1/roles/[id]', { id: MISSING_ID }],
    ['PUT', '/api/v1/roles/[id]/permissions', { id: MISSING_ID }],
    ['GET', '/api/v1/users', {}],
    ['POST', '/api/v1/users', {}],
    ['GET', '/api/v1/users/[id]', { id: MISSING_ID }],
    ['PATCH', '/api/v1/users/[id]', { id: MISSING_ID }],
    ['DELETE', '/api/v1/users/[id]', { id: MISSING_ID }],
    ['GET', '/api/v1/workspaces', {}],
    ['POST', '/api/v1/workspaces', {}],
    ['GET', '/api/v1/workspaces/[id]', { id: MISSING_ID }],
    ['POST', '/api/v1/workspaces/[id]/switch', { id: MISSING_ID }],
    ['GET', '/api/v1/departments', {}],
    ['POST', '/api/v1/department-members', {}],
    ['POST', '/api/v1/partners/applications', {}],
    ['GET', '/api/v1/crm/leads', {}],
    ['POST', '/api/v1/crm/leads', {}],
    ['POST', '/api/v1/crm/leads/[id]/transition', { id: MISSING_ID }],
    ['GET', '/api/v1/crm/contacts', {}],
    ['GET', '/api/v1/crm/companies', {}],
    ['GET', '/api/v1/crm/deals', {}],
    ['POST', '/api/v1/crm/deals/[id]/transition', { id: MISSING_ID }],
    ['GET', '/api/v1/crm/pipelines', {}],
    ['POST', '/api/v1/crm/pipelines', {}],
    ['GET', '/api/v1/crm/sources', {}],
  ];

  it.each(protectedEndpoints)('%s %s returns 401 without a token', async (method, template, params) => {
    const res = await api(method as any, template, { params });
    expectError(res, 401, 'UNAUTHENTICATED');
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
    expect(all.length).toBeGreaterThan(80);
    expect(missing).toEqual([]);
  });
});
