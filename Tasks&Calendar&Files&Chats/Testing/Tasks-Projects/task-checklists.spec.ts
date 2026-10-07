/**
 * TrueCRM executable contract test for Task Checklists Specification.
 * Service-level; the HTTP/Postgres path is covered by task-checklists.e2e-spec.ts.
 */
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';

async function setup() {
  const ctx = await collabApp();
  const task = ctx.collab.tasks.tasks.create(ctx.owner, { title: 'With checklist' });
  const checklist = ctx.collab.tasks.checklists.create(ctx.owner, task.id, b({ name: 'Steps' }));
  return { ...ctx, task, checklist, svc: ctx.collab.tasks.checklists };
}

describe('Task Checklists Specification contract', () => {
  it('Nested item cycle rejection.', async () => {
    const { svc, owner, checklist } = await setup();
    const root = svc.addItem(owner, checklist.id, b({ title: 'Root' }));
    const child = svc.addItem(owner, checklist.id, b({ title: 'Child', parentItemId: root.id }));
    const grandchild = svc.addItem(owner, checklist.id, b({ title: 'Grandchild', parentItemId: child.id }));
    await expectAppError(() => svc.moveItem(owner, root.id, b({ parentItemId: grandchild.id, sortOrder: 1 })), 'CHECKLIST_HIERARCHY_CYCLE', 409);
    await expectAppError(() => svc.moveItem(owner, root.id, b({ parentItemId: root.id, sortOrder: 1 })), 'CHECKLIST_HIERARCHY_CYCLE', 409);
    expect(root.parentItemId).toBeNull();
    // Moving a leaf under a sibling branch is fine.
    expect(svc.moveItem(owner, grandchild.id, b({ parentItemId: root.id, sortOrder: 5 })).parentItemId).toBe(root.id);
  });

  it('Ordering/move behavior.', async () => {
    const { svc, owner, checklist, task, collab } = await setup();
    const a = svc.addItem(owner, checklist.id, b({ title: 'A' }));
    const bItem = svc.addItem(owner, checklist.id, b({ title: 'B' }));
    const sub = svc.addItem(owner, checklist.id, b({ title: 'B.1', parentItemId: bItem.id }));
    expect(svc.get(owner, checklist.id).items.map((row) => row.title)).toEqual(['A', 'B', 'B.1']);
    svc.moveItem(owner, bItem.id, b({ parentItemId: null, sortOrder: 1 }));
    expect(svc.get(owner, checklist.id).items.filter((row) => !row.parentItemId).map((row) => row.title)).toEqual(['B', 'A']);
    // Moving into another checklist of the same Task carries the subtree along.
    const second = svc.create(owner, task.id, b({ name: 'Second' }));
    svc.moveItem(owner, bItem.id, b({ checklistId: second.id, parentItemId: null, sortOrder: 10 }));
    expect(svc.get(owner, second.id).items.map((row) => row.id).sort()).toEqual([bItem.id, sub.id].sort());
    expect(svc.get(owner, checklist.id).items.map((row) => row.id)).toEqual([a.id]);
    // A checklist of another Task is not a valid target.
    const otherTask = collab.tasks.tasks.create(owner, { title: 'Other task' });
    const foreignChecklist = svc.create(owner, otherTask.id, b({ name: 'Elsewhere' }));
    await expectAppError(() => svc.moveItem(owner, a.id, b({ checklistId: foreignChecklist.id, sortOrder: 1 })), 'CHECKLIST_NOT_FOUND', 404);
    // Deleting a parent with children needs an explicit cascade.
    await expectAppError(() => svc.removeItem(owner, bItem.id, new URLSearchParams()), 'CHECKLIST_HAS_CHILDREN', 409);
    expect(svc.removeItem(owner, bItem.id, new URLSearchParams({ cascade: 'true' })).removedCount).toBe(2);
  });

  it('Assignment eligibility.', async () => {
    const { svc, owner, checklist, task, memberActor, foreignActor, collab } = await setup();
    const visible = await memberActor('visible', perms('WORKSPACE', 'task.read', 'task.checklist_complete'));
    const blind = await memberActor('blind', perms('OWN', 'task.read'));
    const external = await foreignActor();
    expect(svc.addItem(owner, checklist.id, b({ title: 'For visible', assignedUserId: visible.user.id })).assignedUserId).toBe(visible.user.id);
    await expectAppError(() => svc.addItem(owner, checklist.id, b({ title: 'For blind', assignedUserId: blind.user.id })), 'CHECKLIST_ASSIGNEE_INVALID', 400);
    await expectAppError(() => svc.addItem(owner, checklist.id, b({ title: 'For external', assignedUserId: external.user.id })), 'CHECKLIST_ASSIGNEE_INVALID', 400);
    // Once the blind user gets Task access (observer), assignment becomes valid.
    collab.tasks.tasks.addMember(owner, task.id, b({ userId: blind.user.id }), 'OBSERVER');
    expect(svc.addItem(owner, checklist.id, b({ title: 'For blind', assignedUserId: blind.user.id })).assignedUserId).toBe(blind.user.id);
  });

  it('Completion/reopen.', async () => {
    const { svc, owner, checklist, task, memberActor, collab } = await setup();
    const assignee = await memberActor('assignee', perms('OWN', 'task.read', 'task.checklist_complete'));
    collab.tasks.tasks.addMember(owner, task.id, b({ userId: assignee.user.id }), 'OBSERVER');
    const item = svc.addItem(owner, checklist.id, b({ title: 'Do it', assignedUserId: assignee.user.id }));
    const other = svc.addItem(owner, checklist.id, b({ title: 'Other' }));
    // The assignee may complete their own item even though observers cannot otherwise work on the Task.
    const done = svc.setCompleted(assignee, item.id, true, b());
    expect(done).toMatchObject({ isCompleted: true, completedByUserId: assignee.user.id });
    expect(done.completedAt).toBeInstanceOf(Date);
    await expectAppError(() => svc.setCompleted(assignee, other.id, true, b()), 'PERMISSION_DENIED', 403);
    svc.setCompleted(owner, other.id, true, b());
    // All items complete never completes the Task.
    expect(task.status).toBe('PENDING');
    const reopened = svc.setCompleted(owner, item.id, false, b());
    expect(reopened).toMatchObject({ isCompleted: false, completedByUserId: null, completedAt: null });
    expect(svc.get(owner, checklist.id)).toMatchObject({ completedCount: 1, totalCount: 2 });
  });

  it('Cross-workspace isolation.', async () => {
    const { svc, checklist, foreignActor, owner } = await setup();
    const item = svc.addItem(owner, checklist.id, b({ title: 'Secret' }));
    const foreign = await foreignActor();
    await expectAppError(() => svc.get(foreign, checklist.id), 'CHECKLIST_NOT_FOUND', 404);
    await expectAppError(() => svc.update(foreign, checklist.id, b({ name: 'x', version: 1 })), 'CHECKLIST_NOT_FOUND', 404);
    await expectAppError(() => svc.addItem(foreign, checklist.id, b({ title: 'x' })), 'CHECKLIST_NOT_FOUND', 404);
    await expectAppError(() => svc.setCompleted(foreign, item.id, true, b()), 'CHECKLIST_ITEM_NOT_FOUND', 404);
    await expectAppError(() => svc.removeItem(foreign, item.id, new URLSearchParams()), 'CHECKLIST_ITEM_NOT_FOUND', 404);
  });
});
