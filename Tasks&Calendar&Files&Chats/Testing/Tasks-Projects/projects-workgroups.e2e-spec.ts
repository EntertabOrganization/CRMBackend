/**
 * TrueCRM API E2E contract for Projects & Workgroups Specification.
 * Wired to the real Next route handlers, the transactional request wrapper and PostgreSQL (see ../support/e2e.ts).
 */
import { ALL_TASK_PERMISSIONS, MISSING_ID, PROJECT_MEMBER_PERMISSIONS, call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
import type { Session } from '../support/e2e';

jest.setTimeout(180_000);

let owner: Session;
let colleague: Session;
let noPerm: Session;
let outsider: Session;

beforeAll(async () => {
  await prepareCollabDatabase();
  owner = await register('projects-owner');
  colleague = await member(owner, 'projects-colleague', [...PROJECT_MEMBER_PERMISSIONS, ...ALL_TASK_PERMISSIONS]);
  noPerm = await member(owner, 'projects-noperm', [['task.read', 'OWN']]);
  outsider = await register('projects-outsider');
});

afterAll(disconnect);

async function newProject(session: Session = owner, body: Record<string, unknown> = {}) {
  return expectOk(await call(session, 'POST', 'projects', { body: { name: `Migration ${Math.random().toString(36).slice(2, 8)}`, ...body } }));
}

describe('Projects & Workgroups Specification E2E contract', () => {
  it('exposes and enforces representative routes: POST   /api/v1/projects; GET    /api/v1/projects; GET    /api/v1/projects/:id; PUT    /api/v1/projects/:id', async () => {
    // POST — defaults, owner membership, default Kanban stages, no eager linked resources.
    const project = await newProject(owner, { code: `MIG-${Date.now()}`, startDate: '2026-11-01', endDate: '2026-12-31', visibility: 'WORKSPACE_VISIBLE' });
    expect(project).toMatchObject({ projectType: 'PROJECT', status: 'ACTIVE', ownerUserId: owner.userId, workspaceId: owner.workspaceId, startDate: '2026-11-01', endDate: '2026-12-31', myRole: 'OWNER', version: 1 });
    expect(project.enabledTools.sort()).toEqual(['KANBAN', 'TASKS']);
    const prisma = await db();
    expect(await prisma.projectStage.count({ where: { projectId: project.id } })).toBe(3);
    expect((await prisma.projectTool.findMany({ where: { projectId: project.id, linkedResourceId: { not: null } } }))).toHaveLength(0);
    // Date-only semantics survive the database round trip unchanged.
    const stored = await prisma.project.findUnique({ where: { id: project.id } });
    expect(stored!.startDate!.toISOString().slice(0, 10)).toBe('2026-11-01');

    // Workgroups are ongoing: no end date.
    expectError(await call(owner, 'POST', 'projects', { body: { name: 'Ops', projectType: 'WORKGROUP', endDate: '2026-12-31' } }), 400, 'VALIDATION_ERROR');
    const workgroup = await newProject(owner, { projectType: 'WORKGROUP' });
    expect(workgroup.projectType).toBe('WORKGROUP');

    // GET list (visible only) + GET one
    const list = await call(colleague, 'GET', 'projects', { query: { projectType: 'PROJECT' } });
    expect(expectOk(list).map((row: any) => row.id)).toContain(project.id);
    expect(list.body.meta.page).toBe(1);
    expect(expectOk(await call(colleague, 'GET', `projects/${project.id}`)).myRole).toBeNull();

    // PUT — complete replace with version; owner cannot be changed here; ARCHIVED not settable.
    expectError(await call(owner, 'PUT', `projects/${project.id}`, { body: { name: 'X', version: 1 } }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'PUT', `projects/${project.id}`, { body: { name: 'X', projectType: 'PROJECT', status: 'ARCHIVED', visibility: 'OPEN', version: 1 } }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'PUT', `projects/${project.id}`, { body: { name: 'X', projectType: 'PROJECT', status: 'ACTIVE', visibility: 'OPEN', ownerUserId: colleague.userId, version: 1 } }), 400, 'VALIDATION_ERROR');
    const replaced = expectOk(await call(owner, 'PUT', `projects/${project.id}`, { body: { name: 'Replaced', projectType: 'PROJECT', status: 'ON_HOLD', visibility: 'OPEN', version: 1 } }));
    expect(replaced).toMatchObject({ name: 'Replaced', status: 'ON_HOLD', visibility: 'OPEN', code: null, startDate: null, version: 2 });
    expectError(await call(owner, 'PUT', `projects/${project.id}`, { body: { name: 'Stale', projectType: 'PROJECT', status: 'ACTIVE', visibility: 'OPEN', version: 1 } }), 409, 'RESOURCE_VERSION_CONFLICT');

    // PATCH — partial
    const patched = expectOk(await call(owner, 'PATCH', `projects/${project.id}`, { body: { description: 'Partial', version: 2 } }));
    expect(patched).toMatchObject({ name: 'Replaced', description: 'Partial', version: 3 });
    // Visibility grants discovery, not mutation rights.
    expectError(await call(colleague, 'PATCH', `projects/${project.id}`, { body: { name: 'Hijack', version: 3 } }), 403, 'PERMISSION_DENIED');
  });

  it('requires authenticated/authorized workspace context for protected endpoints', async () => {
    const project = await newProject(owner, { visibility: 'WORKSPACE_VISIBLE' });
    expectError(await call(null, 'GET', `projects/${project.id}`, { workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    expectError(await call(null, 'POST', 'projects', { body: { name: 'x' }, workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    expectError(await call(noPerm, 'POST', 'projects', { body: { name: 'x' } }), 403, 'PERMISSION_DENIED');
    expectError(await call(noPerm, 'GET', 'projects'), 403, 'PERMISSION_DENIED');
    expectError(await call(noPerm, 'GET', `projects/${project.id}`), 403, 'PERMISSION_DENIED');
    expectError(await call(outsider, 'GET', `projects/${project.id}`, { workspaceId: owner.workspaceId }), 403, 'PERMISSION_DENIED');
    // Private projects are invisible to non-members even with project.read.
    const secret = await newProject(owner, { visibility: 'PRIVATE' });
    expectError(await call(colleague, 'GET', `projects/${secret.id}`), 404, 'PROJECT_NOT_FOUND');
    expect(expectOk(await call(colleague, 'GET', 'projects')).map((row: any) => row.id)).not.toContain(secret.id);
  });

  it('rejects cross-workspace resource access without leaking resource existence', async () => {
    const project = await newProject(owner, { visibility: 'OPEN' });
    const foreign = expectError(await call(outsider, 'GET', `projects/${project.id}`), 404, 'PROJECT_NOT_FOUND');
    const missing = expectError(await call(outsider, 'GET', `projects/${MISSING_ID}`), 404, 'PROJECT_NOT_FOUND');
    expect(foreign.message).toBe(missing.message);
    for (const [method, path] of [
      ['PATCH', `projects/${project.id}`], ['DELETE', `projects/${project.id}`], ['POST', `projects/${project.id}/archive`],
      ['GET', `projects/${project.id}/tools`], ['POST', `projects/${project.id}/tools/CHAT/enable`], ['GET', `projects/${project.id}/linked-resources`],
    ] as const) {
      expectError(await call(outsider, method, path, { body: method === 'PATCH' ? { name: 'x', version: 1 } : undefined }), 404, 'PROJECT_NOT_FOUND');
    }
    // A foreign project cannot receive tasks.
    expectError(await call(outsider, 'POST', 'tasks', { body: { title: 'x', projectId: project.id } }), 404, 'PROJECT_NOT_FOUND');
    expectError(await call(outsider, 'POST', 'projects', { body: { name: 'x', ownerUserId: owner.userId } }), 400, 'PROJECT_OWNER_INVALID');
  });

  it('returns stable machine-readable error envelopes for invalid requests', async () => {
    expectError(await call(owner, 'POST', 'projects', { body: {} }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'POST', 'projects', { body: { name: 'x', visibility: 'SECRET' } }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'POST', 'projects', { body: { name: 'x', startDate: '2026-02-30' } }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'POST', 'projects', { body: { name: 'x', startDate: '2026-05-02', endDate: '2026-05-01' } }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'POST', 'projects', { body: { name: 'x', tools: ['TELEPORT'] } }), 400, 'VALIDATION_ERROR');
    const code = `DUP-${Date.now()}`;
    await newProject(owner, { code });
    expectError(await call(owner, 'POST', 'projects', { body: { name: 'dup', code } }), 409, 'PROJECT_CODE_CONFLICT');
    expectError(await call(owner, 'POST', `projects/${MISSING_ID}/tools/TELEPORT/enable`), 404, 'PROJECT_NOT_FOUND');
    const project = await newProject();
    expectError(await call(owner, 'POST', `projects/${project.id}/tools/TELEPORT/enable`), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'GET', `projects/${project.id}/nonexistent`), 404, 'ROUTE_NOT_FOUND');
    expectError(await call(owner, 'PUT', `projects/${project.id}/archive`), 405, 'METHOD_NOT_ALLOWED');
  });

  it('persists critical state and outbox/audit consistently on successful mutation', async () => {
    const project = await newProject();
    const prisma = await db();
    expect((await prisma.outboxEvent.findMany({ where: { entityId: project.id } })).map((row) => row.eventType)).toEqual(['PROJECT_CREATED']);
    expect((await prisma.auditLog.findMany({ where: { entityId: project.id } })).map((row) => row.action)).toEqual(['PROJECT.CREATED']);
    expect(await prisma.projectMember.findMany({ where: { projectId: project.id } })).toEqual([expect.objectContaining({ userId: owner.userId, memberRole: 'OWNER', status: 'ACTIVE' })]);
    expectOk(await call(owner, 'POST', `projects/${project.id}/archive`));
    expect((await prisma.auditLog.findMany({ where: { entityId: project.id } })).map((row) => row.action)).toContain('PROJECT.ARCHIVED');
    expect(await prisma.outboxEvent.count({ where: { entityId: project.id, eventType: 'PROJECT_ARCHIVED' } })).toBe(1);
  });
});

describe('Project lifecycle endpoints', () => {
  it('archive makes the project and its tasks read-only; unarchive restores the previous status', async () => {
    const project = await newProject(owner, { status: 'ON_HOLD', memberUserIds: [colleague.userId] });
    const task = expectOk(await call(owner, 'POST', 'tasks', { body: { title: 'In project', projectId: project.id, responsibleUserId: colleague.userId } }));
    expectError(await call(colleague, 'POST', `projects/${project.id}/archive`), 403, 'PERMISSION_DENIED');
    const archived = expectOk(await call(owner, 'POST', `projects/${project.id}/archive`));
    expect(archived).toMatchObject({ status: 'ARCHIVED', statusBeforeArchive: 'ON_HOLD' });
    expectError(await call(owner, 'POST', `projects/${project.id}/archive`), 409, 'PROJECT_ARCHIVED');
    expectError(await call(owner, 'PATCH', `projects/${project.id}`, { body: { name: 'x', version: archived.version } }), 409, 'PROJECT_ARCHIVED');
    expectError(await call(colleague, 'POST', `tasks/${task.id}/start`), 409, 'PROJECT_ARCHIVED');
    expectError(await call(owner, 'POST', 'tasks', { body: { title: 'late', projectId: project.id } }), 409, 'PROJECT_ARCHIVED');
    expectError(await call(owner, 'POST', `projects/${project.id}/members`, { body: { userId: noPerm.userId } }), 409, 'PROJECT_ARCHIVED');
    // History stays readable.
    expect(expectOk(await call(colleague, 'GET', `tasks/${task.id}`)).id).toBe(task.id);
    expect(expectOk(await call(colleague, 'GET', `projects/${project.id}`)).status).toBe('ARCHIVED');
    const restored = expectOk(await call(owner, 'POST', `projects/${project.id}/unarchive`));
    expect(restored).toMatchObject({ status: 'ON_HOLD', statusBeforeArchive: null });
    expectError(await call(owner, 'POST', `projects/${project.id}/unarchive`), 409, 'PROJECT_NOT_ARCHIVED');
    expect(expectOk(await call(colleague, 'POST', `tasks/${task.id}/start`)).status).toBe('IN_PROGRESS');
  });

  it('DELETE / PATCH restore / DELETE hard', async () => {
    const project = await newProject(owner, { memberUserIds: [colleague.userId] });
    const task = expectOk(await call(owner, 'POST', 'tasks', { body: { title: 'Survives hard delete', projectId: project.id } }));
    expectError(await call(owner, 'DELETE', `projects/${project.id}/hard`), 409, 'PROJECT_NOT_DELETED');
    expectError(await call(colleague, 'DELETE', `projects/${project.id}`), 403, 'PERMISSION_DENIED');
    expectOk(await call(owner, 'DELETE', `projects/${project.id}`));
    expectError(await call(owner, 'GET', `projects/${project.id}`), 404, 'PROJECT_NOT_FOUND');
    expect(expectOk(await call(owner, 'GET', 'projects', { query: { deleted: 'true' } })).map((row: any) => row.id)).toContain(project.id);
    expect(expectOk(await call(owner, 'PATCH', `projects/${project.id}/restore`)).isDeleted).toBe(false);
    expectError(await call(owner, 'PATCH', `projects/${project.id}/restore`), 409, 'PROJECT_NOT_DELETED');
    expectOk(await call(owner, 'DELETE', `projects/${project.id}`));
    // A plain member can still see the deleted project but lacks the dedicated purge permission.
    expectError(await call(colleague, 'DELETE', `projects/${project.id}/hard`), 403, 'PERMISSION_DENIED');
    expectError(await call(outsider, 'DELETE', `projects/${project.id}/hard`), 404, 'PROJECT_NOT_FOUND');
    expect(expectOk(await call(owner, 'DELETE', `projects/${project.id}/hard`))).toEqual({ id: project.id, deleted: true });
    const prisma = await db();
    expect(await prisma.project.findUnique({ where: { id: project.id } })).toBeNull();
    // Tasks survive (detached) and central audit keeps the evidence.
    expect(await prisma.task.findUnique({ where: { id: task.id } })).toMatchObject({ projectId: null, projectStageId: null });
    expect((await prisma.auditLog.findMany({ where: { entityId: project.id } })).map((row) => row.action)).toEqual(expect.arrayContaining(['PROJECT.CREATED', 'PROJECT.SOFT_DELETED', 'PROJECT.RESTORED', 'PROJECT.HARD_DELETED']));
  });

  it('tools: GET, PUT, enable/disable, linked-resources', async () => {
    const project = await newProject();
    const tools = expectOk(await call(owner, 'GET', `projects/${project.id}/tools`));
    expect(tools).toHaveLength(8);
    expect(tools.filter((row: any) => row.isEnabled).map((row: any) => row.toolType).sort()).toEqual(['KANBAN', 'TASKS']);
    // Tasks tool disabled -> tasks cannot be added.
    const disabled = expectOk(await call(owner, 'POST', `projects/${project.id}/tools/tasks/disable`));
    expect(disabled).toMatchObject({ toolType: 'TASKS', isEnabled: false });
    expectError(await call(owner, 'POST', 'tasks', { body: { title: 'x', projectId: project.id } }), 409, 'PROJECT_TOOL_DISABLED');
    expect(expectOk(await call(owner, 'POST', `projects/${project.id}/tools/TASKS/enable`)).isEnabled).toBe(true);
    // Enabling twice is a no-op (no second event).
    expectOk(await call(owner, 'POST', `projects/${project.id}/tools/TASKS/enable`));
    const prisma = await db();
    expect(await prisma.outboxEvent.count({ where: { entityId: project.id, eventType: 'PROJECT_TOOL_ENABLED' } })).toBe(1);
    // PUT must list every tool.
    expectError(await call(owner, 'PUT', `projects/${project.id}/tools`, { body: { tools: [{ toolType: 'TASKS', isEnabled: true }] } }), 400, 'VALIDATION_ERROR');
    const all = ['TASKS', 'KANBAN', 'CALENDAR', 'DRIVE', 'FEED', 'CHAT', 'REPORTS', 'KNOWLEDGE'];
    const replaced = expectOk(await call(owner, 'PUT', `projects/${project.id}/tools`, { body: { tools: all.map((toolType) => ({ toolType, isEnabled: ['TASKS', 'REPORTS'].includes(toolType), configurationJson: toolType === 'REPORTS' ? { period: 'WEEK' } : {} })) } }));
    expect(replaced.find((row: any) => row.toolType === 'REPORTS')).toMatchObject({ isEnabled: true, configurationJson: { period: 'WEEK' } });
    expect(replaced.find((row: any) => row.toolType === 'KANBAN').isEnabled).toBe(false);
    expectError(await call(colleague, 'POST', `projects/${project.id}/tools/FEED/enable`), 404, 'PROJECT_NOT_FOUND');
    const linked = expectOk(await call(owner, 'GET', `projects/${project.id}/linked-resources`));
    expect(Object.keys(linked).sort()).toEqual(['CALENDAR', 'CHAT', 'DRIVE']);
    expect(linked.CHAT).toMatchObject({ isEnabled: false, resourceId: null });
    expect((await prisma.auditLog.findMany({ where: { entityId: project.id, action: 'PROJECT.TOOL_CHANGED' } })).length).toBeGreaterThanOrEqual(3);
  });
});
