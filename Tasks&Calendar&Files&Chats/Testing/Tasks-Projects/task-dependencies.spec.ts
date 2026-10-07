/**
 * TrueCRM executable contract test for Task Dependencies Specification.
 * Service-level; HTTP/Postgres (including the cross-instance race) is covered by task-dependencies.e2e-spec.ts.
 */
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp } from '../support/domain';

async function setup(count = 4) {
  const ctx = await collabApp();
  const tasks = Array.from({ length: count }, (_, index) => ctx.collab.tasks.tasks.create(ctx.owner, { title: `T${index}` }));
  return { ...ctx, tasks, svc: ctx.collab.tasks.dependencies };
}

describe('Task Dependencies Specification contract', () => {
  it('Direct cycle.', async () => {
    const { svc, owner, tasks: [a, bTask] } = await setup(2);
    svc.add(owner, bTask.id, b({ predecessorTaskId: a.id }));
    await expectAppError(() => svc.add(owner, a.id, b({ predecessorTaskId: bTask.id })), 'TASK_DEPENDENCY_CYCLE', 409);
    await expectAppError(() => svc.add(owner, a.id, b({ predecessorTaskId: a.id })), 'TASK_DEPENDENCY_SELF', 400);
    await expectAppError(() => svc.add(owner, bTask.id, b({ predecessorTaskId: a.id, type: 'START_START' })), 'TASK_DEPENDENCY_DUPLICATE', 409);
  });

  it('Indirect multi-hop cycle.', async () => {
    const { svc, owner, tasks: [a, bTask, c, d], state } = await setup(4);
    svc.add(owner, bTask.id, b({ predecessorTaskId: a.id }));
    svc.add(owner, c.id, b({ predecessorTaskId: bTask.id, type: 'START_START', lagSeconds: 3600 }));
    svc.add(owner, c.id, b({ successorTaskId: d.id }));
    await expectAppError(() => svc.add(owner, a.id, b({ predecessorTaskId: d.id })), 'TASK_DEPENDENCY_CYCLE', 409);
    expect(state.taskDependencies).toHaveLength(3);
    // A diamond is not a cycle.
    expect(svc.add(owner, d.id, b({ predecessorTaskId: a.id })).successorTaskId).toBe(d.id);
    const graph = svc.graph(owner, a.id);
    expect(graph.nodes.map((node) => node.id).sort()).toEqual([a.id, bTask.id, c.id, d.id].sort());
    expect(graph.edges).toHaveLength(4);
    await expectAppError(() => svc.add(owner, a.id, b({ successorTaskId: bTask.id, lagSeconds: -60 })), 'TASK_DEPENDENCY_INVALID_LAG', 400);
  });

  it('Race on concurrent edge creation.', async () => {
    // Inside one instance, writes are serialized through the request queue and the reachability check runs on the
    // current graph; the cross-instance race is exercised against PostgreSQL in task-dependencies.e2e-spec.ts.
    const { svc, owner, tasks: [a, bTask] } = await setup(2);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => svc.add(owner, bTask.id, b({ predecessorTaskId: a.id }))),
      Promise.resolve().then(() => svc.add(owner, a.id, b({ predecessorTaskId: bTask.id }))),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('TASK_DEPENDENCY_CYCLE');
  });

  it('Cross-workspace edge rejection.', async () => {
    const { svc, owner, tasks: [a], foreignActor, collab } = await setup(1);
    const foreign = await foreignActor();
    const theirs = collab.tasks.tasks.create(foreign, { title: 'Theirs' });
    await expectAppError(() => svc.add(owner, a.id, b({ predecessorTaskId: theirs.id })), 'TASK_NOT_FOUND', 404);
    await expectAppError(() => svc.add(foreign, theirs.id, b({ successorTaskId: a.id })), 'TASK_NOT_FOUND', 404);
    await expectAppError(() => svc.list(foreign, a.id), 'TASK_NOT_FOUND', 404);
  });
});
