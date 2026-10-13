/**
 * TrueCRM executable contract test for Project Kanban & Planning Specification.
 * Service-level; the HTTP/Postgres path is covered by project-kanban-planning.e2e-spec.ts.
 */
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';

describe('Project Kanban & Planning Specification contract', () => {
  it('Delete in-use stage.', async () => {
    const { collab, owner } = await collabApp();
    const project = collab.tasks.projects.create(owner, b({ name: 'Board' }));
    const [todo, doing, done] = collab.tasks.stages.list(owner, project.id);
    const task = collab.tasks.tasks.create(owner, { title: 'Card', projectId: project.id });
    collab.tasks.stages.moveTask(owner, task.id, b({ stageId: doing.id }));
    await expectAppError(() => collab.tasks.stages.remove(owner, doing.id, new URLSearchParams(), b()), 'PROJECT_STAGE_IN_USE', 409);
    expect(task.projectStageId).toBe(doing.id);
    const result = collab.tasks.stages.remove(owner, doing.id, new URLSearchParams({ migrateToStageId: done.id }), b());
    expect(result).toMatchObject({ migratedTaskCount: 1, migratedToStageId: done.id });
    expect(task.projectStageId).toBe(done.id);
    // An unused, non-default stage can be removed directly; the default role moves when its stage goes.
    collab.tasks.stages.remove(owner, todo.id, new URLSearchParams(), b());
    expect(collab.tasks.stages.list(owner, project.id).map((row) => [row.code, row.isDefault])).toEqual([['DONE', true]]);
    await expectAppError(() => collab.tasks.stages.remove(owner, done.id, new URLSearchParams(), b()), 'PROJECT_STAGE_REQUIRED', 409);
  });

  it('Reorder race/version conflict.', async () => {
    const { collab, owner } = await collabApp();
    const project = collab.tasks.projects.create(owner, b({ name: 'Board' }));
    const stages = collab.tasks.stages.list(owner, project.id);
    const snapshotA = stages.map((row) => ({ id: row.id, version: row.version }));
    const snapshotB = stages.map((row) => ({ id: row.id, version: row.version }));
    // Writer A wins; writer B reorders from the same stale snapshot and must be rejected as a whole.
    collab.tasks.stages.reorder(owner, project.id, b({ stages: [snapshotA[2], snapshotA[1], snapshotA[0]] }));
    const orderAfterA = collab.tasks.stages.list(owner, project.id).map((row) => row.id);
    await expectAppError(() => collab.tasks.stages.reorder(owner, project.id, b({ stages: [snapshotB[1], snapshotB[0], snapshotB[2]] })), 'RESOURCE_VERSION_CONFLICT', 409);
    expect(collab.tasks.stages.list(owner, project.id).map((row) => row.id)).toEqual(orderAfterA);
    await expectAppError(() => collab.tasks.stages.reorder(owner, project.id, b({ stages: snapshotA.slice(0, 2) })), 'VALIDATION_ERROR', 400);
  });

  it('Ensure stage move does not change Task status.', async () => {
    const { collab, owner, memberActor } = await collabApp();
    const worker = await memberActor('worker', perms('OWN', 'task.read', 'task.create', 'task.update', 'project.read', 'project.task_move_stage'));
    const project = collab.tasks.projects.create(owner, b({ name: 'Board', memberUserIds: [worker.user.id] }));
    const stages = collab.tasks.stages.list(owner, project.id);
    const task = collab.tasks.tasks.create(owner, { title: 'Card', projectId: project.id, responsibleUserId: worker.user.id });
    for (const status of ['PENDING', 'IN_PROGRESS', 'DEFERRED'] as const) {
      if (status === 'IN_PROGRESS') collab.tasks.tasks.start(worker, task.id, b());
      if (status === 'DEFERRED') collab.tasks.tasks.defer(worker, task.id, b());
      for (const stage of [stages[2], stages[0], stages[1]]) {
        collab.tasks.stages.moveTask(worker, task.id, b({ stageId: stage.id }));
        expect(task.status).toBe(status);
        expect(task.projectStageId).toBe(stage.id);
      }
    }
    // ... and completing the Task leaves its stage where it is.
    collab.tasks.tasks.start(worker, task.id, b());
    collab.tasks.tasks.complete(owner, task.id, b());
    expect(task.projectStageId).toBe(stages[1].id);
    expect(collab.tasks.stages.stageHistory(worker, task.id)).toHaveLength(10);
  });
});
