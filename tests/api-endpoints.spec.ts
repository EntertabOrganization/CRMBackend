/**
 * HTTP-level tests for every route handler under app/. Requests go through the real Next route
 * handlers, the real persistence layer and a throwaway Postgres database (entertabcrm_test),
 * which is recreated and migrated at the start of the run.
 */
import { resetRateLimits } from '@/src/server/rate-limit';
import { api, coveredAuthenticatedEndpoints, coveredEndpoints, disconnectTestDatabase, discoverEndpoints, prepareTestDatabase } from './support/api';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

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

async function sentMail() {
  const mailbox = process.env.TEST_MAILBOX_FILE;
  if (process.env.API_TEST_BASE_URL && mailbox) {
    if (!fs.existsSync(mailbox)) return [];
    return fs.readFileSync(mailbox, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }
  const { appContext } = await import('@/src/server/app-context');
  return appContext.mailer.sent;
}

async function addGoogleCredential(credential: string, profile: Record<string, unknown>) {
  const fixturePath = process.env.TEST_GOOGLE_PROFILES_FILE;
  if (process.env.API_TEST_BASE_URL && fixturePath) {
    const fixtures = fs.existsSync(fixturePath) ? JSON.parse(fs.readFileSync(fixturePath, 'utf8') || '{}') : {};
    fixtures[credential] = profile;
    fs.writeFileSync(fixturePath, JSON.stringify(fixtures), 'utf8');
    return;
  }
  const { appContext } = await import('@/src/server/app-context');
  appContext.google.addCredential(credential, profile as any);
}

function configureInternalJobToken(token?: string) {
  if (token) process.env.INTERNAL_JOB_TOKEN = token;
  else delete process.env.INTERNAL_JOB_TOKEN;
  const fixturePath = process.env.TEST_INTERNAL_JOB_TOKEN_FILE;
  if (process.env.API_TEST_BASE_URL && fixturePath) fs.writeFileSync(fixturePath, token ?? '', 'utf8');
}

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
}, 300_000);

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

  it('GET /api/v1/health/ready confirms database and migration readiness', async () => {
    const res = await api('GET', '/api/v1/health/ready');
    expectOk(res);
    expect(res.data).toMatchObject({ status: 'ready', database: 'available' });
    expect(res.data.appliedMigrations).toBeGreaterThan(0);
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

    const mail = [...await sentMail()].reverse().find((item) => item.to === ctx.signup.email && item.token);
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

    const mail = [...await sentMail()].reverse().find((item) => item.to === user.email && item.subject.startsWith('Reset'));
    expect(mail?.token).toBeTruthy();

    expectError(await api('POST', '/api/v1/auth/reset-password', { body: { token: mail!.token, password: 'weak' } }), 400);
    expectOk(await api('POST', '/api/v1/auth/reset-password', { body: { token: mail!.token, password: 'NewPassword1' } }));
    expectError(await api('POST', '/api/v1/auth/reset-password', { body: { token: mail!.token, password: 'NewPassword2' } }), 400);
    expectOk(await api('POST', '/api/v1/auth/signin', { body: { email: user.email, password: 'NewPassword1' } }));
    expectError(await api('POST', '/api/v1/auth/signin', { body: { email: user.email, password: PASSWORD } }), 401);
  });

  it('POST /auth/google/signup and /auth/google/signin authenticate a verified Google profile', async () => {
    const email = `apitest-google-${RUN}@example.com`;
    await addGoogleCredential(`cred-${RUN}`, {
      providerUserId: `google-${RUN}`,
      email,
      emailVerified: true,
      firstName: 'Goo',
      lastName: 'Gle',
    });
    await addGoogleCredential(`unverified-${RUN}`, {
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
    // Decision D3: Platform Admin authority is an explicit platform role, not an email domain.
    expectError(await api('POST', '/api/v1/partners/applications/[id]/approve', { token: admin.token, params: { id: ctx.application.id } }), 403);
    const { prisma } = await import('@/src/server/prisma-client');
    await prisma.platformRoleAssignment.create({ data: { userId: admin.userId, role: 'PLATFORM_ADMIN', permissions: ['platform.partner.application.approve', 'platform.partner.application.review'], mfaRequired: false } });
    const approved = await api('POST', '/api/v1/partners/applications/[id]/approve', { token: admin.token, params: { id: ctx.application.id } });
    expectOk(approved);
    // Same legacy key replays the original result instead of creating a second Partner.
    const replay = await api('POST', '/api/v1/partners/applications/[id]/approve', { token: admin.token, params: { id: ctx.application.id } });
    expectOk(replay);
    expect(replay.data.partnerId).toBe(approved.data.partnerId);
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
    expectError(await api('POST', '/api/v1/crm/[entityType]/[entityId]/timeline/comments', authed({ params: { entityType: 'DEAL', entityId: ctx.typedDeal.id }, body: { body: 'x', fileIds: [MISSING_ID] } })), 400, 'FIELD_REFERENCE_INVALID');
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
    configureInternalJobToken('test-job-token-0123456789');
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
    expectOk(await run('calendar-reminders', { limit: 10 }));
    expectError(await run('calendar-reminders', { limit: 0 }), 400, 'VALIDATION_ERROR');
    expectError(await run('calendar-reminders', {}, { 'x-internal-job-token': 'wrong' }), 401, 'UNAUTHENTICATED');
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
    configureInternalJobToken();
    expectError(await run('overdue'), 401, 'UNAUTHENTICATED'); // disabled when unconfigured
  });
});

describe('Products & Catalog API', () => {
  beforeEach(() => resetRateLimits());
  const call = (method: any, template: string, options: Record<string, unknown> = {}) => api(method, template, authed(options));

  it('manages Catalogs, categories, Units and Price Types through their endpoints', async () => {
    const catalogs = await call('GET', '/api/v1/catalogs');
    expectOk(catalogs);
    ctx.catalog = catalogs.data.find((c: any) => c.isDefault);
    expect(catalogs.data.filter((c: any) => c.isDefault)).toHaveLength(1);
    const second = await call('POST', '/api/v1/catalogs', { body: { name: `Wholesale ${RUN}`, code: `WS${RUN % 100000}` } });
    expectOk(second);
    expectOk(await call('GET', '/api/v1/catalogs/[catalogId]', { params: { catalogId: second.data.id } }));
    const patched = await call('PATCH', '/api/v1/catalogs/[catalogId]', { params: { catalogId: second.data.id }, body: { version: second.data.version, description: 'B2B' } });
    expectOk(patched);
    expectError(await call('PATCH', '/api/v1/catalogs/[catalogId]', { params: { catalogId: second.data.id }, body: { version: second.data.version, description: 'stale' } }), 409, 'CATALOG_VERSION_CONFLICT');
    expectOk(await call('POST', '/api/v1/catalogs/[catalogId]/set-default', { params: { catalogId: second.data.id } }));
    expectOk(await call('POST', '/api/v1/catalogs/[catalogId]/set-default', { params: { catalogId: ctx.catalog.id } }));
    expectError(await call('GET', '/api/v1/catalogs/[catalogId]', { params: { catalogId: MISSING_ID } }), 404, 'CATALOG_NOT_FOUND');

    const categoryPath = { catalogId: ctx.catalog.id };
    const root = await call('POST', '/api/v1/catalogs/[catalogId]/categories', { params: categoryPath, body: { name: 'Apparel' } });
    const other = await call('POST', '/api/v1/catalogs/[catalogId]/categories', { params: categoryPath, body: { name: 'Gear' } });
    const child = await call('POST', '/api/v1/catalogs/[catalogId]/categories', { params: categoryPath, body: { name: 'Shirts', parentId: root.data.id } });
    expectOk(root);
    expectOk(child);
    ctx.category = root.data;
    ctx.childCategory = child.data;
    const tree = await call('GET', '/api/v1/catalogs/[catalogId]/categories', { params: categoryPath, query: { format: 'tree' } });
    expectOk(tree);
    expect(tree.data.find((node: any) => node.id === root.data.id).children[0].id).toBe(child.data.id);
    expectOk(await call('GET', '/api/v1/catalogs/[catalogId]/categories/[categoryId]', { params: { ...categoryPath, categoryId: root.data.id } }));
    expectOk(await call('PATCH', '/api/v1/catalogs/[catalogId]/categories/[categoryId]', { params: { ...categoryPath, categoryId: other.data.id }, body: { version: other.data.version, name: 'Equipment' } }));
    expectOk(await call('POST', '/api/v1/catalogs/[catalogId]/categories/reorder', { params: categoryPath, body: { parentId: null, orderedIds: [other.data.id, root.data.id] } }));
    expectError(await call('POST', '/api/v1/catalogs/[catalogId]/categories/[categoryId]/move', { params: { ...categoryPath, categoryId: root.data.id }, body: { parentId: child.data.id } }), 409, 'CATEGORY_CYCLE');
    expectOk(await call('POST', '/api/v1/catalogs/[catalogId]/categories/[categoryId]/move', { params: { ...categoryPath, categoryId: other.data.id }, body: { parentId: root.data.id } }));
    expectError(await call('DELETE', '/api/v1/catalogs/[catalogId]/categories/[categoryId]', { params: { ...categoryPath, categoryId: root.data.id } }), 409, 'CATEGORY_HAS_DEPENDENCIES');
    expectOk(await call('DELETE', '/api/v1/catalogs/[catalogId]/categories/[categoryId]', { params: { ...categoryPath, categoryId: other.data.id } }));

    const units = await call('GET', '/api/v1/catalog/units');
    expectOk(units);
    expect(units.data.map((u: any) => u.code)).toEqual(expect.arrayContaining(['PIECE', 'BOX', 'HOUR']));
    ctx.units = units.data;
    const crate = await call('POST', '/api/v1/catalog/units', { body: { code: 'crate', name: 'Crate', precision: 0 } });
    expectOk(crate);
    expectOk(await call('GET', '/api/v1/catalog/units/[unitId]', { params: { unitId: crate.data.id } }));
    expectOk(await call('PATCH', '/api/v1/catalog/units/[unitId]', { params: { unitId: crate.data.id }, body: { version: crate.data.version, name: 'Wooden crate' } }));
    expectError(await call('POST', '/api/v1/catalog/units', { body: { code: 'CRATE', name: 'dup' } }), 409, 'UNIT_CODE_CONFLICT');

    const types = await call('GET', '/api/v1/catalog/price-types');
    expectOk(types);
    ctx.baseType = types.data.find((t: any) => t.isBase);
    const retail = await call('POST', '/api/v1/catalog/price-types', { body: { code: 'retail', name: 'Retail' } });
    expectOk(retail);
    ctx.retailType = retail.data;
    expectOk(await call('GET', '/api/v1/catalog/price-types/[priceTypeId]', { params: { priceTypeId: retail.data.id } }));
    expectOk(await call('PATCH', '/api/v1/catalog/price-types/[priceTypeId]', { params: { priceTypeId: retail.data.id }, body: { version: retail.data.version, name: 'Retail price' } }));
    expectOk(await call('POST', '/api/v1/catalog/price-types/[priceTypeId]/set-base', { params: { priceTypeId: retail.data.id } }));
    expectOk(await call('POST', '/api/v1/catalog/price-types/[priceTypeId]/set-base', { params: { priceTypeId: ctx.baseType.id } }));
    expectError(await call('PATCH', '/api/v1/catalog/price-types/[priceTypeId]', { params: { priceTypeId: ctx.baseType.id }, body: { version: 1, isActive: false } }), 409);
  });

  it('manages Product properties through the shared field engine', async () => {
    const color = await call('POST', '/api/v1/catalog/properties', { body: { label: `Color ${RUN}`, fieldType: 'LIST', options: [{ code: 'red', label: 'Red' }, { code: 'blue', label: 'Blue' }], catalog: { variantAxis: true } } });
    expectOk(color);
    ctx.color = color.data;
    const material = await call('POST', '/api/v1/catalog/properties', { body: { label: `Material ${RUN}`, fieldType: 'TEXT', catalog: { filterable: true } } });
    expectOk(material);
    ctx.material = material.data;
    const listed = await call('GET', '/api/v1/catalog/properties');
    expectOk(listed);
    expect(listed.data.map((p: any) => p.id)).toEqual(expect.arrayContaining([color.data.id, material.data.id]));
    expectOk(await call('PATCH', '/api/v1/catalog/properties/[propertyId]', { params: { propertyId: material.data.id }, body: { version: material.data.version, label: `Material ${RUN}!` } }));
    const settings = await call('PATCH', '/api/v1/catalog/properties/[propertyId]/catalog-settings', { params: { propertyId: material.data.id }, body: { version: material.data.catalog.version, searchable: true, displayInList: true } });
    expectOk(settings);
    expect(settings.data.catalog).toMatchObject({ searchable: true, filterable: true });
    expectError(await call('PATCH', '/api/v1/catalog/properties/[propertyId]/catalog-settings', { params: { propertyId: material.data.id }, body: { version: settings.data.catalog.version, variantAxis: true } }), 400, 'PROPERTY_AXIS_TYPE_INVALID');
    const options = await call('GET', '/api/v1/catalog/properties/[propertyId]/options', { params: { propertyId: color.data.id } });
    expectOk(options);
    ctx.colorOptions = options.data;
    const added = await call('POST', '/api/v1/catalog/properties/[propertyId]/options', { params: { propertyId: color.data.id }, body: { code: 'green', label: 'Green' } });
    expectOk(added);
    expectOk(await call('PATCH', '/api/v1/catalog/properties/[propertyId]/options/[optionId]', { params: { propertyId: color.data.id, optionId: added.data.id }, body: { label: 'Forest green', version: added.data.version } }));
    const refreshed = await call('GET', '/api/v1/catalog/properties');
    const all = refreshed.data.map((p: any) => p.id);
    expectOk(await call('POST', '/api/v1/catalog/properties/reorder', { body: { orderedFieldIds: [...all].reverse(), expectedSchemaVersion: refreshed.data[0].schemaVersion } }));
  });

  it('creates Products, generates a Variant matrix and manages prices, ratios, media and lifecycle', async () => {
    const unit = (code: string) => ctx.units.find((u: any) => u.code === code);
    const parent = await call('POST', '/api/v1/catalog/products', {
      body: { type: 'PRODUCT_WITH_VARIANTS', name: `Shirt ${RUN}`, description: 'Cotton', variantAxes: [ctx.color.id], categoryIds: [ctx.childCategory.id], customFields: {}, taxable: true, taxRate: '15' },
      headers: { 'idempotency-key': `parent-${RUN}` },
    });
    expectOk(parent);
    ctx.parent = parent.data;
    const replay = await call('POST', '/api/v1/catalog/products', {
      body: { type: 'PRODUCT_WITH_VARIANTS', name: `Shirt ${RUN}`, description: 'Cotton', variantAxes: [ctx.color.id], categoryIds: [ctx.childCategory.id], customFields: {}, taxable: true, taxRate: '15' },
      headers: { 'idempotency-key': `parent-${RUN}` },
    });
    expect(replay.data.id).toBe(parent.data.id);
    expectError(await call('POST', '/api/v1/catalog/products', { body: { type: 'SIMPLE_PRODUCT', name: 'x', sku: 's', version: 3 } }), 400, 'CATALOG_FIELD_NOT_UPDATABLE');
    expectOk(await call('GET', '/api/v1/catalog/products/[productId]', { params: { productId: parent.data.id } }));
    expectError(await call('GET', '/api/v1/catalog/products/[productId]', { params: { productId: MISSING_ID } }), 404, 'PRODUCT_NOT_FOUND');

    const optionIds = ctx.colorOptions.map((o: any) => o.id);
    const matrix = { axes: [{ fieldId: ctx.color.id, optionIds }], skuPrefix: `SH${RUN}` };
    const preview = await call('POST', '/api/v1/catalog/products/[productId]/variants/generate', { params: { productId: parent.data.id }, body: { ...matrix, preview: true } });
    expectOk(preview);
    expect(preview.data.totals).toMatchObject({ combinations: 2, new: 2 });
    const generated = await call('POST', '/api/v1/catalog/products/[productId]/variants/generate', { params: { productId: parent.data.id }, body: matrix });
    expectOk(generated);
    expect(generated.data.applied.created).toBe(2);
    expect((await call('POST', '/api/v1/catalog/products/[productId]/variants/generate', { params: { productId: parent.data.id }, body: matrix })).data.applied.created).toBe(0);
    const variants = await call('GET', '/api/v1/catalog/products/[productId]/variants', { params: { productId: parent.data.id } });
    expectOk(variants);
    expect(variants.data).toHaveLength(2);
    ctx.variant = variants.data[0];
    const extra = await call('POST', '/api/v1/catalog/products/[productId]/variants', { params: { productId: parent.data.id }, body: { sku: `SH${RUN}-EXTRA`, axisValues: [{ fieldId: ctx.color.id, optionId: ctx.colorOptions.find((o: any) => o.code === 'green')?.id ?? optionIds[0] }] } });
    expect([200, 409]).toContain(extra.status);
    const detail = await call('GET', '/api/v1/catalog/variants/[variantId]', { params: { variantId: ctx.variant.id } });
    expectOk(detail);
    expect(detail.data.inherited.description).toBe(true);
    expect(detail.data.description).toBe('Cotton');
    const updatedVariant = await call('PATCH', '/api/v1/catalog/variants/[variantId]', { params: { variantId: ctx.variant.id }, body: { version: detail.data.version, description: 'Special edition' } });
    expectOk(updatedVariant);
    expect(updatedVariant.data.inherited.description).toBe(false);
    expectOk(await call('PATCH', '/api/v1/catalog/products/[productId]', { params: { productId: parent.data.id }, body: { version: parent.data.version, description: 'Organic cotton' } }));
    expect((await call('GET', '/api/v1/catalog/variants/[variantId]', { params: { variantId: ctx.variant.id } })).data.description).toBe('Special edition');

    // Prices are exact decimals with an explicit currency; variants can override or inherit.
    const putVariantPrices = await call('PUT', '/api/v1/catalog/variants/[variantId]/prices', { params: { variantId: ctx.variant.id }, body: { prices: [{ priceTypeId: ctx.baseType.id, currency: 'USD', amount: '24.9900' }] } });
    expectOk(putVariantPrices);
    expect(putVariantPrices.data.prices[0]).toMatchObject({ amount: '24.99', currency: 'USD', isBase: true });
    expectOk(await call('GET', '/api/v1/catalog/variants/[variantId]/prices', { params: { variantId: ctx.variant.id } }));
    expectOk(await call('PUT', '/api/v1/catalog/variants/[variantId]/media', { params: { variantId: ctx.variant.id }, body: { media: [] } }));
    expectOk(await call('GET', '/api/v1/catalog/variants/[variantId]/media', { params: { variantId: ctx.variant.id } }));
    expectError(await call('PUT', '/api/v1/catalog/products/[productId]/media', { params: { productId: parent.data.id }, body: { media: [{ fileId: MISSING_ID }] } }), 400, 'CATALOG_FILE_INVALID');
    expectOk(await call('PUT', '/api/v1/catalog/products/[productId]/media', { params: { productId: parent.data.id }, body: { media: [] } }));
    expectOk(await call('GET', '/api/v1/catalog/products/[productId]/media', { params: { productId: parent.data.id } }));

    const simple = await call('POST', '/api/v1/catalog/products', {
      body: { type: 'SIMPLE_PRODUCT', name: `Widget ${RUN}`, sku: `WID-${RUN}`, primaryUnitId: unit('PIECE').id, categoryIds: [ctx.childCategory.id], customFields: { [ctx.material.code]: 'Steel' }, prices: [{ priceTypeId: ctx.baseType.id, currency: 'USD', amount: '19.99' }], taxable: true, taxRate: '10' },
    });
    expectOk(simple);
    ctx.simple = simple.data;
    expect(simple.data.customFields[ctx.material.code]).toBe('Steel');
    expectError(await call('POST', '/api/v1/catalog/products', { body: { type: 'SIMPLE_PRODUCT', name: 'dup', sku: `wid-${RUN}` } }), 409, 'PRODUCT_SKU_CONFLICT');
    const prices = await call('PUT', '/api/v1/catalog/products/[productId]/prices', { params: { productId: simple.data.id }, body: { prices: [{ priceTypeId: ctx.baseType.id, currency: 'USD', amount: '19.99' }, { priceTypeId: ctx.retailType.id, currency: 'EUR', amount: '18.5' }] } });
    expectOk(prices);
    expect(prices.data.prices).toHaveLength(2);
    expectOk(await call('GET', '/api/v1/catalog/products/[productId]/prices', { params: { productId: simple.data.id } }));
    expectError(await call('PUT', '/api/v1/catalog/products/[productId]/prices', { params: { productId: simple.data.id }, body: { prices: [{ priceTypeId: MISSING_ID, currency: 'USD', amount: '1' }] } }), 404, 'PRICE_TYPE_NOT_FOUND');

    const ratio = await call('POST', '/api/v1/catalog/products/[productId]/unit-ratios', { params: { productId: simple.data.id }, body: { unitId: unit('BOX').id, ratio: '12' } });
    expectOk(ratio);
    expect(ratio.data.description).toBe('1 Box = 12 Piece');
    expectError(await call('POST', '/api/v1/catalog/products/[productId]/unit-ratios', { params: { productId: simple.data.id }, body: { unitId: unit('KILOGRAM').id, ratio: '0' } }), 400, 'UNIT_RATIO_INVALID');
    expectOk(await call('GET', '/api/v1/catalog/products/[productId]/unit-ratios', { params: { productId: simple.data.id } }));
    expectOk(await call('PATCH', '/api/v1/catalog/products/[productId]/unit-ratios/[ratioId]', { params: { productId: simple.data.id, ratioId: ratio.data.id }, body: { ratio: '24' } }));

    const search = await call('GET', '/api/v1/catalog/products', { query: { search: `Widget ${RUN}`, type: 'SIMPLE_PRODUCT', categoryId: ctx.category.id, [`prop.${ctx.material.code}`]: 'steel', minPrice: '10', maxPrice: '20', currency: 'USD', sortBy: 'name' } });
    expectOk(search);
    expect(search.data.map((p: any) => p.id)).toEqual([simple.data.id]);
    expect(search.body.meta).toMatchObject({ total: 1 });
    expectError(await call('GET', '/api/v1/catalog/products', { query: { sortBy: 'password' } }), 400, 'CATALOG_QUERY_INVALID');
    expectError(await call('GET', '/api/v1/catalog/products', { query: { 'prop.nope': 'x' } }), 400, 'CATALOG_QUERY_FIELD_NOT_ALLOWED');
    const picker = await call('GET', '/api/v1/catalog/products', { query: { purpose: 'picker', search: `Widget ${RUN}` } });
    expect(picker.data.map((p: any) => p.id)).toContain(simple.data.id);

    // Archive a used product, keep it out of the picker, delete an unused one.
    const variantArchived = await call('POST', '/api/v1/catalog/variants/[variantId]/archive', { params: { variantId: ctx.variant.id }, body: {} });
    expectOk(variantArchived);
    expect(variantArchived.data.state).toBe('ARCHIVED');
    expectOk(await call('POST', '/api/v1/catalog/variants/[variantId]/reactivate', { params: { variantId: ctx.variant.id }, body: {} }));
    const parentArchived = await call('POST', '/api/v1/catalog/products/[productId]/archive', { params: { productId: parent.data.id }, body: {} });
    expect(parentArchived.data.state).toBe('ARCHIVED');
    expectError(await call('POST', '/api/v1/catalog/variants/[variantId]/reactivate', { params: { variantId: ctx.variant.id }, body: {} }), 409, 'PRODUCT_PARENT_ARCHIVED');
    expectOk(await call('POST', '/api/v1/catalog/products/[productId]/reactivate', { params: { productId: parent.data.id }, body: {} }));
    expectOk(await call('DELETE', '/api/v1/catalog/variants/[variantId]', { params: { variantId: ctx.variant.id } }));
    expectOk(await call('DELETE', '/api/v1/catalog/products/[productId]/unit-ratios/[ratioId]', { params: { productId: simple.data.id, ratioId: ratio.data.id } }));
    const scratch = await call('POST', '/api/v1/catalog/products', { body: { type: 'SERVICE', name: `Consulting ${RUN}` } });
    expectOk(scratch);
    expectOk(await call('DELETE', '/api/v1/catalog/products/[productId]', { params: { productId: scratch.data.id } }));
  });

  it('stores commercial rows as snapshots with server totals and enforces overrides and isolation', async () => {
    const deal = await call('POST', '/api/v1/crm/deals', { body: { title: `Rows deal ${RUN}`, companyId: ctx.company.id } });
    expectOk(deal);
    const path = { entityType: 'deals', entityId: deal.data.id };
    const empty = await call('GET', '/api/v1/crm/[entityType]/[entityId]/product-rows', { params: path });
    expectOk(empty);
    expect(empty.data).toMatchObject({ version: 0, rows: [] });
    const saved = await call('PUT', '/api/v1/crm/[entityType]/[entityId]/product-rows', {
      params: path,
      headers: { 'idempotency-key': `rows-${RUN}` },
      body: { rows: [{ productId: ctx.simple.id, quantity: '3', total: '1' }, { name: 'Setup fee', quantity: '1', unitName: 'job', unitPrice: '99.999', currency: 'USD', tax: { taxable: true, rate: '10' } }] },
    });
    expectOk(saved);
    expect(saved.data.rows[0]).toMatchObject({ name: `Widget ${RUN}`, unitPrice: '19.99', subtotal: '59.97', taxAmount: '6', total: '65.97' });
    expect(saved.data.rows[1]).toMatchObject({ isManual: true, total: '110' });
    expect(saved.data.totals.total).toBe('175.97');
    // Master changes never rewrite the stored snapshot (values round-trip through Postgres NUMERIC).
    expectOk(await call('PUT', '/api/v1/catalog/products/[productId]/prices', { params: { productId: ctx.simple.id }, body: { prices: [{ priceTypeId: ctx.baseType.id, currency: 'USD', amount: '999' }] } }));
    const reread = await call('GET', '/api/v1/crm/[entityType]/[entityId]/product-rows', { params: path });
    expect(reread.data.rows[0].unitPrice).toBe('19.99');
    expect(reread.data.rows[0].name).toBe(`Widget ${RUN}`);
    expectError(await call('PUT', '/api/v1/crm/[entityType]/[entityId]/product-rows', { params: path, body: { rows: [], expectedVersion: 0 } }), 409, 'CATALOG_VERSION_CONFLICT');
    expectError(await call('PUT', '/api/v1/crm/[entityType]/[entityId]/product-rows', { params: path, body: { rows: [{ productId: MISSING_ID, quantity: '1' }], expectedVersion: 1 } }), 404, 'PRODUCT_NOT_FOUND');
    expectError(await call('GET', '/api/v1/crm/[entityType]/[entityId]/product-rows', { params: { entityType: 'estimates', entityId: deal.data.id } }), 400, 'PRODUCT_ROW_OWNER_UNSUPPORTED');
    // A foreign workspace cannot read them even with a valid id.
    const foreign = await api('POST', '/api/v1/workspaces', { token: ws.owner.token, body: { name: `Rows foreign ${RUN}` } });
    expectError(await api('GET', '/api/v1/crm/[entityType]/[entityId]/product-rows', { token: ws.owner.token, workspaceId: foreign.data.id, params: path }), 404, 'PRODUCT_ROW_OWNER_NOT_FOUND');
    const { prisma } = await import('@/src/server/prisma-client');
    const rows = await prisma.commercialProductRow.findMany({ where: { ownerId: deal.data.id } });
    expect(rows).toHaveLength(2);
    expect(rows[0].unitPrice.toFixed()).toMatch(/^\d/);
  });

  it('enforces catalog invariants in the database as well', async () => {
    const { prisma } = await import('@/src/server/prisma-client');
    const product = await prisma.catalogProduct.findFirstOrThrow({ where: { id: ctx.simple.id } });
    const base = { workspaceId: product.workspaceId, catalogId: product.catalogId, type: 'SIMPLE_PRODUCT' as const, name: 'db dup' };
    // SKU uniqueness (case-normalized key) and the shape check are database constraints too.
    await expect(prisma.catalogProduct.create({ data: { ...base, sku: 'X', skuKey: product.skuKey } })).rejects.toThrow();
    await expect(prisma.catalogProduct.create({ data: { ...base, sku: null, skuKey: null } })).rejects.toThrow();
    await expect(prisma.catalogProductUnitRatio.create({ data: { workspaceId: product.workspaceId, productId: product.id, unitId: MISSING_ID, baseUnitId: '11111111-1111-4111-8111-111111111111', ratio: '0' } })).rejects.toThrow();
    await expect(prisma.catalogProductPrice.create({ data: { workspaceId: product.workspaceId, productId: product.id, priceTypeId: MISSING_ID, amount: '-1', currency: 'USD' } })).rejects.toThrow();
    await expect(prisma.catalogProductPrice.create({ data: { workspaceId: product.workspaceId, productId: product.id, priceTypeId: MISSING_ID, amount: '1', currency: 'usd' } })).rejects.toThrow();
    // A duplicate current price key is rejected regardless of the application.
    const price = await prisma.catalogProductPrice.findFirstOrThrow({ where: { productId: product.id } });
    await expect(prisma.catalogProductPrice.create({ data: { workspaceId: price.workspaceId, productId: price.productId, priceTypeId: price.priceTypeId, currency: price.currency, amount: '5' } })).rejects.toThrow();
  });
});

describe('Automation Rules & Triggers API', () => {
  beforeEach(() => resetRateLimits());
  const call = (method: any, template: string, options: Record<string, unknown> = {}) => api(method, template, authed(options));
  const TOKEN = 'test-job-token-0123456789';
  const runJobs = () => api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: 'automation-run' }, headers: { 'x-internal-job-token': TOKEN }, body: {} });
  const followUp = { actionCode: 'activities.create_activity', config: { typeCode: 'FOLLOW_UP', subject: 'Follow up {{target.title}}' } };
  const newDeal = async (title: string) => {
    const created = await call('POST', '/api/v1/crm/deals', { body: { title, companyId: ctx.company.id } });
    expectOk(created);
    return created.data;
  };
  const stageOf = (name?: string) => ctx.dealStages.filter((s: any) => s.semanticType === 'PROGRESS');

  beforeAll(() => {
    configureInternalJobToken(TOKEN);
  });
  afterAll(() => {
    configureInternalJobToken();
  });

  it('exposes registry-driven metadata for targets, triggers, actions and conditions', async () => {
    const targets = await call('GET', '/api/v1/crm/automation/targets');
    expectOk(targets);
    expect(targets.data.map((t: any) => t.targetType)).toEqual(expect.arrayContaining(['LEAD', 'DEAL', 'CONTACT', 'COMPANY', 'ACTIVITY']));
    expect(targets.data.find((t: any) => t.targetType === 'DEAL')).toMatchObject({ supportsStages: true });
    const triggers = await call('GET', '/api/v1/crm/automation/trigger-types');
    expect(triggers.data.map((t: any) => t.code)).toEqual(expect.arrayContaining(['crm.stage.entered', 'crm.field.changed', 'manual.execute', 'activity.overdue']));
    const actions = await call('GET', '/api/v1/crm/automation/action-types');
    expectOk(actions);
    const codes = actions.data.map((a: any) => a.code);
    expect(codes).toEqual(expect.arrayContaining(['crm.update_fields', 'crm.move_stage', 'activities.create_activity', 'tasks.create_task', 'integrations.call_webhook']));
    // Shared Notifications is connected; remaining unavailable module actions stay hidden.
    expect(codes).toContain('notifications.notify_user');
    const meta = await call('GET', '/api/v1/crm/automation/condition-metadata', { query: { targetType: 'DEAL', triggerCode: 'crm.stage.entered' } });
    expectOk(meta);
    expect(meta.data.operatorsByType.NUMBER).toContain('GTE');
    expect(meta.data.operands.find((o: any) => o.ref === 'target.amount').operators).toContain('CHANGED');
    expect(meta.data.limits).toMatchObject({ maxDepth: 5, maxNodes: 50 });
  });

  it('runs the rule lifecycle over HTTP: draft, edit, publish, revisions, pause/enable/disable and validation errors', async () => {
    const stage = stageOf()[0];
    const created = await call('POST', '/api/v1/crm/automation/rules', { body: { name: `Stage rule ${RUN}`, targetType: 'DEAL', trigger: { code: 'crm.stage.entered', config: { stageId: stage.id } }, actions: [followUp] } });
    expectOk(created);
    ctx.rule = created.data;
    expect(created.data).toMatchObject({ state: 'DRAFT', version: 1 });
    expectOk(await call('GET', '/api/v1/crm/automation/rules', { query: { state: 'DRAFT' } }));
    expectOk(await call('GET', '/api/v1/crm/automation/rules/[ruleId]', { params: { ruleId: ctx.rule.id } }));
    const bad = await call('POST', '/api/v1/crm/automation/rules', { body: { name: 'bad', targetType: 'DEAL', trigger: { code: 'nope' }, actions: [{ actionCode: 'nope' }] } });
    expectError(await call('POST', '/api/v1/crm/automation/rules/[ruleId]/publish', { params: { ruleId: bad.data.id }, body: { version: 1 } }), 400, 'AUTOMATION_RULE_NOT_PUBLISHABLE');
    const patched = await call('PATCH', '/api/v1/crm/automation/rules/[ruleId]', { params: { ruleId: ctx.rule.id }, body: { version: 1, priority: 5 } });
    expectOk(patched);
    expectError(await call('PATCH', '/api/v1/crm/automation/rules/[ruleId]', { params: { ruleId: ctx.rule.id }, body: { version: 1, priority: 6 } }), 409, 'AUTOMATION_RULE_VERSION_CONFLICT');
    expectError(await call('PATCH', '/api/v1/crm/automation/rules/[ruleId]', { params: { ruleId: ctx.rule.id }, body: { version: 2, state: 'ACTIVE' } }), 400, 'AUTOMATION_FIELD_NOT_UPDATABLE');
    const published = await call('POST', '/api/v1/crm/automation/rules/[ruleId]/publish', { params: { ruleId: ctx.rule.id }, body: { version: 2 } });
    expectOk(published);
    expect(published.data).toMatchObject({ state: 'ACTIVE', activeRevisionNumber: 1 });
    ctx.rule = published.data;
    const revisions = await call('GET', '/api/v1/crm/automation/rules/[ruleId]/revisions', { params: { ruleId: ctx.rule.id } });
    expectOk(revisions);
    const revision = await call('GET', '/api/v1/crm/automation/rules/[ruleId]/revisions/[revisionId]', { params: { ruleId: ctx.rule.id, revisionId: revisions.data[0].id } });
    expectOk(revision);
    expect(revision.data.actions).toHaveLength(1);
    const dry = await call('POST', '/api/v1/crm/automation/rules/[ruleId]/dry-run', { params: { ruleId: ctx.rule.id }, body: { targetId: ctx.deal.id } });
    expectOk(dry);
    expect(dry.data).toMatchObject({ sideEffectsExecuted: false, matched: true });
    expectOk(await call('POST', '/api/v1/crm/automation/rules/[ruleId]/pause', { params: { ruleId: ctx.rule.id }, body: {} }));
    expectOk(await call('POST', '/api/v1/crm/automation/rules/[ruleId]/enable', { params: { ruleId: ctx.rule.id }, body: {} }));
    expectOk(await call('POST', '/api/v1/crm/automation/rules/[ruleId]/disable', { params: { ruleId: ctx.rule.id }, body: {} }));
    expectOk(await call('POST', '/api/v1/crm/automation/rules/[ruleId]/enable', { params: { ruleId: ctx.rule.id }, body: {} }));
    expectError(await call('GET', '/api/v1/crm/automation/rules/[ruleId]', { params: { ruleId: MISSING_ID } }), 404, 'AUTOMATION_RULE_NOT_FOUND');
    // Published revisions are immutable in the database itself.
    const { prisma } = await import('@/src/server/prisma-client');
    await expect(prisma.automationRuleRevision.update({ where: { id: revisions.data[0].id }, data: { triggerCode: 'manual.execute' } })).rejects.toThrow(/AUTOMATION_REVISION_IMMUTABLE/);
    await expect(prisma.automationRuleRevision.delete({ where: { id: revisions.data[0].id } })).rejects.toThrow(/AUTOMATION_REVISION_IMMUTABLE/);
    const revisionAction = await prisma.automationAction.findFirstOrThrow({ where: { revisionId: revisions.data[0].id } });
    await expect(prisma.automationAction.update({ where: { id: revisionAction.id }, data: { actionCode: 'crm.update_fields' } })).rejects.toThrow(/AUTOMATION_REVISION_IMMUTABLE/);
    const draftRule = await call('POST', '/api/v1/crm/automation/rules', { body: { name: 'disposable', targetType: 'DEAL', trigger: { code: 'manual.execute', config: {} }, actions: [followUp] } });
    expectOk(await call('DELETE', '/api/v1/crm/automation/rules/[ruleId]', { params: { ruleId: draftRule.data.id } }));
  });

  it('turns a domain event into a job, executes it through the scheduler endpoint and exposes logs, retry and cancel', async () => {
    const deal = await newDeal(`Auto deal ${RUN}`);
    const stage = stageOf()[0];
    const moved = await call('POST', '/api/v1/crm/deals/[id]/transition', { params: { id: deal.id }, body: { expectedVersion: deal.version, targetPipelineId: ctx.dealPipeline.id, targetStageId: stage.id } });
    expectOk(moved);
    const pending = await call('GET', '/api/v1/crm/automation/jobs', { query: { ruleId: ctx.rule.id, status: 'PENDING' } });
    expectOk(pending);
    expect(pending.data.some((job: any) => job.target.id === deal.id)).toBe(true);
    expectError(await api('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: 'automation-run' }, headers: { 'x-internal-job-token': 'wrong' }, body: {} }), 401, 'UNAUTHENTICATED');
    const ran = await runJobs();
    expectOk(ran);
    expect(ran.data.claimed).toBeGreaterThanOrEqual(1);
    const list = await call('GET', '/api/v1/crm/automation/executions', { query: { ruleId: ctx.rule.id, targetId: deal.id } });
    expectOk(list);
    expect(list.data).toHaveLength(1);
    expect(JSON.stringify(list.data[0])).toContain('"status":"SUCCEEDED"');
    const detail = await call('GET', '/api/v1/crm/automation/executions/[executionId]', { params: { executionId: list.data[0].id } });
    expectOk(detail);
    expect(detail.data.actions[0]).toMatchObject({ status: 'SUCCEEDED', attemptCount: 1 });
    const { prisma } = await import('@/src/server/prisma-client');
    const activity = await prisma.crmActivity.findFirst({ where: { workspaceId: ws.owner.workspaceId, subject: `Follow up Auto deal ${RUN}` } });
    expect(activity).toBeTruthy();
    // The job is durable and finished; redelivery of the scheduler tick changes nothing.
    expect((await runJobs()).data.claimed).toBe(0);
    expect(await prisma.automationExecution.count({ where: { ruleId: ctx.rule.id, targetId: deal.id } })).toBe(1);
    // Cursor pagination is deterministic.
    const page1 = await call('GET', '/api/v1/crm/automation/executions', { query: { limit: '1' } });
    expectOk(page1);
    if (page1.body.meta.hasMore) expectOk(await call('GET', '/api/v1/crm/automation/executions', { query: { limit: '1', cursor: page1.body.meta.nextCursor } }));

    // A permanent failure can be retried by an authorized user; a delayed pending job can be cancelled.
    const failing = await call('POST', '/api/v1/crm/automation/rules', { body: { name: `Failing ${RUN}`, targetType: 'DEAL', trigger: { code: 'manual.execute', config: {} }, actions: [{ actionCode: 'crm.set_responsible', config: { userId: MISSING_ID } }] } });
    expectOk(await call('POST', '/api/v1/crm/automation/rules/[ruleId]/publish', { params: { ruleId: failing.data.id }, body: { version: 1 } }));
    const manual = await call('POST', '/api/v1/crm/automation/rules/[ruleId]/execute', { params: { ruleId: failing.data.id }, body: { targetId: deal.id, idempotencyKey: `m-${RUN}` } });
    expectOk(manual);
    expect(manual.data.execution).toMatchObject({ status: 'FAILED_FINAL', isManual: true });
    const retried = await call('POST', '/api/v1/crm/automation/executions/[executionId]/retry', { params: { executionId: manual.data.execution.id } });
    expectOk(retried);
    expect(retried.data).toMatchObject({ status: 'PENDING', retryCount: 1 });
    await runJobs();
    expect((await call('GET', '/api/v1/crm/automation/executions/[executionId]', { params: { executionId: manual.data.execution.id } })).data.status).toBe('FAILED_FINAL');
    expectError(await call('POST', '/api/v1/crm/automation/executions/[executionId]/retry', { params: { executionId: MISSING_ID } }), 404, 'AUTOMATION_EXECUTION_NOT_FOUND');

    const delayed = await call('POST', '/api/v1/crm/automation/rules', { body: { name: `Delayed ${RUN}`, targetType: 'DEAL', trigger: { code: 'manual.execute', config: {} }, timing: { mode: 'DELAY', delayMinutes: 30 }, actions: [followUp] } });
    expectOk(await call('POST', '/api/v1/crm/automation/rules/[ruleId]/publish', { params: { ruleId: delayed.data.id }, body: { version: 1 } }));
    // Manual runs ignore configured delays; use an event-driven delayed rule for the cancel path.
    const stage2 = stageOf()[1] ?? stage;
    const delayedRule = await call('POST', '/api/v1/crm/automation/rules', { body: { name: `Delayed stage ${RUN}`, targetType: 'DEAL', trigger: { code: 'crm.stage.entered', config: { stageId: stage2.id } }, timing: { mode: 'DELAY', delayMinutes: 30 }, actions: [followUp] } });
    expectOk(await call('POST', '/api/v1/crm/automation/rules/[ruleId]/publish', { params: { ruleId: delayedRule.data.id }, body: { version: 1 } }));
    const deal2 = await newDeal(`Delayed deal ${RUN}`);
    expectOk(await call('POST', '/api/v1/crm/deals/[id]/transition', { params: { id: deal2.id }, body: { expectedVersion: deal2.version, targetPipelineId: ctx.dealPipeline.id, targetStageId: stage2.id } }));
    const jobs = await call('GET', '/api/v1/crm/automation/jobs', { query: { ruleId: delayedRule.data.id } });
    expect(jobs.data).toHaveLength(1);
    const cancelled = await call('POST', '/api/v1/crm/automation/jobs/[jobId]/cancel', { params: { jobId: jobs.data[0].id } });
    expectOk(cancelled);
    expect(cancelled.data.status).toBe('CANCELLED');
    expectError(await call('POST', '/api/v1/crm/automation/jobs/[jobId]/cancel', { params: { jobId: jobs.data[0].id } }), 409, 'AUTOMATION_JOB_NOT_CANCELLABLE');
    expectOk(await call('POST', '/api/v1/internal/crm/jobs/[job]', { params: { job: 'automation-ingest' }, headers: { 'x-internal-job-token': TOKEN }, body: {} }));
  });

  it('registers custom extensions, issues integration credentials and accepts an authenticated custom trigger', async () => {
    const trigger = await call('POST', '/api/v1/crm/automation/extensions', { body: { kind: 'TRIGGER', code: `carrier_${RUN}`, installationId: 'carrier-app', name: 'Carrier update', targetTypes: ['DEAL'], payloadSchema: { type: 'object', required: ['carrier'], properties: { carrier: { type: 'string', maxLength: 30 } } } } });
    expectOk(trigger);
    expectError(await call('POST', '/api/v1/crm/automation/extensions', { body: { kind: 'TRIGGER', code: `carrier_${RUN}`, installationId: 'x', name: 'dup', targetTypes: ['DEAL'] } }), 409, 'AUTOMATION_EXTENSION_CODE_CONFLICT');
    expectOk(await call('GET', '/api/v1/crm/automation/extensions'));
    expectOk(await call('PATCH', '/api/v1/crm/automation/extensions/[extensionId]', { params: { extensionId: trigger.data.id }, body: { name: 'Carrier updates' } }));
    const credential = await call('POST', '/api/v1/crm/automation/integrations', { body: { installationId: 'carrier-app', name: 'Carrier app key' } });
    expectOk(credential);
    expect(credential.data.secret).toContain('.');
    const listed = await call('GET', '/api/v1/crm/automation/integrations');
    expectOk(listed);
    expect(JSON.stringify(listed.data)).not.toContain(credential.data.secret);

    const rule = await call('POST', '/api/v1/crm/automation/rules', { body: { name: `Carrier rule ${RUN}`, targetType: 'DEAL', trigger: { code: `ext.carrier_${RUN}`, config: {} }, actions: [{ actionCode: 'activities.create_activity', config: { typeCode: 'FOLLOW_UP', subject: 'Carrier {{trigger.payload.carrier}}' } }] } });
    expectOk(await call('POST', '/api/v1/crm/automation/rules/[ruleId]/publish', { params: { ruleId: rule.data.id }, body: { version: 1 } }));
    const deal = await newDeal(`Carrier deal ${RUN}`);
    const invoke = (body: Record<string, unknown>, key = credential.data.secret) => api('POST', '/api/v1/crm/automation/custom-triggers/[triggerCode]/execute', { params: { triggerCode: `carrier_${RUN}` }, headers: { 'x-automation-integration-key': key }, body });
    expectError(await invoke({ targetId: deal.id, eventId: 'e1', payload: { carrier: 'x' } }, 'bad.key'), 401, 'UNAUTHENTICATED');
    expectError(await invoke({ targetId: deal.id, eventId: 'e1', payload: { carrier: 'x'.repeat(99) } }), 400, 'AUTOMATION_TRIGGER_PAYLOAD_INVALID');
    expectError(await invoke({ targetId: MISSING_ID, eventId: 'e1', payload: { carrier: 'DHL' } }), 404, 'AUTOMATION_TARGET_NOT_FOUND');
    const accepted = await invoke({ targetId: deal.id, eventId: 'e1', payload: { carrier: 'DHL' } });
    expectOk(accepted);
    expect(accepted.data).toMatchObject({ accepted: true, jobsCreated: 1 });
    expect((await invoke({ targetId: deal.id, eventId: 'e1', payload: { carrier: 'DHL' } })).data.duplicate).toBe(true);
    await runJobs();
    const { prisma } = await import('@/src/server/prisma-client');
    expect(await prisma.crmActivity.count({ where: { subject: 'Carrier DHL' } })).toBe(1);

    expectOk(await call('POST', '/api/v1/crm/automation/extensions/[extensionId]/disable', { params: { extensionId: trigger.data.id } }));
    expectError(await invoke({ targetId: deal.id, eventId: 'e2', payload: { carrier: 'DHL' } }), 404, 'AUTOMATION_TRIGGER_NOT_SUPPORTED');
    expectError(await call('DELETE', '/api/v1/crm/automation/extensions/[extensionId]', { params: { extensionId: trigger.data.id } }), 409, 'AUTOMATION_EXTENSION_IN_USE');
    expectOk(await call('POST', '/api/v1/crm/automation/extensions/[extensionId]/enable', { params: { extensionId: trigger.data.id } }));
    expectOk(await call('POST', '/api/v1/crm/automation/integrations/[credentialId]/revoke', { params: { credentialId: credential.data.id } }));
    expectError(await invoke({ targetId: deal.id, eventId: 'e3', payload: { carrier: 'DHL' } }), 401, 'UNAUTHENTICATED');
    const spare = await call('POST', '/api/v1/crm/automation/extensions', { body: { kind: 'TRIGGER', code: `spare_${RUN}`, installationId: 'carrier-app', name: 'Spare', targetTypes: ['DEAL'] } });
    expectOk(await call('DELETE', '/api/v1/crm/automation/extensions/[extensionId]', { params: { extensionId: spare.data.id } }));
  });

  it('keeps Automation permission-gated and workspace-scoped', async () => {
    const outsider = await register('automation-outsider');
    expectError(await api('GET', '/api/v1/crm/automation/rules', { token: outsider.token, workspaceId: ws.owner.workspaceId }), 403);
    const foreignRules = await api('GET', '/api/v1/crm/automation/rules', { token: outsider.token, workspaceId: outsider.workspaceId });
    expectOk(foreignRules);
    expect(foreignRules.data).toHaveLength(0);
    expectError(await api('GET', '/api/v1/crm/automation/rules/[ruleId]', { token: outsider.token, workspaceId: outsider.workspaceId, params: { ruleId: ctx.rule.id } }), 404, 'AUTOMATION_RULE_NOT_FOUND');
    expectError(await api('POST', '/api/v1/crm/automation/rules/[ruleId]/execute', { token: outsider.token, workspaceId: outsider.workspaceId, params: { ruleId: ctx.rule.id }, body: { targetId: ctx.deal.id } }), 404, 'AUTOMATION_RULE_NOT_FOUND');
    expectError(await api('GET', '/api/v1/catalog/products/[productId]', { token: outsider.token, workspaceId: outsider.workspaceId, params: { productId: ctx.simple.id } }), 404, 'PRODUCT_NOT_FOUND');
  });
});

describe('Cross-cutting behaviour', () => {
  // Everything under app/ is locked behind a bearer token unless it is listed here. A newly added
  // route therefore fails this test until it either checks the token or is consciously allow-listed.
  const PUBLIC_ENDPOINTS = new Set([
    'GET /',
    'GET /swagger',
    'GET /api/docs',
    'GET /api/v1/health/ready',
    'GET /api/v1/health/live',
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
    'GET /api/v1/public/forms/[publicKey]',
    'GET /api/v1/public/booking/[[...path]]',
    'GET /api/v1/public/folders/[[...path]]',
    'GET /api/v1/public/files/[[...path]]',
    'GET /api/v1/file-delivery/[id]',
    'POST /api/v1/public/booking/[[...path]]',
    'POST /api/v1/public/bookings/[[...path]]',
    'POST /api/v1/public/forms/[publicKey]/submissions',
    'POST /api/v1/public/forms/[publicKey]/uploads',
    'POST /api/v1/public/forms/[publicKey]/uploads/[uploadId]/finalize',
    'POST /api/v1/payments/providers/[providerKey]/webhook',
    'POST /api/v1/contact-center/connections/[connectionId]/events',
    'POST /api/v1/integrations/providers/[provider]/[connectionId]/webhook',
    'GET /t/[token]',
    // Business suite public surfaces (storefront tokens, signed provider callbacks, published sites).
    'GET /api/v1/public/stores/[[...path]]',
    'POST /api/v1/public/stores/[[...path]]',
    'POST /api/v1/public/carts/[[...path]]',
    'PATCH /api/v1/public/carts/[[...path]]',
    'DELETE /api/v1/public/carts/[[...path]]',
    'POST /api/v1/public/checkout-sessions/[[...path]]',
    'POST /api/v1/public/order-access/[[...path]]',
    'GET /api/v1/public/payment-links/[[...path]]',
    'GET /api/v1/public/digital-deliveries/[[...path]]',
    'POST /api/v1/public/digital-deliveries/[[...path]]',
    'GET /api/v1/public/marketing/[[...path]]',
    'POST /api/v1/public/marketing/[[...path]]',
    'GET /api/v1/public/sites/[[...path]]',
    'POST /api/v1/public/sites/[[...path]]',
    'GET /api/v1/public/robots.txt',
    'GET /api/v1/public/sitemap.xml',
    'POST /api/v1/integrations/payments/[[...path]]',
    'POST /api/v1/integrations/shipping/[[...path]]',
    'POST /api/v1/integrations/marketing/[[...path]]',
    // Final pack: signed SaaS billing provider webhooks.
    'POST /api/v1/webhooks/billing/[provider]',
    // Final pack: public Partner application (always 202, rate limited, non-enumerating).
    'POST /api/v1/public/partners/applications',
  ]);

  it('only the allow-listed public endpoints exist without a bearer token', async () => {
    const all = await discoverEndpoints();
    for (const endpoint of PUBLIC_ENDPOINTS) expect(all).toContain(endpoint);

    const leaks: string[] = [];
    for (const endpoint of all.filter((item) => !PUBLIC_ENDPOINTS.has(item))) {
      const [method, template] = endpoint.split(' ');
      const params = Object.fromEntries([...template.matchAll(/\[(\w+)\]/g)].map((match) => [match[1], MISSING_ID]));
      for (const token of [undefined, 'garbage']) {
        const res = await api(method as any, template, { params, token, workspaceId: ws.owner.workspaceId, retryAuthProbe: true });
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

  it('rejects invalid public commercial form and provider requests through their real handlers', async () => {
    expectError(await api('GET', '/api/v1/public/forms/[publicKey]', { params: { publicKey: MISSING_ID } }), 404, 'FORM_NOT_PUBLISHED');
    expectError(await api('POST', '/api/v1/public/forms/[publicKey]/submissions', { params: { publicKey: MISSING_ID }, body: {} }), 404, 'FORM_NOT_PUBLISHED');
    expectError(await api('POST', '/api/v1/public/forms/[publicKey]/uploads', { params: { publicKey: MISSING_ID }, body: { fieldKey:'file',mimeType:'text/plain',size:1 } }), 404, 'FORM_NOT_PUBLISHED');
    expectError(await api('POST', '/api/v1/public/forms/[publicKey]/uploads/[uploadId]/finalize', { params: { publicKey: MISSING_ID,uploadId:MISSING_ID }, headers:{'x-upload-token':'invalid'}, body: {} }), 404, 'FORM_NOT_PUBLISHED');
    expectError(await api('POST', '/api/v1/payments/providers/[providerKey]/webhook', { params: { providerKey: MISSING_ID }, body: {} }), 409, 'PAYMENT_PROVIDER_NOT_CONFIGURED');
    expectError(await api('POST', '/api/v1/contact-center/connections/[connectionId]/events', { params: { connectionId: MISSING_ID }, body: {} }), 404, 'CHANNEL_CONNECTION_INACTIVE');
    const authenticated = { token: ws.owner.token, workspaceId: ws.owner.workspaceId };
    expectOk(await api('GET', '/api/v1/invoice-sequences', authenticated));
    expectError(await api('POST', '/api/v1/invoice-sequences', { ...authenticated, body: { prefix: '' } }), 400, 'VALIDATION_ERROR');
    expectOk(await api('GET', '/api/v1/commercial-jobs', authenticated));
    expectError(await api('POST', '/api/v1/commercial-jobs/[id]/retry', { ...authenticated, params: { id: MISSING_ID } }), 404, 'COMMERCIAL_JOB_NOT_FOUND');
  });

  it('exercises the data integration, intelligence, and analytics route surfaces', async () => {
    const authenticated = { token: ws.owner.token, workspaceId: ws.owner.workspaceId };
    const catchAll = (path: string[]) => ({ path } as any);

    expectOk(await api('GET', '/api/v1/data-quality/[...path]', { ...authenticated, params: catchAll(['duplicates']) }));
    expectOk(await api('POST', '/api/v1/data-quality/[...path]', { ...authenticated, params: catchAll(['duplicate-scans']), headers: { 'idempotency-key': `scan-${RUN}` }, body: { entityType: 'LEAD' } }));
    expectError(await api('DELETE', '/api/v1/data-quality/[...path]', { ...authenticated, params: catchAll(['duplicate-exclusions', MISSING_ID]) }), 404);

    expectOk(await api('GET', '/api/v1/imports/[[...path]]', { ...authenticated, params: catchAll([]) }));
    expectOk(await api('POST', '/api/v1/imports/[[...path]]', { ...authenticated, params: catchAll([]), body: { entityType: 'CONTACT', mode: 'CREATE', fileFormat: 'CSV', csv: 'email\nroute@example.com' } }));
    expectError(await api('PUT', '/api/v1/imports/[[...path]]', { ...authenticated, params: catchAll([MISSING_ID, 'mapping']), body: {} }), 404);

    expectOk(await api('GET', '/api/v1/exports/[[...path]]', { ...authenticated, params: catchAll([]) }));
    expectOk(await api('POST', '/api/v1/exports/[[...path]]', { ...authenticated, params: catchAll([]), body: { entityType: 'CONTACT', fields: ['id'], format: 'CSV' } }));
    expectOk(await api('POST', '/api/v1/batch', { ...authenticated, body: { operations: [] } }));

    expectOk(await api('GET', '/api/v1/integrations/[...path]', { ...authenticated, params: catchAll(['api-applications']) }));
    expectOk(await api('POST', '/api/v1/integrations/[...path]', { ...authenticated, params: catchAll(['api-applications']), body: { name: 'Endpoint coverage', allowedScopes: ['analytics.read'] } }));
    expectError(await api('POST', '/api/v1/integrations/providers/[provider]/[connectionId]/webhook', { params: { provider: 'fake', connectionId: MISSING_ID }, body: {} }), 400, 'WEBHOOK_SIGNATURE_INVALID');

    expectOk(await api('GET', '/api/v1/sales-intelligence/[...path]', { ...authenticated, params: catchAll(['sources']) }));
    expectError(await api('POST', '/api/v1/sales-intelligence/[...path]', { ...authenticated, params: catchAll(['unsupported']), body: {} }), 400, 'VALIDATION_FAILED');
    expectError(await api('PATCH', '/api/v1/sales-intelligence/[...path]', { ...authenticated, params: catchAll(['unsupported']), body: {} }), 400, 'VALIDATION_FAILED');

    expectOk(await api('GET', '/api/v1/analytics/[[...path]]', { ...authenticated, params: catchAll([]) }));
    const bi = await api('POST', '/api/v1/analytics/[[...path]]', { ...authenticated, params: catchAll(['bi-credentials']), body: { name: 'Endpoint coverage', principalId: ws.owner.userId, allowedDatasets: ['deals'], queryLimit: 2 } });
    expectOk(bi);
    expectError(await api('POST', '/api/v1/analytics/[[...path]]', { ...authenticated, params: catchAll(['unsupported']), body: {} }), 400, 'REPORT_DEFINITION_INVALID');
    expectError(await api('PATCH', '/api/v1/analytics/[[...path]]', { ...authenticated, params: catchAll(['unsupported']), body: {} }), 400, 'REPORT_DEFINITION_INVALID');
    expectOk(await api('POST', '/api/v1/analytics/bi/query', { token: bi.data.secret, body: { datasetKey: 'deals' } }));
    expectError(await api('GET', '/t/[token]', { params: { token: MISSING_ID } }), 404);
  });

  it('exercises the Calendar route handlers with real workspace credentials', async () => {
    const template = '/api/v1/calendars/[[...path]]';
    const authenticated = { token: ws.owner.token, workspaceId: ws.owner.workspaceId };
    const created = await api('POST', template, { ...authenticated, params: { path: [] }, body: { type: 'PERSONAL', name: 'Endpoint calendar', timezone: 'UTC' } });
    expectOk(created);
    const params = { path: [created.data.id] };
    expectOk(await api('GET', template, { ...authenticated, params }));
    expectOk(await api('PATCH', template, { ...authenticated, params, body: { name: 'Updated', version: 1 } }));
    expectOk(await api('PUT', template, { ...authenticated, params, body: { name: 'Replaced', timezone: 'UTC', version: 2 } }));
    expectOk(await api('DELETE', template, { ...authenticated, params }));
  });

  it('exercises the Event route handlers with real workspace credentials', async () => {
    const authenticated = { token: ws.owner.token, workspaceId: ws.owner.workspaceId };
    const calendar = await api('POST', '/api/v1/calendars/[[...path]]', { ...authenticated, params: { path: [] }, body: { type: 'PERSONAL', name: 'Events', timezone: 'UTC' } });
    expectOk(calendar);
    const template = '/api/v1/calendar-events/[[...path]]';
    const created = await api('POST', template, { ...authenticated, params: { path: [] }, body: { calendarId: calendar.data.id, title: 'Meeting', startAt: '2030-01-01T09:00:00Z', endAt: '2030-01-01T10:00:00Z' } });
    expectOk(created);
    const params = { path: [created.data.id] };
    expectOk(await api('GET', template, { ...authenticated, params }));
    expectOk(await api('PATCH', template, { ...authenticated, params, body: { title: 'Updated', version: 1 } }));
    expectOk(await api('PUT', template, { ...authenticated, params, body: { title: 'Replaced', isAllDay: true, startDate: '2030-01-01', endDate: '2030-01-02', sourceTimezone: 'UTC', version: 2 } }));
    expectOk(await api('DELETE', template, { ...authenticated, params }));
  });

  it('exercises all recurrence routes with real workspace credentials', async () => {
    const authenticated = { token: ws.owner.token, workspaceId: ws.owner.workspaceId };
    const calendar = await api('POST', '/api/v1/calendars/[[...path]]', { ...authenticated, params: { path: [] }, body: { type: 'PERSONAL', name: 'Recurring events', timezone: 'UTC' } });
    expectOk(calendar);
    const template = '/api/v1/calendar-events/[[...path]]';
    const created = await api('POST', template, { ...authenticated, params: { path: [] }, body: { calendarId: calendar.data.id, title: 'Series', startAt: '2030-01-01T09:00:00Z', endAt: '2030-01-01T10:00:00Z' } });
    expectOk(created);
    const eventId = created.data.id;
    const rule = await api('PUT', template, { ...authenticated, params: { path: [eventId, 'recurrence'] }, body: { rruleText: 'FREQ=DAILY;COUNT=4', sourceTimezone: 'UTC', version: 0 } });
    expectOk(rule);
    expectOk(await api('GET', template, { ...authenticated, params: { path: [eventId, 'recurrence'] } }));
    expectOk(await api('PATCH', template, { ...authenticated, params: { path: [eventId, 'recurrence'] }, body: { rruleText: 'FREQ=DAILY;COUNT=5', version: 1 } }));
    expectOk(await api('PATCH', template, { ...authenticated, params: { path: [eventId, 'occurrences', rule.data.upcoming[1].recurrenceId] }, body: { title: 'One occurrence', version: 2 } }));
    expectOk(await api('PATCH', template, { ...authenticated, params: { path: [eventId, 'recurrence', 'future'] }, body: { recurrenceId: rule.data.upcoming[2].recurrenceId, title: 'Future occurrences', version: 3 } }));
    expectOk(await api('POST', template, { ...authenticated, params: { path: [eventId, 'occurrences', rule.data.upcoming[0].recurrenceId, 'cancel'] }, body: { version: 4 } }));
    expectOk(await api('DELETE', template, { ...authenticated, params: { path: [eventId, 'recurrence'] }, headers: { 'if-match': '"5"' } }));
  });

  it('exercises reminder configuration with real workspace credentials', async () => {
    const authenticated = { token: ws.owner.token, workspaceId: ws.owner.workspaceId };
    const calendar = await api('POST', '/api/v1/calendars/[[...path]]', { ...authenticated, params: { path: [] }, body: { type: 'PERSONAL', name: 'Reminders', timezone: 'UTC' } });
    expectOk(calendar);
    const events = '/api/v1/calendar-events/[[...path]]';
    const event = await api('POST', events, { ...authenticated, params: { path: [] }, body: { calendarId: calendar.data.id, title: 'Reminder meeting', startAt: '2030-01-01T09:00:00Z', endAt: '2030-01-01T10:00:00Z' } });
    expectOk(event);
    const reminder = await api('POST', events, { ...authenticated, params: { path: [event.data.id, 'reminders'] }, body: { offsetSeconds: 900, channel: 'IN_APP' } });
    expectOk(reminder);
    expectOk(await api('GET', events, { ...authenticated, params: { path: [event.data.id, 'reminders'] } }));
    const template = '/api/v1/calendar-reminders/[[...path]]', params = { path: [reminder.data.id] };
    expectOk(await api('PATCH', template, { ...authenticated, params, body: { offsetSeconds: 600, version: 1 } }));
    expectOk(await api('DELETE', template, { ...authenticated, params, headers: { 'if-match': '"2"' } }));
  });

  it('exercises resource configuration with real workspace credentials', async () => {
    const template = '/api/v1/calendar-resources/[[...path]]';
    const authenticated = { token: ws.owner.token, workspaceId: ws.owner.workspaceId };
    const created = await api('POST', template, { ...authenticated, params: { path: [] }, body: { type: 'ROOM', name: 'Room', timezone: 'UTC' } });
    expectOk(created); const params = { path: [created.data.id] };
    expectOk(await api('GET', template, { ...authenticated, params }));
    expectOk(await api('PATCH', template, { ...authenticated, params, body: { name: 'Updated', version: 1 } }));
    expectOk(await api('PUT', template, { ...authenticated, params, body: { type: 'EQUIPMENT', name: 'Projector', timezone: 'UTC', version: 2 } }));
    expectOk(await api('DELETE', template, { ...authenticated, params }));
  });

  it('exercises free/busy, suggestions and schedule configuration with real credentials', async () => {
    const template = '/api/v1/availability/[[...path]]';
    const authenticated = { token: ws.owner.token, workspaceId: ws.owner.workspaceId };
    const range = { startAt: '2030-01-07T08:00:00Z', endAt: '2030-01-07T18:00:00Z' };
    expectOk(await api('POST', template, { ...authenticated, params: { path: ['free-busy'] }, body: range }));
    expectOk(await api('POST', template, { ...authenticated, params: { path: ['suggest-slots'] }, body: { ...range, durationMinutes: 60 } }));
    expectOk(await api('GET', template, { ...authenticated, params: { path: ['business-calendar'] } }));
    expectOk(await api('PUT', template, { ...authenticated, params: { path: ['business-calendar'] }, body: { timezone: 'UTC', weekly: [{ dayOfWeek: 1, localStartTime: '09:00', localEndTime: '17:00' }], version: 0 } }));
  });

  it('exercises booking page configuration with real workspace credentials', async () => {
    const authenticated = { token: ws.owner.token, workspaceId: ws.owner.workspaceId };
    const calendar = await api('POST', '/api/v1/calendars/[[...path]]', { ...authenticated, params: { path: [] }, body: { type: 'PERSONAL', name: 'Booking host', timezone: 'UTC' } }); expectOk(calendar);
    const template = '/api/v1/booking-pages/[[...path]]';
    const input = { calendarId: calendar.data.id, title: 'Meet host', slug: 'meet-' + RUN, durationMinutes: 30 };
    const page = await api('POST', template, { ...authenticated, params: { path: [] }, body: input }); expectOk(page);
    const params = { path: [page.data.id] };
    expectOk(await api('GET', template, { ...authenticated, params }));
    expectOk(await api('PATCH', template, { ...authenticated, params, body: { title: 'Updated', version: 1 } }));
    expectOk(await api('PUT', template, { ...authenticated, params, body: { ...input, version: 2 } }));
    expectOk(await api('PUT', template, { ...authenticated, params: { path: [page.data.id, 'rules'] }, body: { timezone: 'UTC', weekly: [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({ dayOfWeek, localStartTime: '09:00', localEndTime: '17:00' })), version: 0 } }));
    expectOk(await api('POST', template, { ...authenticated, params: { path: [page.data.id, 'publish'] }, body: { version: 4 } }));
    const publicTemplate = '/api/v1/public/booking/[[...path]]';
    expectOk(await api('GET', publicTemplate, { params: { path: [input.slug] } }));
    const slots = await api('GET', publicTemplate, { params: { path: [input.slug, 'slots'] }, query: { startAt: new Date(Date.now() + 86_400_000).toISOString(), endAt: new Date(Date.now() + 8 * 86_400_000).toISOString() } }); expectOk(slots);
    expect(slots.data.slots.length).toBeGreaterThan(0);
    const booking = await api('POST', publicTemplate, { params: { path: [input.slug, 'bookings'] }, body: { guestName: 'Guest', guestEmail: 'booking@example.com', startAt: slots.data.slots[0].startAt, clientRequestId: randomUUID() } }); expectOk(booking);
    expectOk(await api('PATCH', '/api/v1/bookings/[[...path]]', { ...authenticated, params: { path: [booking.data.bookingId] }, body: { guestName: 'Updated guest', version: 1 } }));
    expectOk(await api('POST', '/api/v1/bookings/[[...path]]', { ...authenticated, params: { path: [booking.data.bookingId, 'cancel'] }, body: { version: 2 } }));
    expectError(await api('POST', '/api/v1/public/bookings/[[...path]]', { params: { path: [booking.data.cancellationToken, 'cancel'] }, body: {} }), 404, 'BOOKING_TOKEN_INVALID');
    expectOk(await api('POST', template, { ...authenticated, params: { path: [page.data.id, 'unpublish'] }, body: { version: 5 } }));
    expectOk(await api('DELETE', template, { ...authenticated, params }));
  });

  it('exercises protected Booking reads with real workspace credentials', async () => {
    const authenticated = { token: ws.owner.token, workspaceId: ws.owner.workspaceId };
    expectOk(await api('GET', '/api/v1/bookings/[[...path]]', { ...authenticated, params: { path: [] } }));
    expectError(await api('GET', '/api/v1/bookings/[[...path]]', { ...authenticated, params: { path: [MISSING_ID] } }), 404, 'BOOKING_NOT_FOUND');
    expectError(await api('POST', '/api/v1/bookings/[[...path]]', { ...authenticated, params: { path: [MISSING_ID, 'approve'] }, body: { version: 1 } }), 404, 'BOOKING_NOT_FOUND');
    expectError(await api('POST', '/api/v1/public/booking/[[...path]]', { params: { path: ['unavailable-page', 'bookings'] }, body: {} }), 404, 'BOOKING_PAGE_NOT_FOUND');
    expectError(await api('POST', '/api/v1/public/bookings/[[...path]]', { params: { path: ['invalid-token', 'cancel'] }, body: {} }), 404, 'BOOKING_TOKEN_INVALID');
  });

  it('exercises shared Notifications with real workspace credentials', async () => {
    const authenticated = { token: ws.owner.token, workspaceId: ws.owner.workspaceId };
    const inbox = '/api/v1/notifications/[[...path]]', preferences = '/api/v1/notification-preferences/[[...path]]';
    expectOk(await api('GET', inbox, { ...authenticated, params: { path: [] } }));
    expectError(await api('POST', inbox, { ...authenticated, params: { path: [MISSING_ID, 'read'] }, body: {} }), 404, 'NOTIFICATION_NOT_FOUND');
    expectOk(await api('GET', preferences, { ...authenticated, params: { path: [] } }));
    expectOk(await api('PUT', preferences, { ...authenticated, params: { path: [] }, body: { notificationType: 'CALENDAR_REMINDER', channel: 'IN_APP', enabled: true } }));
  });

  it('exercises canonical Project Chat and Drive routes with real workspace credentials', async () => {
    const auth = { token: ws.owner.token, workspaceId: ws.owner.workspaceId };
    const project = await api('POST', '/api/v1/projects/[[...path]]', { ...auth, params: { path: [] },
      body: { name: 'Canonical resources', tools: ['TASKS', 'CHAT', 'CALENDAR', 'DRIVE'] } }); expectOk(project);
    const linked = await api('GET', '/api/v1/projects/[[...path]]', { ...auth, params: { path: [project.data.id, 'linked-resources'] } }); expectOk(linked);
    const chatId = linked.data.CHAT.resourceId, storageId = linked.data.DRIVE.resourceId;
    const chatRoute = '/api/v1/chats/[[...path]]';
    expectOk(await api('GET', chatRoute, { ...auth, params: { path: [chatId] } }));
    expectOk(await api('GET', chatRoute, { ...auth, params: { path: [chatId, 'members'] } }));
    expectOk(await api('POST', chatRoute, { ...auth, params: { path: [chatId, 'members'] }, body: { userId: ws.owner.userId } }));
    expectOk(await api('DELETE', chatRoute, { ...auth, params: { path: [chatId, 'members', ws.owner.userId] } }));
    const storageRoute = '/api/v1/file-storages/[[...path]]';
    expectOk(await api('POST', storageRoute, { ...auth, params: { path: [] }, body: { type: 'SYSTEM', name: 'System read smoke' } }));
    expectOk(await api('GET', storageRoute, { ...auth, params: { path: [] } }));
    expectOk(await api('GET', storageRoute, { ...auth, params: { path: [storageId] } }));
    const root = await api('GET', storageRoute, { ...auth, params: { path: [storageId, 'root'] } }); expectOk(root);
    const child = await api('POST', '/api/v1/folders/[[...path]]', { ...auth, params: { path: [] }, body: { storageId, parentFolderId: root.data.id, name: 'Nested smoke' } }); expectOk(child);
    expectOk(await api('GET', '/api/v1/folders/[[...path]]', { ...auth, params: { path: [child.data.id] } }));
    expectOk(await api('PATCH', storageRoute, { ...auth, params: { path: [storageId] }, body: { name: 'Drive smoke', version: 1 } }));
    const storageAcl = await api('GET', storageRoute, { ...auth, params: { path: [storageId, 'permissions'] } }); expectOk(storageAcl);
    expectOk(await api('PUT', storageRoute, { ...auth, params: { path: [storageId, 'permissions'] }, body: { assignments: [], version: storageAcl.data.version } }));
    const folderAcl = await api('GET', '/api/v1/folders/[[...path]]', { ...auth, params: { path: [root.data.id, 'permissions'] } }); expectOk(folderAcl);
    expectOk(await api('PUT', '/api/v1/folders/[[...path]]', { ...auth, params: { path: [root.data.id, 'permissions'] }, body: { assignments: [], version: folderAcl.data.version } }));
    const renamed = await api('PATCH', '/api/v1/folders/[[...path]]', { ...auth, params: { path: [child.data.id] }, body: { name: 'Renamed smoke', version: child.data.version } }); expectOk(renamed);
    expectOk(await api('DELETE', '/api/v1/folders/[[...path]]', { ...auth, params: { path: [child.data.id] }, body: { version: renamed.data.version } }));
    const group = await api('POST', chatRoute, { ...auth, params: { path: [] }, body: { type: 'GROUP', title: 'Group smoke' } }); expectOk(group);
    expectOk(await api('GET', chatRoute, { ...auth, params: { path: [] } }));
    const putGroup = await api('PUT', chatRoute, { ...auth, params: { path: [group.data.id] }, body: { title: 'Group smoke', version: group.data.version } }); expectOk(putGroup);
    expectOk(await api('PATCH', chatRoute, { ...auth, params: { path: [group.data.id] }, body: { title: 'Group smoke 2', version: putGroup.data.version } }));
    const smokeMessage = await api('POST', chatRoute, { ...auth, params: { path: [group.data.id, 'messages'] }, body: { clientMessageId: randomUUID(), body: 'Smoke message' } }); expectOk(smokeMessage);
    const channelRoute = '/api/v1/channels/[[...path]]';
    const smokeChannel = await api('POST', channelRoute, { ...auth, params: { path: [] }, body: { name: 'Smoke channel' } }); expectOk(smokeChannel);
    expectOk(await api('GET', channelRoute, { ...auth, params: { path: [] } }));
    const putChannel = await api('PUT', channelRoute, { ...auth, params: { path: [smokeChannel.data.id] }, body: { name: 'Smoke channel', version: smokeChannel.data.version } }); expectOk(putChannel);
    expectOk(await api('PATCH', channelRoute, { ...auth, params: { path: [smokeChannel.data.id] }, body: { description: 'Smoke', version: putChannel.data.version } }));
    const smokePost = await api('POST', channelRoute, { ...auth, params: { path: [smokeChannel.data.id, 'posts'] }, body: { body: 'Smoke post' } }); expectOk(smokePost);
    const postRoute = '/api/v1/channel-posts/[[...path]]';
    expectOk(await api('GET', postRoute, { ...auth, params: { path: [smokePost.data.id] } }));
    expectOk(await api('PATCH', postRoute, { ...auth, params: { path: [smokePost.data.id] }, body: { body: 'Smoke post edited', version: 1 } }));
    const smokeComment = await api('POST', postRoute, { ...auth, params: { path: [smokePost.data.id, 'comments'] }, body: { body: 'Smoke comment' } }); expectOk(smokeComment);
    const commentRoute = '/api/v1/channel-comments/[[...path]]';
    expectOk(await api('PATCH', commentRoute, { ...auth, params: { path: [smokeComment.data.id] }, body: { body: 'Edited comment', version: 1 } }));
    expectOk(await api('DELETE', commentRoute, { ...auth, params: { path: [smokeComment.data.id] }, body: {} }));
    expectOk(await api('DELETE', postRoute, { ...auth, params: { path: [smokePost.data.id] }, body: {} }));
    const channelVersion = (await api('GET', channelRoute, { ...auth, params: { path: [smokeChannel.data.id] } })).data.version;
    expectOk(await api('DELETE', channelRoute, { ...auth, params: { path: [smokeChannel.data.id] }, body: { version: channelVersion } }));
    const collabRoute = '/api/v1/collabs/[[...path]]';
    const smokeCollab = await api('POST', collabRoute, { ...auth, params: { path: [] }, body: { name: 'Smoke collab' } }); expectOk(smokeCollab);
    expectOk(await api('GET', collabRoute, { ...auth, params: { path: [] } }));
    const putCollab = await api('PUT', collabRoute, { ...auth, params: { path: [smokeCollab.data.id] }, body: { name: 'Smoke collab', version: smokeCollab.data.version } }); expectOk(putCollab);
    expectOk(await api('PATCH', collabRoute, { ...auth, params: { path: [smokeCollab.data.id] }, body: { description: 'Smoke', version: putCollab.data.version } }));
    const smokeInvite = await api('POST', collabRoute, { ...auth, params: { path: [smokeCollab.data.id, 'invitations'] }, body: { email: `smoke-${randomUUID()}@example.com` } }); expectOk(smokeInvite);
    expectError(await api('POST', '/api/v1/public/collab-invitations/[[...path]]', { token: auth.token, params: { path: [smokeInvite.data.token, 'accept'] }, body: {} }), 403, 'COLLAB_INVITATION_INVALID');
    expectOk(await api('DELETE', collabRoute, { ...auth, params: { path: [smokeCollab.data.id, 'invitations', smokeInvite.data.id] }, body: {} }));
    const callRoute = '/api/v1/calls/[[...path]]';
    const syncRoute = '/api/v1/calendar-sync/[[...path]]';
    const syncCalendar = await api('POST', '/api/v1/calendars/[[...path]]', { ...auth, params: { path: [] }, body: { type: 'PERSONAL', name: 'Sync smoke', timezone: 'UTC' } }); expectOk(syncCalendar);
    const smokeIcs = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:smoke\r\nDTSTART;VALUE=DATE:20261101\r\nDTEND;VALUE=DATE:20261102\r\nSUMMARY:Smoke\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const smokeSync = await api('POST', syncRoute, { ...auth, params: { path: ['connections', 'ics', 'import'] }, body: { calendarId: syncCalendar.data.id, icsContent: smokeIcs } }); expectOk(smokeSync);
    expectOk(await api('GET', syncRoute, { ...auth, params: { path: ['connections'] } }));
    expectOk(await api('GET', syncRoute, { ...auth, params: { path: ['connections', smokeSync.data.connection.id, 'mappings'] } }));
    expect((await api('GET', syncRoute, { ...auth, params: { path: ['ics', 'export'] }, query: { calendarId: syncCalendar.data.id } })).status).toBe(200);
    expectOk(await api('DELETE', syncRoute, { ...auth, params: { path: ['connections', smokeSync.data.connection.id] }, body: {} }));
    expectOk(await api('GET', callRoute, { ...auth, params: { path: [] } }));
    // No media provider is configured in the endpoint smoke: start fails visibly and durably.
    const failedCall = await api('POST', callRoute, { ...auth, params: { path: [] }, body: { inviteeUserIds: [] } });
    expectError(failedCall, 502, 'CALL_PROVIDER_ERROR');
    expect((await api('GET', callRoute, { ...auth, params: { path: [failedCall.body.error.details.callId] } })).data.status).toBe('FAILED');
    expectError(await api('POST', '/api/v1/public/calls/[[...path]]', { params: { path: ['a'.repeat(43), 'join'] }, body: {} }), 404, 'CALL_EXTERNAL_TOKEN_INVALID');
    const feedRoute = '/api/v1/feed/[[...path]]';
    const smokeFeedPost = await api('POST', feedRoute, { ...auth, params: { path: ['posts'] }, body: { postType: 'POLL', body: 'Smoke poll', publish: false, recipients: [{ recipientType: 'WORKSPACE' }] } }); expectOk(smokeFeedPost);
    expectOk(await api('GET', feedRoute, { ...auth, params: { path: [] } }));
    const putFeedPost = await api('PUT', feedRoute, { ...auth, params: { path: ['posts', smokeFeedPost.data.id] }, body: { body: 'Smoke poll?', recipients: [{ recipientType: 'WORKSPACE' }], version: smokeFeedPost.data.version } }); expectOk(putFeedPost);
    expectOk(await api('PATCH', feedRoute, { ...auth, params: { path: ['posts', smokeFeedPost.data.id] }, body: { title: 'Smoke', version: putFeedPost.data.version } }));
    const smokePoll = await api('POST', feedRoute, { ...auth, params: { path: ['posts', smokeFeedPost.data.id, 'polls'] }, body: { question: 'Works?', options: ['Yes', 'No'] } }); expectOk(smokePoll);
    expectOk(await api('POST', feedRoute, { ...auth, params: { path: ['posts', smokeFeedPost.data.id, 'publish'] }, body: {} }));
    const pollRoute = '/api/v1/polls/[[...path]]';
    expectOk(await api('POST', pollRoute, { ...auth, params: { path: [smokePoll.data.poll.id, 'votes'] }, body: { optionIds: [smokePoll.data.poll.options[0].id] } }));
    expectOk(await api('DELETE', pollRoute, { ...auth, params: { path: [smokePoll.data.poll.id, 'votes', 'me'] }, body: {} }));
    expectOk(await api('DELETE', feedRoute, { ...auth, params: { path: ['posts', smokeFeedPost.data.id] }, body: {} }));
    const messageRoute = '/api/v1/messages/[[...path]]';
    expectOk(await api('GET', messageRoute, { ...auth, params: { path: [smokeMessage.data.id] } }));
    expectOk(await api('GET', messageRoute, { ...auth, params: { path: ['search'] }, query: { q: 'Smoke' } }));
    expectOk(await api('PATCH', messageRoute, { ...auth, params: { path: [smokeMessage.data.id] }, body: { body: 'Smoke edited', version: 1 } }));
    expectOk(await api('POST', messageRoute, { ...auth, params: { path: [smokeMessage.data.id, 'pin'] }, body: {} }));
    expectOk(await api('DELETE', messageRoute, { ...auth, params: { path: [smokeMessage.data.id] }, body: {} }));
    expectOk(await api('GET', chatRoute, { ...auth, params: { path: [group.data.id, 'members'] } }));
    expectOk(await api('GET', '/api/v1/folders/[[...path]]', { ...auth, params: { path: [root.data.id] } }));
    const { prisma } = await import('@/src/server/prisma-client');
    const fileId = randomUUID(), versionId = randomUUID(), createdAt = new Date();
    await prisma.$transaction(async tx => {
      await tx.driveFile.create({ data: { id: fileId, workspaceId: auth.workspaceId, storageId, folderId: root.data.id, name: 'File smoke.pdf', extension: 'pdf', mimeType: 'application/pdf',
        currentVersionId: versionId, status: 'ACTIVE', sizeBytesCurrent: 10, version: 1, publicShareVersion: 1, createdAt, updatedAt: createdAt } });
      await tx.driveFileVersion.create({ data: { id: versionId, workspaceId: auth.workspaceId, fileId, versionNumber: 1, objectKey: `${auth.workspaceId}/smoke/${versionId}`, sizeBytes: 10,
        checksum: 'a'.repeat(64), mimeType: 'application/pdf', createdByUserId: ws.owner.userId, createdAt, processedAt: createdAt, scanStatus: 'CLEAN' } });
    });
    const fileRoute = '/api/v1/files/[[...path]]';
    const uploadRoute = '/api/v1/upload-sessions/[[...path]]';
    const upload = await api('POST', uploadRoute, { ...auth, params: { path: [] }, body: { targetFolderId: root.data.id, desiredFileName: 'Upload smoke.txt', expectedSizeBytes: 0,
      expectedChecksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', mimeType: 'text/plain', idempotencyKey: randomUUID() } }); expectOk(upload);
    expectOk(await api('GET', uploadRoute, { ...auth, params: { path: [upload.data.id] } }));
    expectOk(await api('POST', uploadRoute, { ...auth, params: { path: [upload.data.id, 'abort'] }, body: {} }));
    expectOk(await api('GET', fileRoute, { ...auth, params: { path: [fileId] } }));
    const fileAcl = await api('PUT', fileRoute, { ...auth, params: { path: [fileId, 'permissions'] }, body: { version: 1, assignments: [] } }); expectOk(fileAcl);
    const updatedFile = await api('PATCH', fileRoute, { ...auth, params: { path: [fileId] }, body: { name: 'File smoke renamed.pdf', version: fileAcl.data.version } }); expectOk(updatedFile);
    expectOk(await api('POST', fileRoute, { ...auth, params: { path: [fileId, 'copy'] }, body: { folderId: root.data.id, name: 'File smoke copy.pdf' } }));
    const attachmentRoute = '/api/v1/attachments/[[...path]]';
    const attachment = await api('POST', attachmentRoute, { ...auth, params: { path: [] }, body: { fileId, entityType: 'PROJECT', entityId: project.data.id } }); expectOk(attachment);
    expectOk(await api('GET', attachmentRoute, { ...auth, params: { path: [] } }));
    expectOk(await api('GET', attachmentRoute, { ...auth, params: { path: [attachment.data.id] } }));
    expectOk(await api('GET', '/api/v1/entities/[[...path]]', { ...auth, params: { path: ['PROJECT', project.data.id, 'attachments'] } }));
    expectOk(await api('DELETE', attachmentRoute, { ...auth, params: { path: [attachment.data.id] }, body: {} }));
    const detachedFile = await api('GET', fileRoute, { ...auth, params: { path: [fileId] } }); expectOk(detachedFile);
    expectOk(await api('GET', fileRoute, { ...auth, params: { path: [fileId, 'edit-sessions'] } }));
    expectError(await api('POST', fileRoute, { ...auth, params: { path: [fileId, 'edit-sessions'] }, body: {} }), 409, 'FILE_NOT_EDITABLE');
    const editRoute = '/api/v1/edit-sessions/[[...path]]';
    expectError(await api('GET', editRoute, { ...auth, params: { path: [MISSING_ID] } }), 404, 'EDIT_SESSION_NOT_FOUND');
    for (const action of ['heartbeat', 'complete', 'abort'])
      expectError(await api('POST', editRoute, { ...auth, params: { path: [MISSING_ID, action] }, body: {} }), 404, 'EDIT_SESSION_NOT_FOUND');
    const lease = await api('POST', fileRoute, { ...auth, params: { path: [fileId, 'locks'] }, body: {} }); expectOk(lease);
    expectOk(await api('DELETE', fileRoute, { ...auth, params: { path: [fileId, 'locks', lease.data.id] }, body: { lockToken: lease.data.lockToken } }));
    const forcedLease = await api('POST', fileRoute, { ...auth, params: { path: [fileId, 'locks'] }, body: {} }); expectOk(forcedLease);
    expectOk(await api('POST', fileRoute, { ...auth, params: { path: [fileId, 'locks', forcedLease.data.id, 'force-release'] }, body: { version: 1, reason: 'Endpoint smoke cleanup' } }));
    expectOk(await api('DELETE', fileRoute, { ...auth, params: { path: [fileId] }, body: { version: detachedFile.data.version } }));
    const publicLink = await api('POST', '/api/v1/folders/[[...path]]', { ...auth, params: { path: [root.data.id, 'public-links'] }, body: { includeChildren: true } }); expectOk(publicLink);
    expectOk(await api('GET', '/api/v1/public-links/[[...path]]', { ...auth, params: { path: [] } }));
    expectOk(await api('GET', '/api/v1/public-links/[[...path]]', { ...auth, params: { path: [publicLink.data.id] } }));
    expectOk(await api('GET', '/api/v1/public/folders/[[...path]]', { params: { path: [publicLink.data.token] } }));
    expectError(await api('GET', '/api/v1/public/files/[[...path]]', { params: { path: [publicLink.data.token] } }), 404, 'PUBLIC_LINK_NOT_FOUND');
    expectError(await api('GET', '/api/v1/public/files/[[...path]]', { params: { path: [publicLink.data.token, 'download'] } }), 404, 'PUBLIC_LINK_NOT_FOUND');
    expectError(await api('GET', '/api/v1/public/folders/[[...path]]', { params: { path: [publicLink.data.token, 'download'] }, query: { fileId: MISSING_ID } }), 403, 'PERMISSION_DENIED');
    expectError(await api('GET', '/api/v1/file-delivery/[id]', { params: { id: MISSING_ID } }), 410, 'FILE_DELIVERY_UNAVAILABLE');
    const changedLink = await api('PATCH', '/api/v1/public-links/[[...path]]', { ...auth, params: { path: [publicLink.data.id] }, body: { includeChildren: false, version: 1 } }); expectOk(changedLink);
    expectOk(await api('DELETE', '/api/v1/public-links/[[...path]]', { ...auth, params: { path: [publicLink.data.id] }, body: { version: changedLink.data.version } }));
    const templateRoute = '/api/v1/document-templates/[[...path]]', generatedRoute = '/api/v1/generated-documents/[[...path]]';
    const docTemplate = await api('POST', templateRoute, { ...auth, params: { path: [] }, body: { name: 'Smoke template', templateType: 'HTML', entityType: 'PROJECT',
      documentType: 'SMOKE', htmlTemplate: '<p>{{entity.name}}</p>' } }); expectOk(docTemplate);
    expectOk(await api('GET', templateRoute, { ...auth, params: { path: [] } }));
    expectOk(await api('GET', templateRoute, { ...auth, params: { path: [docTemplate.data.id] } }));
    expectOk(await api('POST', templateRoute, { ...auth, params: { path: [docTemplate.data.id, 'preview'] }, body: { entityId: project.data.id } }));
    const putTemplate = await api('PUT', templateRoute, { ...auth, params: { path: [docTemplate.data.id] }, body: { version: 1, name: 'Smoke template', documentType: 'SMOKE',
      htmlTemplate: '<h1>{{entity.name}}</h1>' } }); expectOk(putTemplate);
    expectOk(await api('PATCH', templateRoute, { ...auth, params: { path: [docTemplate.data.id] }, body: { version: putTemplate.data.version, description: 'Smoke' } }));
    const generatedDoc = await api('POST', generatedRoute, { ...auth, params: { path: [] }, body: { templateId: docTemplate.data.id, entityId: project.data.id,
      folderId: root.data.id, generationKey: randomUUID() } });
    expect(generatedDoc.status).toBe(202);
    expectOk(await api('GET', generatedRoute, { ...auth, params: { path: [] } }));
    expectOk(await api('GET', generatedRoute, { ...auth, params: { path: [generatedDoc.data.id] } }));
    expectError(await api('GET', generatedRoute, { ...auth, params: { path: [generatedDoc.data.id, 'download'] } }), 409, 'DOCUMENT_STATE_INVALID');
    expectError(await api('POST', generatedRoute, { ...auth, params: { path: [generatedDoc.data.id, 'regenerate'] }, body: { generationKey: randomUUID() } }), 409, 'DOCUMENT_STATE_INVALID');
    expectOk(await api('DELETE', generatedRoute, { ...auth, params: { path: [generatedDoc.data.id] }, body: { version: generatedDoc.data.version } }));
    expectOk(await api('DELETE', templateRoute, { ...auth, params: { path: [docTemplate.data.id] }, body: { version: putTemplate.data.version + 1 } }));
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
