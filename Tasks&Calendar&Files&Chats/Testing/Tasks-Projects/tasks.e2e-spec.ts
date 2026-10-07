/**
 * TrueCRM API E2E contract for Tasks — Core Specification.
 * Wired to the real Next route handlers, the transactional request wrapper and PostgreSQL (see ../support/e2e.ts).
 */
import { ALL_TASK_PERMISSIONS, MISSING_ID, call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
import type { Session } from '../support/e2e';

jest.setTimeout(180_000);

let owner: Session;
let worker: Session;
let noPerm: Session;
let outsider: Session;

const isoIn = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

beforeAll(async () => {
  await prepareCollabDatabase();
  owner = await register('tasks-owner');
  worker = await member(owner, 'tasks-worker', ALL_TASK_PERMISSIONS);
  noPerm = await member(owner, 'tasks-noperm', [['crm.lead.read', 'OWN']]);
  outsider = await register('tasks-outsider');
});

afterAll(disconnect);

async function newTask(session: Session = owner, body: Record<string, unknown> = {}) {
  return expectOk(await call(session, 'POST', 'tasks', { body: { title: 'Prepare customer migration', priority: 'NORMAL', ...body } }));
}

describe('Tasks — Core Specification E2E contract', () => {
  it('exposes and enforces representative routes: POST   /api/v1/tasks; GET    /api/v1/tasks; GET    /api/v1/tasks/:id; PUT    /api/v1/tasks/:id', async () => {
    // POST /api/v1/tasks — creator from auth context, responsible validated, workspace from trusted context.
    // A client-supplied workspaceId is never trusted: it is rejected outright, and nothing is created anywhere.
    const prisma = await db();
    const forged = expectError(await call(owner, 'POST', 'tasks', { body: { title: 'Forged', workspaceId: outsider.workspaceId } }), 400, 'VALIDATION_ERROR');
    expect(forged.details).toEqual({ field: 'workspaceId' });
    expect(await prisma.task.count({ where: { title: 'Forged' } })).toBe(0);
    const created = await newTask(owner, { responsibleUserId: worker.userId, deadlineAt: isoIn(48) });
    expect(created).toMatchObject({ title: 'Prepare customer migration', status: 'PENDING', priority: 'NORMAL', createdByUserId: owner.userId, responsibleUserId: worker.userId, workspaceId: owner.workspaceId, version: 1 });

    // GET /api/v1/tasks/:id
    const fetched = expectOk(await call(owner, 'GET', `tasks/${created.id}`));
    expect(fetched.id).toBe(created.id);
    expect(fetched.myRoles).toContain('CREATOR');

    // GET /api/v1/tasks — page envelope, filters, role filter
    const list = await call(worker, 'GET', 'tasks', { query: { role: 'RESPONSIBLE', limit: '5' } });
    expectOk(list);
    expect(list.body.meta).toMatchObject({ page: 1, limit: 5 });
    expect(list.data.map((row: any) => row.id)).toContain(created.id);
    expectError(await call(owner, 'GET', 'tasks', { query: { sortBy: 'passwordHash' } }), 400, 'QUERY_FIELD_NOT_ALLOWED');
    expectError(await call(owner, 'GET', 'tasks', { query: { filters: JSON.stringify({ title: { op: 'eq', value: 'x' } }) } }), 400, 'QUERY_FIELD_NOT_ALLOWED');

    // PUT /api/v1/tasks/:id — full replace, version required, stale version conflicts.
    expectError(await call(owner, 'PUT', `tasks/${created.id}`, { body: { title: 'No version', priority: 'HIGH', responsibleUserId: worker.userId } }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'PUT', `tasks/${created.id}`, { body: { title: 'Missing fields', version: 1 } }), 400, 'VALIDATION_ERROR');
    const replaced = expectOk(await call(owner, 'PUT', `tasks/${created.id}`, { body: { title: 'Replaced', priority: 'HIGH', responsibleUserId: worker.userId, deadlineAt: isoIn(72), version: 1 } }));
    expect(replaced).toMatchObject({ title: 'Replaced', priority: 'HIGH', version: 2, description: null });
    expectError(await call(owner, 'PUT', `tasks/${created.id}`, { body: { title: 'Stale', priority: 'LOW', responsibleUserId: worker.userId, version: 1 } }), 409, 'RESOURCE_VERSION_CONFLICT');

    // PATCH /api/v1/tasks/:id — partial; If-Match header accepted; status is not patchable.
    const patched = expectOk(await call(owner, 'PATCH', `tasks/${created.id}`, { body: { description: 'Only this' }, headers: { 'if-match': '2' } }));
    expect(patched).toMatchObject({ title: 'Replaced', description: 'Only this', version: 3 });
    expectError(await call(owner, 'PATCH', `tasks/${created.id}`, { body: { status: 'COMPLETED', version: 3 } }), 400, 'TASK_INVALID_STATUS_TRANSITION');
    expectError(await call(owner, 'PATCH', `tasks/${created.id}`, { body: { progressPercent: 101, version: 3 } }), 400, 'VALIDATION_ERROR');

    const row = await prisma.task.findUnique({ where: { id: created.id } });
    expect(row).toMatchObject({ workspaceId: owner.workspaceId, title: 'Replaced', description: 'Only this', version: 3, createdByUserId: owner.userId });
    const history = await prisma.taskHistory.findMany({ where: { taskId: created.id } });
    expect(history.map((item) => item.action)).toEqual(expect.arrayContaining(['CREATED', 'UPDATED']));
    const deadlines = await prisma.taskDeadlineHistory.findMany({ where: { taskId: created.id } });
    expect(deadlines).toHaveLength(1);
  });

  it('requires authenticated/authorized workspace context for protected endpoints', async () => {
    const task = await newTask();
    // 1. no authentication
    expectError(await call(null, 'GET', `tasks/${task.id}`, { workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    expectError(await call(null, 'POST', 'tasks', { body: { title: 'x' }, workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    // 2. authenticated, missing permission
    expectError(await call(noPerm, 'POST', 'tasks', { body: { title: 'x' } }), 403, 'PERMISSION_DENIED');
    expectError(await call(noPerm, 'GET', `tasks/${task.id}`), 403, 'PERMISSION_DENIED');
    expectError(await call(noPerm, 'GET', 'tasks'), 403, 'PERMISSION_DENIED');
    // 3. a workspace the caller is not a member of
    expectError(await call(outsider, 'GET', `tasks/${task.id}`, { workspaceId: owner.workspaceId }), 403, 'PERMISSION_DENIED');
    // No workspace header at all
    expectError(await call(owner, 'GET', 'tasks', { workspaceId: '' }), 400, 'WORKSPACE_REQUIRED');
    // Worker with OWN scope cannot see a task they are not part of.
    expectError(await call(worker, 'GET', `tasks/${task.id}`), 404, 'TASK_NOT_FOUND');
  });

  it('rejects cross-workspace resource access without leaking resource existence', async () => {
    const task = await newTask();
    // Outsider uses its OWN workspace context with a valid foreign id: indistinguishable from a missing task.
    const foreign = expectError(await call(outsider, 'GET', `tasks/${task.id}`), 404, 'TASK_NOT_FOUND');
    const missing = expectError(await call(outsider, 'GET', `tasks/${MISSING_ID}`), 404, 'TASK_NOT_FOUND');
    expect(foreign.message).toBe(missing.message);
    for (const [method, path, body] of [
      ['PATCH', `tasks/${task.id}`, { title: 'hack', version: 1 }],
      ['POST', `tasks/${task.id}/start`, {}],
      ['DELETE', `tasks/${task.id}`, undefined],
      ['POST', `tasks/${task.id}/participants`, { userId: outsider.userId }],
      ['GET', `tasks/${task.id}/history`, undefined],
    ] as const) {
      expectError(await call(outsider, method, path, { body }), 404, 'TASK_NOT_FOUND');
    }
    // Cross-workspace relations: a foreign parent/responsible/project cannot be linked.
    expectError(await call(outsider, 'POST', 'tasks', { body: { title: 'child', parentTaskId: task.id } }), 404, 'TASK_NOT_FOUND');
    expectError(await call(outsider, 'POST', 'tasks', { body: { title: 'assign', responsibleUserId: owner.userId } }), 400, 'TASK_RESPONSIBLE_INVALID');
    const outsiderList = expectOk(await call(outsider, 'GET', 'tasks'));
    expect(outsiderList.map((row: any) => row.id)).not.toContain(task.id);
    const prisma = await db();
    expect((await prisma.task.findUnique({ where: { id: task.id } }))?.version).toBe(1);
  });

  it('returns stable machine-readable error envelopes for invalid requests', async () => {
    const missingTitle = await call(owner, 'POST', 'tasks', { body: { priority: 'NORMAL' } });
    expect(missingTitle.status).toBe(400);
    expect(missingTitle.body).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR', details: { field: 'title' } } });
    expect(typeof missingTitle.body.requestId).toBe('string');
    expectError(await call(owner, 'POST', 'tasks', { body: { title: 'x', priority: 'SUPER' } }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'POST', 'tasks', { body: { title: 'x', deadlineAt: '2026-13-45' } }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'POST', 'tasks', { body: { title: 'x', deadlineAt: '2026-10-10T10:00:00' } }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'POST', 'tasks', { body: { title: 'x', responsibleUserId: 'not-a-uuid' } }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'POST', 'tasks', { body: { title: 'x', unknownField: 1 } }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'POST', 'tasks', { body: { title: 'x', startAt: isoIn(10), deadlineAt: isoIn(1) } }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'GET', 'tasks/not-a-uuid'), 404, 'TASK_NOT_FOUND');
    expectError(await call(owner, 'GET', 'tasks/x/y/z/w'), 404, 'ROUTE_NOT_FOUND');
    expectError(await call(owner, 'POST', `tasks/${MISSING_ID}/start`), 404, 'TASK_NOT_FOUND');
  });

  it('persists critical state and outbox/audit consistently on successful mutation', async () => {
    const task = await newTask(owner, { responsibleUserId: worker.userId });
    const prisma = await db();
    const events = await prisma.outboxEvent.findMany({ where: { entityId: task.id }, orderBy: { occurredAt: 'asc' } });
    expect(events.map((row) => row.eventType)).toEqual(['TASK_CREATED', 'TASK_ASSIGNED']);
    expect(events.every((row) => row.workspaceId === owner.workspaceId)).toBe(true);
    const audits = await prisma.auditLog.findMany({ where: { entityId: task.id } });
    expect(audits.map((row) => row.action)).toContain('TASK.CREATED');

    // A failed mutation leaves neither state nor outbox behind (one transaction).
    const before = await prisma.outboxEvent.count({ where: { entityId: task.id } });
    expectError(await call(owner, 'PATCH', `tasks/${task.id}/responsible`, { body: { responsibleUserId: outsider.userId } }), 400, 'TASK_RESPONSIBLE_INVALID');
    expect(await prisma.outboxEvent.count({ where: { entityId: task.id } })).toBe(before);
    expect((await prisma.task.findUnique({ where: { id: task.id } }))?.responsibleUserId).toBe(worker.userId);

    // Idempotent creation for integration/automation retries.
    const key = `create-${Date.now()}`;
    const first = expectOk(await call(owner, 'POST', 'tasks', { body: { title: 'Idempotent' }, headers: { 'idempotency-key': key } }));
    const retry = expectOk(await call(owner, 'POST', 'tasks', { body: { title: 'Idempotent' }, headers: { 'idempotency-key': key } }));
    expect(retry.id).toBe(first.id);
    expect(await prisma.task.count({ where: { workspaceId: owner.workspaceId, title: 'Idempotent' } })).toBe(1);
    expectError(await call(owner, 'POST', 'tasks', { body: { title: 'Different' }, headers: { 'idempotency-key': key } }), 409, 'IDEMPOTENCY_KEY_REUSED');
  });
});

describe('Task lifecycle endpoints', () => {
  it('POST start/defer/cancel/complete/reopen follow the fixed lifecycle', async () => {
    const task = await newTask(owner, { responsibleUserId: worker.userId });
    expect(expectOk(await call(worker, 'POST', `tasks/${task.id}/start`)).status).toBe('IN_PROGRESS');
    expectError(await call(worker, 'POST', `tasks/${task.id}/start`), 409, 'TASK_INVALID_STATUS_TRANSITION');
    expect(expectOk(await call(worker, 'POST', `tasks/${task.id}/defer`)).status).toBe('DEFERRED');
    expect(expectOk(await call(worker, 'POST', `tasks/${task.id}/start`)).status).toBe('IN_PROGRESS');
    const completed = await call(worker, 'POST', `tasks/${task.id}/complete`);
    expect(expectOk(completed)).toMatchObject({ status: 'COMPLETED', progressPercent: 100, completedByUserId: worker.userId });
    expect(completed.body.meta).toEqual({ warnings: [] });
    expectError(await call(worker, 'POST', `tasks/${task.id}/defer`), 409, 'TASK_INVALID_STATUS_TRANSITION');
    const reopened = expectOk(await call(worker, 'POST', `tasks/${task.id}/reopen`));
    expect(reopened).toMatchObject({ status: 'PENDING', completedAt: null });
    // Only the creator (or a managing role) may cancel.
    expectError(await call(worker, 'POST', `tasks/${task.id}/cancel`), 403, 'PERMISSION_DENIED');
    expect(expectOk(await call(owner, 'POST', `tasks/${task.id}/cancel`)).status).toBe('CANCELLED');
    // Stale version on an action endpoint.
    expectError(await call(owner, 'POST', `tasks/${task.id}/reopen`, { body: { version: 1 } }), 409, 'RESOURCE_VERSION_CONFLICT');
    expectError(await call(noPerm, 'POST', `tasks/${task.id}/reopen`), 403, 'PERMISSION_DENIED');
    expectError(await call(null, 'POST', `tasks/${task.id}/reopen`, { workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    const prisma = await db();
    const events = (await prisma.outboxEvent.findMany({ where: { entityId: task.id } })).map((row) => row.eventType);
    expect(events).toEqual(expect.arrayContaining(['TASK_COMPLETED', 'TASK_REOPENED', 'TASK_CANCELLED']));
  });

  it('controlled completion: complete -> REVIEW -> return -> complete -> approve', async () => {
    const task = await newTask(owner, { responsibleUserId: worker.userId, completionControl: true });
    const submitted = expectOk(await call(worker, 'POST', `tasks/${task.id}/complete`, { body: { comment: 'done' } }));
    expect(submitted.status).toBe('REVIEW');
    expectError(await call(worker, 'POST', `tasks/${task.id}/complete`), 409, 'TASK_COMPLETION_REVIEW_REQUIRED');
    // The responsible worker is not the controller and cannot approve their own work.
    expectError(await call(worker, 'POST', `tasks/${task.id}/completion-review/approve`), 403, 'PERMISSION_DENIED');
    expect(expectOk(await call(owner, 'POST', `tasks/${task.id}/completion-review/return`, { body: { comment: 'Fix the totals' } })).status).toBe('IN_PROGRESS');
    expectError(await call(owner, 'POST', `tasks/${task.id}/completion-review/approve`), 409, 'TASK_INVALID_STATUS_TRANSITION');
    expectOk(await call(worker, 'POST', `tasks/${task.id}/complete`));
    const approved = expectOk(await call(owner, 'POST', `tasks/${task.id}/completion-review/approve`));
    expect(approved).toMatchObject({ status: 'COMPLETED', completedByUserId: worker.userId });
    const prisma = await db();
    const reviews = await prisma.taskCompletionReview.findMany({ where: { taskId: task.id }, orderBy: { submittedAt: 'asc' } });
    expect(reviews.map((row) => row.decision)).toEqual(['RETURNED', 'APPROVED']);
    expect((await prisma.auditLog.findMany({ where: { entityId: task.id, action: 'TASK.COMPLETION_REVIEWED' } }))).toHaveLength(2);
  });

  it('result-required completion and results endpoints', async () => {
    const task = await newTask(owner, { requiresResult: true });
    expectError(await call(owner, 'POST', `tasks/${task.id}/complete`), 409, 'TASK_RESULT_REQUIRED');
    expectError(await call(owner, 'POST', `tasks/${task.id}/results`, { body: { resultType: 'LINK', url: 'javascript:alert(1)' } }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'POST', `tasks/${task.id}/results`, { body: { resultType: 'TEXT' } }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'POST', `tasks/${task.id}/results`, { body: { resultType: 'FILE', fileId: MISSING_ID } }), 503, 'FILE_SERVICE_UNAVAILABLE');
    const result = expectOk(await call(owner, 'POST', `tasks/${task.id}/results`, { body: { resultType: 'TEXT', textValue: 'Migrated 120 accounts' } }));
    expect(result).toMatchObject({ resultType: 'TEXT', submittedByUserId: owner.userId });
    expect(expectOk(await call(owner, 'GET', `tasks/${task.id}/results`))).toHaveLength(1);
    expect(expectOk(await call(owner, 'POST', `tasks/${task.id}/complete`)).status).toBe('COMPLETED');
    expectError(await call(outsider, 'GET', `tasks/${task.id}/results`), 404, 'TASK_NOT_FOUND');
    expectError(await call(noPerm, 'POST', `tasks/${task.id}/results`, { body: { resultType: 'TEXT', textValue: 'x' } }), 403, 'PERMISSION_DENIED');
  });

  it('subtasks honour IGNORE / WARN / REQUIRE_ALL completion policy', async () => {
    const parent = await newTask(owner, { subtaskCompletionPolicy: 'REQUIRE_ALL' });
    const child = expectOk(await call(owner, 'POST', `tasks/${parent.id}/subtasks`, { body: { title: 'Child' } }));
    expect(child.parentTaskId).toBe(parent.id);
    expect(expectOk(await call(owner, 'GET', `tasks/${parent.id}/subtasks`)).map((row: any) => row.id)).toEqual([child.id]);
    const blocked = expectError(await call(owner, 'POST', `tasks/${parent.id}/complete`), 409, 'TASK_SUBTASKS_INCOMPLETE');
    expect(blocked.details.subtaskIds).toEqual([child.id]);
    expectOk(await call(owner, 'PATCH', `tasks/${parent.id}`, { body: { subtaskCompletionPolicy: 'WARN', version: 1 } }));
    const warned = await call(owner, 'POST', `tasks/${parent.id}/complete`);
    expect(expectOk(warned).status).toBe('COMPLETED');
    expect(warned.body.meta.warnings[0]).toMatchObject({ code: 'TASK_SUBTASKS_INCOMPLETE', subtaskIds: [child.id] });
    const ignoring = await newTask(owner, { subtaskCompletionPolicy: 'IGNORE' });
    expectOk(await call(owner, 'POST', `tasks/${ignoring.id}/subtasks`, { body: { title: 'Child 2' } }));
    const ignored = await call(owner, 'POST', `tasks/${ignoring.id}/complete`);
    expect(ignored.body.meta.warnings).toEqual([]);
    // A task cannot become its own ancestor.
    expectError(await call(owner, 'PATCH', `tasks/${parent.id}`, { body: { parentTaskId: child.id, version: 3 } }), 400, 'TASK_PARENT_INVALID');
    expectError(await call(outsider, 'POST', `tasks/${parent.id}/subtasks`, { body: { title: 'x' } }), 404, 'TASK_NOT_FOUND');
  });
});

describe('Task membership, responsible and deadline endpoints', () => {
  it('participants/observers/members with distinct semantics', async () => {
    const task = await newTask();
    const observer = await member(owner, 'tasks-observer', [['task.read', 'OWN']]);
    expectError(await call(owner, 'POST', `tasks/${task.id}/participants`, { body: { userId: outsider.userId } }), 400, 'TASK_MEMBER_INVALID');
    expectOk(await call(owner, 'POST', `tasks/${task.id}/participants`, { body: { userId: worker.userId } }));
    expectOk(await call(owner, 'POST', `tasks/${task.id}/observers`, { body: { userId: observer.userId } }));
    const members = expectOk(await call(owner, 'GET', `tasks/${task.id}/members`));
    expect(members.creator.id).toBe(owner.userId);
    expect(members.responsible.id).toBe(owner.userId);
    expect(members.participants.map((row: any) => row.id)).toEqual([worker.userId]);
    expect(members.observers.map((row: any) => row.id)).toEqual([observer.userId]);
    // Participants can work on the Task; observers can only read it.
    expect(expectOk(await call(worker, 'POST', `tasks/${task.id}/start`)).status).toBe('IN_PROGRESS');
    expect(expectOk(await call(observer, 'GET', `tasks/${task.id}`)).myRoles).toEqual(['OBSERVER']);
    expectError(await call(observer, 'POST', `tasks/${task.id}/defer`), 403, 'PERMISSION_DENIED');
    expectError(await call(noPerm, 'POST', `tasks/${task.id}/observers`, { body: { userId: worker.userId } }), 403, 'PERMISSION_DENIED');
    // Removing the only access source removes access.
    expectOk(await call(owner, 'DELETE', `tasks/${task.id}/observers/${observer.userId}`));
    expectError(await call(observer, 'GET', `tasks/${task.id}`), 404, 'TASK_NOT_FOUND');
    expectError(await call(owner, 'DELETE', `tasks/${task.id}/observers/${observer.userId}`), 404, 'TASK_MEMBER_NOT_FOUND');
    expectOk(await call(owner, 'DELETE', `tasks/${task.id}/participants/${worker.userId}`));
    expectError(await call(worker, 'GET', `tasks/${task.id}`), 404, 'TASK_NOT_FOUND');
  });

  it('PATCH responsible validates the user and emits TASK_ASSIGNED + audit', async () => {
    const task = await newTask();
    expectError(await call(owner, 'PATCH', `tasks/${task.id}/responsible`, { body: { responsibleUserId: MISSING_ID } }), 400, 'TASK_RESPONSIBLE_INVALID');
    expectError(await call(owner, 'PATCH', `tasks/${task.id}/responsible`, { body: {} }), 400, 'VALIDATION_ERROR');
    const changed = expectOk(await call(owner, 'PATCH', `tasks/${task.id}/responsible`, { body: { responsibleUserId: worker.userId, version: 1 } }));
    expect(changed).toMatchObject({ responsibleUserId: worker.userId, version: 2 });
    expect(expectOk(await call(worker, 'GET', `tasks/${task.id}`)).myRoles).toContain('RESPONSIBLE');
    // The responsible worker holding task.change_responsible may delegate; a caller without the permission may not.
    expectError(await call(noPerm, 'PATCH', `tasks/${task.id}/responsible`, { body: { responsibleUserId: owner.userId } }), 403, 'PERMISSION_DENIED');
    const readOnly = await member(owner, 'tasks-readonly', [['task.read', 'WORKSPACE']]);
    expectError(await call(readOnly, 'PATCH', `tasks/${task.id}/responsible`, { body: { responsibleUserId: owner.userId } }), 403, 'PERMISSION_DENIED');
    const prisma = await db();
    expect(await prisma.auditLog.count({ where: { entityId: task.id, action: 'TASK.REASSIGNED' } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { entityId: task.id, eventType: 'TASK_ASSIGNED' } })).toBe(1);
  });

  it('PATCH deadline records deadline history and GET history endpoints expose it', async () => {
    const task = await newTask();
    const deadline = isoIn(24);
    const changed = expectOk(await call(owner, 'PATCH', `tasks/${task.id}/deadline`, { body: { deadlineAt: deadline, reason: 'Customer asked' } }));
    expect(new Date(changed.deadlineAt).toISOString()).toBe(deadline);
    expectOk(await call(owner, 'PATCH', `tasks/${task.id}/deadline`, { body: { deadlineAt: null } }));
    expectError(await call(owner, 'PATCH', `tasks/${task.id}/deadline`, { body: { deadlineAt: 'tomorrow' } }), 400, 'VALIDATION_ERROR');
    expectError(await call(worker, 'PATCH', `tasks/${task.id}/deadline`, { body: { deadlineAt: deadline } }), 404, 'TASK_NOT_FOUND');
    const history = expectOk(await call(owner, 'GET', `tasks/${task.id}/deadline-history`));
    expect(history.map((row: any) => row.reason)).toEqual(['Customer asked', null]);
    const full = await call(owner, 'GET', `tasks/${task.id}/history`);
    expect(expectOk(full).some((row: any) => row.field === 'deadlineAt')).toBe(true);
    expect(full.body.meta.total).toBeGreaterThanOrEqual(3);
    expectError(await call(noPerm, 'GET', `tasks/${task.id}/history`), 403, 'PERMISSION_DENIED');
    const prisma = await db();
    expect(await prisma.outboxEvent.count({ where: { entityId: task.id, eventType: 'TASK_DEADLINE_CHANGED' } })).toBe(2);
  });
});

describe('Task deletion and bindings endpoints', () => {
  it('DELETE soft-deletes, PATCH restore restores, DELETE hard requires prior soft delete and dedicated permission', async () => {
    const task = await newTask(worker);
    expectError(await call(worker, 'DELETE', `tasks/${task.id}/hard`), 403, 'PERMISSION_DENIED');
    expectError(await call(owner, 'DELETE', `tasks/${task.id}/hard`), 409, 'TASK_NOT_DELETED');
    expectError(await call(owner, 'PATCH', `tasks/${task.id}/restore`), 409, 'TASK_NOT_DELETED');
    expectOk(await call(worker, 'DELETE', `tasks/${task.id}`));
    expectError(await call(worker, 'GET', `tasks/${task.id}`), 404, 'TASK_NOT_FOUND');
    expect(expectOk(await call(worker, 'GET', 'tasks', { query: { deleted: 'true' } })).map((row: any) => row.id)).toContain(task.id);
    expect(expectOk(await call(worker, 'PATCH', `tasks/${task.id}/restore`)).isDeleted).toBe(false);
    expectOk(await call(worker, 'DELETE', `tasks/${task.id}`));
    expectError(await call(outsider, 'DELETE', `tasks/${task.id}/hard`), 404, 'TASK_NOT_FOUND');
    expect(expectOk(await call(owner, 'DELETE', `tasks/${task.id}/hard`))).toEqual({ id: task.id, deleted: true });
    const prisma = await db();
    expect(await prisma.task.findUnique({ where: { id: task.id } })).toBeNull();
    // Central audit survives the purge.
    expect((await prisma.auditLog.findMany({ where: { entityId: task.id } })).map((row) => row.action)).toEqual(expect.arrayContaining(['TASK.CREATED', 'TASK.SOFT_DELETED', 'TASK.RESTORED', 'TASK.HARD_DELETED']));
  });

  it('bindings link Tasks to accessible CRM records only', async () => {
    const task = await newTask();
    const { api } = await import('@/tests/support/api');
    const company = await api('POST', '/api/v1/crm/companies', { token: owner.token, workspaceId: owner.workspaceId, body: { name: 'Bound Co' } });
    expect(company.status).toBe(200);
    const binding = expectOk(await call(owner, 'POST', `tasks/${task.id}/bindings`, { body: { entityType: 'COMPANY', entityId: company.data.id } }));
    expect(binding).toMatchObject({ entityType: 'COMPANY', entityId: company.data.id, taskId: task.id });
    const again = expectOk(await call(owner, 'POST', `tasks/${task.id}/bindings`, { body: { entityType: 'company', entityId: company.data.id } }));
    expect(again.id).toBe(binding.id);
    expect(expectOk(await call(owner, 'GET', `tasks/${task.id}/bindings`))).toHaveLength(1);
    expectError(await call(owner, 'POST', `tasks/${task.id}/bindings`, { body: { entityType: 'COMPANY', entityId: MISSING_ID } }), 404, 'BINDING_TARGET_NOT_FOUND');
    expectError(await call(owner, 'POST', `tasks/${task.id}/bindings`, { body: { entityType: 'SPACESHIP', entityId: MISSING_ID } }), 400, 'BINDING_TYPE_UNSUPPORTED');
    // A CRM record of another workspace is not bindable even with a valid id.
    const foreignTask = await newTask(outsider);
    expectError(await call(outsider, 'POST', `tasks/${foreignTask.id}/bindings`, { body: { entityType: 'COMPANY', entityId: company.data.id } }), 404, 'BINDING_TARGET_NOT_FOUND');
    expectOk(await call(owner, 'DELETE', `tasks/${task.id}/bindings/${binding.id}`));
    expectError(await call(owner, 'DELETE', `tasks/${task.id}/bindings/${binding.id}`), 404, 'TASK_BINDING_NOT_FOUND');
    expectError(await call(noPerm, 'GET', `tasks/${task.id}/bindings`), 403, 'PERMISSION_DENIED');
  });
});
