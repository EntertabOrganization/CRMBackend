/**
 * TrueCRM API E2E contract for Task Dependencies Specification.
 * Wired to the real Next route handlers, the transactional request wrapper and PostgreSQL (see ../support/e2e.ts).
 */
import { randomUUID } from 'node:crypto';
import { ALL_TASK_PERMISSIONS, MISSING_ID, call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
import type { Session } from '../support/e2e';

jest.setTimeout(180_000);

let owner: Session;
let worker: Session;
let noPerm: Session;
let outsider: Session;

beforeAll(async () => {
  await prepareCollabDatabase();
  owner = await register('deps-owner');
  worker = await member(owner, 'deps-worker', ALL_TASK_PERMISSIONS);
  noPerm = await member(owner, 'deps-noperm', [['task.read', 'WORKSPACE']]);
  outsider = await register('deps-outsider');
});

afterAll(disconnect);

async function tasks(count: number, session: Session = owner) {
  const result = [];
  for (let index = 0; index < count; index += 1) result.push(expectOk(await call(session, 'POST', 'tasks', { body: { title: `Step ${index}`, responsibleUserId: session === owner ? worker.userId : undefined } })));
  return result;
}

describe('Task Dependencies Specification E2E contract', () => {
  it('exposes and enforces representative routes: GET    /api/v1/tasks/:taskId/dependencies; POST   /api/v1/tasks/:taskId/dependencies; DELETE /api/v1/tasks/:taskId/dependencies/:dependencyId; GET    /api/v1/tasks/:taskId/dependency-graph', async () => {
    const [a, bTask, c] = await tasks(3);
    const edge = expectOk(await call(worker, 'POST', `tasks/${bTask.id}/dependencies`, { body: { predecessorTaskId: a.id } }));
    expect(edge).toMatchObject({ predecessorTaskId: a.id, successorTaskId: bTask.id, type: 'FINISH_START', lagSeconds: 0, createdByUserId: worker.userId });
    expectOk(await call(worker, 'POST', `tasks/${bTask.id}/dependencies`, { body: { successorTaskId: c.id, type: 'START_FINISH', lagSeconds: 600 } }));
    const listed = expectOk(await call(worker, 'GET', `tasks/${bTask.id}/dependencies`));
    expect(listed.predecessors.map((row: any) => row.predecessorTaskId)).toEqual([a.id]);
    expect(listed.successors.map((row: any) => [row.successorTaskId, row.type, row.lagSeconds])).toEqual([[c.id, 'START_FINISH', 600]]);
    const graph = expectOk(await call(worker, 'GET', `tasks/${a.id}/dependency-graph`));
    expect(graph.nodes.map((node: any) => node.id).sort()).toEqual([a.id, bTask.id, c.id].sort());
    expect(graph.edges).toHaveLength(2);
    expect(expectOk(await call(worker, 'DELETE', `tasks/${a.id}/dependencies/${edge.id}`))).toEqual({ id: edge.id, deleted: true });
    expectError(await call(worker, 'DELETE', `tasks/${a.id}/dependencies/${edge.id}`), 404, 'TASK_DEPENDENCY_NOT_FOUND');
  });

  it('requires authenticated/authorized workspace context for protected endpoints', async () => {
    const [a, bTask] = await tasks(2);
    expectError(await call(null, 'GET', `tasks/${a.id}/dependencies`, { workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    expectError(await call(null, 'POST', `tasks/${a.id}/dependencies`, { workspaceId: owner.workspaceId, body: { successorTaskId: bTask.id } }), 401, 'UNAUTHENTICATED');
    // Visible via workspace-wide read, but no dependency_manage permission.
    expect(expectOk(await call(noPerm, 'GET', `tasks/${a.id}/dependencies`))).toEqual({ predecessors: [], successors: [] });
    expectError(await call(noPerm, 'POST', `tasks/${a.id}/dependencies`, { body: { successorTaskId: bTask.id } }), 403, 'PERMISSION_DENIED');
    expectError(await call(outsider, 'GET', `tasks/${a.id}/dependency-graph`, { workspaceId: owner.workspaceId }), 403, 'PERMISSION_DENIED');
  });

  it('rejects cross-workspace resource access without leaking resource existence', async () => {
    const [mine] = await tasks(1);
    const [theirs] = await tasks(1, outsider);
    expectError(await call(outsider, 'GET', `tasks/${mine.id}/dependencies`), 404, 'TASK_NOT_FOUND');
    expectError(await call(outsider, 'GET', `tasks/${mine.id}/dependency-graph`), 404, 'TASK_NOT_FOUND');
    expectError(await call(outsider, 'POST', `tasks/${theirs.id}/dependencies`, { body: { predecessorTaskId: mine.id } }), 404, 'TASK_NOT_FOUND');
    expectError(await call(owner, 'POST', `tasks/${mine.id}/dependencies`, { body: { successorTaskId: theirs.id } }), 404, 'TASK_NOT_FOUND');
    const prisma = await db();
    expect(await prisma.taskDependency.count({ where: { OR: [{ predecessorTaskId: mine.id }, { successorTaskId: mine.id }] } })).toBe(0);
  });

  it('returns stable machine-readable error envelopes for invalid requests', async () => {
    const [a, bTask, c] = await tasks(3);
    expectError(await call(worker, 'POST', `tasks/${a.id}/dependencies`, { body: {} }), 400, 'VALIDATION_ERROR');
    expectError(await call(worker, 'POST', `tasks/${a.id}/dependencies`, { body: { predecessorTaskId: bTask.id, successorTaskId: c.id } }), 400, 'VALIDATION_ERROR');
    expectError(await call(worker, 'POST', `tasks/${a.id}/dependencies`, { body: { predecessorTaskId: a.id } }), 400, 'TASK_DEPENDENCY_SELF');
    expectError(await call(worker, 'POST', `tasks/${a.id}/dependencies`, { body: { predecessorTaskId: bTask.id, lagSeconds: -1 } }), 400, 'TASK_DEPENDENCY_INVALID_LAG');
    expectError(await call(worker, 'POST', `tasks/${a.id}/dependencies`, { body: { predecessorTaskId: bTask.id, type: 'SOMETIMES' } }), 400, 'VALIDATION_ERROR');
    expectError(await call(worker, 'POST', `tasks/${a.id}/dependencies`, { body: { predecessorTaskId: MISSING_ID } }), 404, 'TASK_NOT_FOUND');
    expectOk(await call(worker, 'POST', `tasks/${bTask.id}/dependencies`, { body: { predecessorTaskId: a.id } }));
    expectOk(await call(worker, 'POST', `tasks/${c.id}/dependencies`, { body: { predecessorTaskId: bTask.id } }));
    expectError(await call(worker, 'POST', `tasks/${bTask.id}/dependencies`, { body: { predecessorTaskId: a.id } }), 409, 'TASK_DEPENDENCY_DUPLICATE');
    expectError(await call(worker, 'POST', `tasks/${a.id}/dependencies`, { body: { predecessorTaskId: c.id } }), 409, 'TASK_DEPENDENCY_CYCLE');
  });

  it('persists critical state and outbox/audit consistently on successful mutation', async () => {
    const [a, bTask] = await tasks(2);
    const edge = expectOk(await call(worker, 'POST', `tasks/${bTask.id}/dependencies`, { body: { predecessorTaskId: a.id, lagSeconds: 120 } }));
    const prisma = await db();
    expect(await prisma.taskDependency.findUnique({ where: { id: edge.id } })).toMatchObject({ workspaceId: owner.workspaceId, lagSeconds: 120 });
    expect(await prisma.outboxEvent.count({ where: { entityId: bTask.id, eventType: 'TASK_DEPENDENCY_ADDED' } })).toBe(1);
    expect(await prisma.taskHistory.count({ where: { taskId: { in: [a.id, bTask.id] }, action: 'DEPENDENCY_ADDED' } })).toBe(2);
    // Deleting a Task removes its edges: no dangling dependency survives.
    expectOk(await call(owner, 'DELETE', `tasks/${a.id}`));
    expect(await prisma.taskDependency.count({ where: { id: edge.id } })).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { entityId: bTask.id, eventType: 'TASK_DEPENDENCY_REMOVED' } })).toBe(1);
  });
});

describe('Database guarantees across application instances', () => {
  it('concurrent opposite edges: exactly one commits, the other is rejected as a cycle', async () => {
    const [a, bTask] = await tasks(2);
    const prisma = await db();
    const insert = (predecessorTaskId: string, successorTaskId: string) => prisma.$transaction(async (tx) => {
      await tx.taskDependency.create({ data: { id: randomUUID(), workspaceId: owner.workspaceId, predecessorTaskId, successorTaskId, type: 'FINISH_START', lagSeconds: 0, createdByUserId: owner.userId, createdAt: new Date() } });
      // Hold the transaction open briefly so the two writers genuinely overlap.
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    const results = await Promise.allSettled([insert(a.id, bTask.id), insert(bTask.id, a.id)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(String((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason)).toContain('TASK_DEPENDENCY_CYCLE');
    expect(await prisma.taskDependency.count({ where: { OR: [{ predecessorTaskId: a.id }, { predecessorTaskId: bTask.id }] } })).toBe(1);
  });

  it('a stale writer from another instance cannot overwrite a newer Task version', async () => {
    const [task] = await tasks(1);
    expectOk(await call(owner, 'PATCH', `tasks/${task.id}`, { body: { title: 'Newer', version: 1 } }));
    const prisma = await db();
    // Another instance that still holds version 1 tries to save its version-2 copy: rejected by the version guard.
    await expect(prisma.task.update({ where: { id: task.id }, data: { title: 'Stale overwrite', version: 2 } })).rejects.toThrow(/RESOURCE_VERSION_CONFLICT/);
    expect((await prisma.task.findUnique({ where: { id: task.id } }))?.title).toBe('Newer');
  });

  it('a duplicate (rule, scheduledFor) recurrence instance cannot be stored twice', async () => {
    const prisma = await db();
    const template = expectOk(await call(owner, 'POST', 'task-templates', { body: { name: 'Uniq', titleTemplate: 'Uniq' } }));
    expectOk(await call(owner, 'PUT', `task-templates/${template.id}/recurrence`, { body: { frequency: 'DAILY', startDate: '2026-01-01', creationLocalTime: '09:00', timezone: 'UTC' } }));
    const rule = await prisma.taskRecurrenceRule.findFirstOrThrow({ where: { templateId: template.id } });
    const row = () => ({ id: randomUUID(), workspaceId: owner.workspaceId, recurrenceRuleId: rule.id, templateId: template.id, scheduledFor: new Date('2030-01-01T09:00:00Z'), status: 'FAILED', attempts: 1, createdAt: new Date(), updatedAt: new Date() });
    await prisma.taskRecurrenceInstance.create({ data: row() });
    await expect(prisma.taskRecurrenceInstance.create({ data: row() })).rejects.toMatchObject({ code: 'P2002' });
  });
});
