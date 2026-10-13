/**
 * TrueCRM executable contract test for Tasks — Core Specification.
 * Service-level (in-memory store, all modules wired) — the HTTP/Postgres path is covered by tasks.e2e-spec.ts.
 */
import { Body } from '@/src/server/collab/support';
import { addMember, expectAppError, fullApp, otherTenant } from '@/tests/support/domain';
import type { PermissionScope } from '@/src/server/domain';

const b = (raw: Record<string, unknown> = {}) => new Body(raw);
const WORKER: Array<[string, PermissionScope]> = ['task.create', 'task.read', 'task.update', 'task.complete', 'task.reopen', 'task.result_submit', 'task.delete'].map((key) => [key, 'OWN']);

async function setup() {
  const base = await fullApp();
  const actor = base.app.access.actor(base.user, base.workspace.id);
  const worker = await addMember(base.app, base.user, base.workspace.id, 'worker', WORKER);
  const workerActor = base.app.access.actor(worker.user, base.workspace.id);
  const svc = base.app.collab.tasks.tasks;
  return { ...base, actor, worker: worker.user, workerActor, svc };
}

describe('Tasks — Core Specification contract', () => {
  it('Valid lifecycle including controlled completion.', async () => {
    const { svc, actor, worker, workerActor } = await setup();
    const task = svc.create(actor, { title: 'Controlled', responsibleUserId: worker.id, completionControl: true });
    expect(svc.start(workerActor, task.id, b()).status).toBe('IN_PROGRESS');
    const submitted = svc.complete(workerActor, task.id, b());
    expect(submitted.data.status).toBe('REVIEW');
    expect(svc.review(actor, task.id, b({ comment: 'again' }), 'RETURNED').status).toBe('IN_PROGRESS');
    svc.complete(workerActor, task.id, b());
    const approved = svc.review(actor, task.id, b(), 'APPROVED');
    expect(approved).toMatchObject({ status: 'COMPLETED', completedByUserId: worker.id, progressPercent: 100 });
    const plain = svc.create(actor, { title: 'Direct' });
    expect(svc.complete(actor, plain.id, b()).data.status).toBe('COMPLETED');
  });

  it('Invalid transitions rejected.', async () => {
    const { svc, actor } = await setup();
    const task = svc.create(actor, { title: 'T' });
    await expectAppError(() => svc.reopen(actor, task.id, b()), 'TASK_INVALID_STATUS_TRANSITION', 409);
    await expectAppError(() => svc.review(actor, task.id, b(), 'APPROVED'), 'TASK_INVALID_STATUS_TRANSITION', 409);
    svc.cancel(actor, task.id, b());
    await expectAppError(() => svc.start(actor, task.id, b()), 'TASK_INVALID_STATUS_TRANSITION', 409);
    await expectAppError(() => svc.complete(actor, task.id, b()), 'TASK_INVALID_STATUS_TRANSITION', 409);
    await expectAppError(() => svc.update(actor, task.id, b({ status: 'COMPLETED', version: task.version }), false), 'TASK_INVALID_STATUS_TRANSITION', 400);
  });

  it('Result-required completion.', async () => {
    const { svc, actor } = await setup();
    const task = svc.create(actor, { title: 'Needs result', requiresResult: true });
    await expectAppError(() => svc.complete(actor, task.id, b()), 'TASK_RESULT_REQUIRED', 409);
    expect(task.status).toBe('PENDING');
    svc.addResult(actor, task.id, b({ resultType: 'LINK', url: 'https://example.com/report' }));
    expect(svc.complete(actor, task.id, b()).data.status).toBe('COMPLETED');
  });

  it('Subtask policy.', async () => {
    const { svc, actor, app } = await setup();
    for (const [policy, expected] of [['IGNORE', 'COMPLETED'], ['WARN', 'COMPLETED'], ['REQUIRE_ALL', 'BLOCKED']] as const) {
      const parent = svc.create(actor, { title: `Parent ${policy}`, subtaskCompletionPolicy: policy });
      const child = svc.createSubtask(actor, parent.id, b({ title: 'Child' }));
      if (expected === 'BLOCKED') {
        await expectAppError(() => svc.complete(actor, parent.id, b()), 'TASK_SUBTASKS_INCOMPLETE', 409);
        svc.complete(actor, child.id, b());
        expect(svc.complete(actor, parent.id, b()).data.status).toBe('COMPLETED');
      } else {
        const result = svc.complete(actor, parent.id, b());
        expect(result.data.status).toBe('COMPLETED');
        expect((result.meta.warnings as unknown[]).length).toBe(policy === 'WARN' ? 1 : 0);
      }
    }
    // Default policy is WARN.
    expect(svc.create(actor, { title: 'Default' }).subtaskCompletionPolicy).toBe('WARN');
    expect(app.store.state.tasks.filter((row) => row.parentTaskId).every((row) => row.workspaceId === actor.workspaceId)).toBe(true);
  });

  it('Cross-workspace relation rejection.', async () => {
    const { svc, actor, app } = await setup();
    const foreign = await otherTenant(app, 'foreign');
    const foreignActor = app.access.actor(foreign.user, foreign.workspace.id);
    const foreignTask = svc.create(foreignActor, { title: 'Theirs' });
    await expectAppError(() => svc.get(actor, foreignTask.id), 'TASK_NOT_FOUND', 404);
    await expectAppError(() => svc.create(actor, { title: 'child', parentTaskId: foreignTask.id }), 'TASK_NOT_FOUND', 404);
    await expectAppError(() => svc.create(actor, { title: 'assign', responsibleUserId: foreign.user.id }), 'TASK_RESPONSIBLE_INVALID', 400);
    const project = app.collab.tasks.projects.create(foreignActor, b({ name: 'Foreign project' }));
    await expectAppError(() => svc.create(actor, { title: 'into foreign project', projectId: project.id }), 'PROJECT_NOT_FOUND', 404);
    expect(svc.list(actor, new URLSearchParams()).data.map((row) => row.id)).not.toContain(foreignTask.id);
  });

  it('Stale version conflict.', async () => {
    const { svc, actor } = await setup();
    const task = svc.create(actor, { title: 'Versioned' });
    svc.update(actor, task.id, b({ title: 'First writer', version: 1 }), false);
    await expectAppError(() => svc.update(actor, task.id, b({ title: 'Second writer', version: 1 }), false), 'RESOURCE_VERSION_CONFLICT', 409);
    expect(task.title).toBe('First writer');
    await expectAppError(() => svc.update(actor, task.id, b({ title: 'No version' }), false), 'VALIDATION_ERROR', 400);
  });

  it('Soft delete/restore/hard delete permission.', async () => {
    const { svc, actor, workerActor } = await setup();
    const task = svc.create(workerActor, { title: 'Disposable' });
    await expectAppError(() => svc.hardDelete(actor, task.id), 'TASK_NOT_DELETED', 409);
    svc.softDelete(workerActor, task.id);
    await expectAppError(() => svc.get(workerActor, task.id), 'TASK_NOT_FOUND', 404);
    await expectAppError(() => svc.hardDelete(workerActor, task.id), 'PERMISSION_DENIED', 403);
    svc.restore(workerActor, task.id);
    expect(svc.get(workerActor, task.id).isDeleted).toBe(false);
    svc.softDelete(workerActor, task.id);
    expect(svc.hardDelete(actor, task.id)).toEqual({ id: task.id, deleted: true });
    await expectAppError(() => svc.get(actor, task.id), 'TASK_NOT_FOUND', 404);
  });

  it('Task Chat provisioning is idempotent after creation.', async () => {
    const { svc, actor, app, worker } = await setup();
    const communication = (app.collab as unknown as { communication?: { chats: { taskChatOf(taskId: string): { id: string } | null } } }).communication;
    if (!communication) throw new Error('Task Chat is owned by the Communication module, which is not implemented yet (BLOCKED until module 4).');
    const task = svc.create(actor, { title: 'Discussed', responsibleUserId: worker.id });
    const first = communication.chats.taskChatOf(task.id);
    expect(first).toBeTruthy();
    svc.update(actor, task.id, b({ title: 'Renamed', version: task.version }), false);
    svc.addMember(actor, task.id, b({ userId: worker.id }), 'OBSERVER');
    expect(communication.chats.taskChatOf(task.id)!.id).toBe(first!.id);
    expect(app.store.state.tasks.filter((row) => row.id === task.id)).toHaveLength(1);
  });
});
