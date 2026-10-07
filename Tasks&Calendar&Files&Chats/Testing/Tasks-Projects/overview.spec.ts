/**
 * TrueCRM executable contract test for Tasks & Projects — Domain Overview.
 * Service-level; HTTP/Postgres paths are covered by overview.e2e-spec.ts and the per-spec E2E files.
 */
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms, requireModule } from '../support/domain';

describe('Tasks & Projects — Domain Overview contract', () => {
  it('Cross-workspace access is rejected.', async () => {
    const { collab, owner, foreignActor } = await collabApp();
    const foreign = await foreignActor();
    const project = collab.tasks.projects.create(owner, b({ name: 'Mine', visibility: 'OPEN' }));
    const task = collab.tasks.tasks.create(owner, { title: 'Mine', projectId: project.id });
    const stage = collab.tasks.stages.list(owner, project.id)[0];
    await expectAppError(() => collab.tasks.tasks.get(foreign, task.id), 'TASK_NOT_FOUND', 404);
    await expectAppError(() => collab.tasks.projects.get(foreign, project.id), 'PROJECT_NOT_FOUND', 404);
    await expectAppError(() => collab.tasks.stages.get(foreign, stage.id), 'PROJECT_STAGE_NOT_FOUND', 404);
    await expectAppError(() => collab.tasks.tasks.create(foreign, { title: 'x', projectId: project.id }), 'PROJECT_NOT_FOUND', 404);
    await expectAppError(() => collab.tasks.tasks.create(foreign, { title: 'x', parentTaskId: task.id }), 'TASK_NOT_FOUND', 404);
    expect(collab.tasks.tasks.list(foreign, new URLSearchParams()).data).toHaveLength(0);
    expect(collab.tasks.projects.list(foreign, new URLSearchParams()).data).toHaveLength(0);
  });

  it('Task status and Project stage stay independent.', async () => {
    const { collab, owner } = await collabApp();
    const project = collab.tasks.projects.create(owner, b({ name: 'Board' }));
    const stages = collab.tasks.stages.list(owner, project.id);
    const task = collab.tasks.tasks.create(owner, { title: 'Card', projectId: project.id });
    collab.tasks.stages.moveTask(owner, task.id, b({ stageId: stages[2].id }));
    expect(task.status).toBe('PENDING');
    collab.tasks.tasks.complete(owner, task.id, b());
    expect(task.projectStageId).toBe(stages[2].id);
    collab.tasks.tasks.reopen(owner, task.id, b());
    expect(task.projectStageId).toBe(stages[2].id);
    // Stage deletion migrates the column but never the status.
    collab.tasks.stages.remove(owner, stages[2].id, new URLSearchParams({ migrateToStageId: stages[0].id }), b());
    expect(task).toMatchObject({ status: 'PENDING', projectStageId: stages[0].id });
  });

  it('Project tool provisioning is idempotent.', async () => {
    const ctx = await collabApp();
    const { collab, owner } = ctx;
    requireModule<unknown>(collab, 'calendar', 'Calendar & Meetings (Project Calendar provisioner)');
    const project = collab.tasks.projects.create(owner, b({ name: 'P', tools: ['TASKS', 'CALENDAR'] }));
    const first = collab.tasks.projects.linkedResources(owner, project.id).CALENDAR.resourceId;
    const second = collab.tasks.projects.linkedResources(owner, project.id).CALENDAR.resourceId;
    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect((ctx.state as unknown as { calendars: Array<{ projectId: string | null }> }).calendars.filter((row) => row.projectId === project.id)).toHaveLength(1);
  });

  it('Task Chat cannot be used to bypass Task access.', async () => {
    const { collab, owner, memberActor } = await collabApp();
    const communication = requireModule<{ chats: { taskChatOf(taskId: string): { id: string } | null; addMember(actor: unknown, chatId: string, body: unknown): unknown; get(actor: unknown, chatId: string): unknown } }>(collab, 'communication', 'Communication (Task Chat)');
    const outsiderInWorkspace = await memberActor('nosy', perms('WORKSPACE', 'chat.read', 'chat.send', 'chat.manage'));
    const task = collab.tasks.tasks.create(owner, { title: 'Confidential' });
    const chat = communication.chats.taskChatOf(task.id)!;
    await expectAppError(() => communication.chats.get(outsiderInWorkspace, chat.id), 'CHAT_NOT_FOUND', 404);
    await expectAppError(() => communication.chats.addMember(outsiderInWorkspace, chat.id, b({ userId: outsiderInWorkspace.user.id })), 'CHAT_NOT_FOUND', 404);
    await expectAppError(() => communication.chats.addMember(owner, chat.id, b({ userId: outsiderInWorkspace.user.id })), 'TASK_CHAT_MEMBERSHIP_MANAGED', 409);
  });
});
