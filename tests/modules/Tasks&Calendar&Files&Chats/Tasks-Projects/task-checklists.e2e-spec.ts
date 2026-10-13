/**
 * TrueCRM API E2E contract for Task Checklists Specification.
 * Wired to the real Next route handlers, the transactional request wrapper and PostgreSQL (see ../support/e2e.ts).
 */
import { ALL_TASK_PERMISSIONS, MISSING_ID, call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
import type { Session } from '../support/e2e';

jest.setTimeout(180_000);

let owner: Session;
let worker: Session;
let noPerm: Session;
let outsider: Session;

beforeAll(async () => {
  await prepareCollabDatabase();
  owner = await register('checklist-owner');
  worker = await member(owner, 'checklist-worker', ALL_TASK_PERMISSIONS);
  noPerm = await member(owner, 'checklist-noperm', [['task.read', 'WORKSPACE']]);
  outsider = await register('checklist-outsider');
});

afterAll(disconnect);

async function taskWithChecklist() {
  const task = expectOk(await call(owner, 'POST', 'tasks', { body: { title: 'Checklist host', responsibleUserId: worker.userId } }));
  const checklist = expectOk(await call(owner, 'POST', `tasks/${task.id}/checklists`, { body: { name: 'Steps', items: [{ title: 'First' }, { title: 'Second', assignedUserId: worker.userId }] } }));
  return { task, checklist };
}

describe('Task Checklists Specification E2E contract', () => {
  it('exposes and enforces representative routes: GET    /api/v1/tasks/:taskId/checklists; POST   /api/v1/tasks/:taskId/checklists; GET    /api/v1/task-checklists/:id; PATCH  /api/v1/task-checklists/:id', async () => {
    const { task, checklist } = await taskWithChecklist();
    expect(checklist).toMatchObject({ name: 'Steps', taskId: task.id, totalCount: 2, completedCount: 0 });
    expect(checklist.items.map((row: any) => row.title)).toEqual(['First', 'Second']);
    expect(expectOk(await call(worker, 'GET', `tasks/${task.id}/checklists`)).map((row: any) => row.id)).toEqual([checklist.id]);
    expect(expectOk(await call(worker, 'GET', `task-checklists/${checklist.id}`)).items).toHaveLength(2);
    const renamed = expectOk(await call(worker, 'PATCH', `task-checklists/${checklist.id}`, { body: { name: 'Renamed', version: checklist.version } }));
    expect(renamed).toMatchObject({ name: 'Renamed', version: checklist.version + 1 });
    expectError(await call(worker, 'PATCH', `task-checklists/${checklist.id}`, { body: { name: 'Stale', version: checklist.version } }), 409, 'RESOURCE_VERSION_CONFLICT');
    expectError(await call(worker, 'PATCH', `task-checklists/${checklist.id}`, { body: { name: 'No version' } }), 400, 'VALIDATION_ERROR');
    expectOk(await call(worker, 'DELETE', `task-checklists/${checklist.id}`));
    expectError(await call(worker, 'GET', `task-checklists/${checklist.id}`), 404, 'CHECKLIST_NOT_FOUND');
    const prisma = await db();
    expect(await prisma.taskChecklistItem.count({ where: { checklistId: checklist.id } })).toBe(0);
  });

  it('requires authenticated/authorized workspace context for protected endpoints', async () => {
    const { task, checklist } = await taskWithChecklist();
    const item = checklist.items[0];
    expectError(await call(null, 'GET', `task-checklists/${checklist.id}`, { workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    expectError(await call(null, 'POST', `task-checklist-items/${item.id}/complete`, { workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    // noPerm can read the Task (workspace scope) but cannot manage or complete checklist items.
    expect(expectOk(await call(noPerm, 'GET', `tasks/${task.id}/checklists`))).toHaveLength(1);
    expectError(await call(noPerm, 'POST', `tasks/${task.id}/checklists`, { body: { name: 'x' } }), 403, 'PERMISSION_DENIED');
    expectError(await call(noPerm, 'POST', `task-checklists/${checklist.id}/items`, { body: { title: 'x' } }), 403, 'PERMISSION_DENIED');
    expectError(await call(noPerm, 'POST', `task-checklist-items/${item.id}/complete`), 403, 'PERMISSION_DENIED');
    expectError(await call(outsider, 'GET', `task-checklists/${checklist.id}`, { workspaceId: owner.workspaceId }), 403, 'PERMISSION_DENIED');
  });

  it('rejects cross-workspace resource access without leaking resource existence', async () => {
    const { task, checklist } = await taskWithChecklist();
    const item = checklist.items[0];
    expectError(await call(outsider, 'GET', `tasks/${task.id}/checklists`), 404, 'TASK_NOT_FOUND');
    const foreign = expectError(await call(outsider, 'GET', `task-checklists/${checklist.id}`), 404, 'CHECKLIST_NOT_FOUND');
    expect(foreign.message).toBe(expectError(await call(outsider, 'GET', `task-checklists/${MISSING_ID}`), 404, 'CHECKLIST_NOT_FOUND').message);
    expectError(await call(outsider, 'PATCH', `task-checklist-items/${item.id}`, { body: { title: 'x', version: 1 } }), 404, 'CHECKLIST_ITEM_NOT_FOUND');
    expectError(await call(outsider, 'PATCH', `task-checklist-items/${item.id}/move`, { body: { sortOrder: 1 } }), 404, 'CHECKLIST_ITEM_NOT_FOUND');
    expectError(await call(outsider, 'POST', `task-checklist-items/${item.id}/reopen`), 404, 'CHECKLIST_ITEM_NOT_FOUND');
    expectError(await call(outsider, 'DELETE', `task-checklist-items/${item.id}`), 404, 'CHECKLIST_ITEM_NOT_FOUND');
    // Assigning an item to a user of another workspace is impossible.
    expectError(await call(owner, 'POST', `task-checklists/${checklist.id}/items`, { body: { title: 'x', assignedUserId: outsider.userId } }), 400, 'CHECKLIST_ASSIGNEE_INVALID');
  });

  it('returns stable machine-readable error envelopes for invalid requests', async () => {
    const { task, checklist } = await taskWithChecklist();
    const prisma = await db();
    const before = { checklists: await prisma.taskChecklist.count({ where: { taskId: task.id } }), history: await prisma.taskHistory.count({ where: { taskId: task.id } }), events: await prisma.outboxEvent.count({ where: { entityId: task.id } }) };
    for (const invalid of [null, [], { title: 'x'.repeat(1001) }, { title: 'x', assignedUserId: 123 }, { title: 'x', isCompleted: true }]) {
      expectError(await call(owner, 'POST', `tasks/${task.id}/checklists`, { body: { name: 'Invalid', items: [{ title: 'Valid' }, invalid] } }), 400, 'VALIDATION_ERROR');
    }
    expect({ checklists: await prisma.taskChecklist.count({ where: { taskId: task.id } }), history: await prisma.taskHistory.count({ where: { taskId: task.id } }), events: await prisma.outboxEvent.count({ where: { entityId: task.id } }) }).toEqual(before);
    const [first, second] = checklist.items;
    expectError(await call(owner, 'POST', `task-checklist-items/${first.id}/complete`, { body: { isCompleted: true } }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'POST', `task-checklists/${checklist.id}/items`, { body: {} }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'POST', `task-checklists/${checklist.id}/items`, { body: { title: 'x', parentItemId: MISSING_ID } }), 404, 'CHECKLIST_ITEM_NOT_FOUND');
    const child = expectOk(await call(owner, 'POST', `task-checklists/${checklist.id}/items`, { body: { title: 'Child', parentItemId: first.id } }));
    expectError(await call(owner, 'PATCH', `task-checklist-items/${first.id}/move`, { body: { parentItemId: child.id, sortOrder: 1 } }), 409, 'CHECKLIST_HIERARCHY_CYCLE');
    expectError(await call(owner, 'PATCH', `task-checklist-items/${first.id}/move`, { body: { parentItemId: second.id } }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'DELETE', `task-checklist-items/${first.id}`), 409, 'CHECKLIST_HAS_CHILDREN');
    expectError(await call(owner, 'PATCH', `task-checklist-items/${second.id}`, { body: { title: '', version: second.version } }), 400, 'VALIDATION_ERROR');
  });

  it('persists critical state and outbox/audit consistently on successful mutation', async () => {
    const { task, checklist } = await taskWithChecklist();
    const [first, second] = checklist.items;
    // The worker (assignee + responsible) completes; actor and time are recorded.
    const done = expectOk(await call(worker, 'POST', `task-checklist-items/${second.id}/complete`));
    expect(done).toMatchObject({ isCompleted: true, completedByUserId: worker.userId });
    expect(expectOk(await call(worker, 'POST', `task-checklist-items/${second.id}/complete`)).version).toBe(done.version);
    const updated = expectOk(await call(owner, 'PATCH', `task-checklist-items/${first.id}`, { body: { title: 'First (edited)', assignedUserId: worker.userId, version: first.version } }));
    expect(updated).toMatchObject({ title: 'First (edited)', assignedUserId: worker.userId });
    const moved = expectOk(await call(owner, 'PATCH', `task-checklist-items/${first.id}/move`, { body: { parentItemId: second.id, sortOrder: 1 } }));
    expect(moved.parentItemId).toBe(second.id);
    expectOk(await call(worker, 'POST', `task-checklist-items/${second.id}/reopen`));
    expectError(await call(owner, 'DELETE', `task-checklist-items/${second.id}`), 409, 'CHECKLIST_HAS_CHILDREN');
    expect(expectOk(await call(owner, 'DELETE', `task-checklist-items/${second.id}`, { query: { cascade: 'true' } }))).toMatchObject({ removedCount: 2 });
    const prisma = await db();
    expect(await prisma.taskChecklistItem.count({ where: { checklistId: checklist.id } })).toBe(0);
    expect((await prisma.task.findUnique({ where: { id: task.id } }))?.status).toBe('PENDING');
    const events = (await prisma.outboxEvent.findMany({ where: { entityId: task.id } })).map((row) => row.eventType);
    expect(events).toEqual(expect.arrayContaining(['TASK_CHECKLIST_CHANGED', 'TASK_CHECKLIST_ITEM_COMPLETED']));
    expect((await prisma.taskHistory.findMany({ where: { taskId: task.id } })).map((row) => row.action)).toEqual(expect.arrayContaining(['CHECKLIST_CHANGED', 'CHECKLIST_ITEM_COMPLETED', 'CHECKLIST_ITEM_REOPENED']));
  });
});
