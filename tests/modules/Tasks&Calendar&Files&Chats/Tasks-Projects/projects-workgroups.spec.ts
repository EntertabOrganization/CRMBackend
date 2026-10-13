/**
 * TrueCRM executable contract test for Projects & Workgroups Specification.
 * Service-level; the HTTP/Postgres path is covered by projects-workgroups.e2e-spec.ts.
 */
import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms, requireModule } from '../support/domain';

describe('Projects & Workgroups Specification contract', () => {
  it('Visibility vs membership.', async () => {
    const { collab, owner, memberActor } = await collabApp();
    const reader = await memberActor('reader', perms('WORKSPACE', 'project.read', 'project.update', 'project.member_manage'));
    const svc = collab.tasks.projects;
    const priv = svc.create(owner, b({ name: 'Private', visibility: 'PRIVATE' }));
    const visible = svc.create(owner, b({ name: 'Visible', visibility: 'WORKSPACE_VISIBLE' }));
    const invite = svc.create(owner, b({ name: 'Invite', visibility: 'INVITE_ONLY' }));
    const open = svc.create(owner, b({ name: 'Open', visibility: 'OPEN' }));
    // PRIVATE is invisible to non-members even with workspace-wide project.read.
    await expectAppError(() => svc.get(reader, priv.id), 'PROJECT_NOT_FOUND', 404);
    expect(svc.list(reader, new URLSearchParams()).data.map((row) => row.name).sort()).toEqual(['Invite', 'Open', 'Visible']);
    // Visibility never grants membership: the reader sees but has no project role.
    expect(svc.get(reader, visible.id).myRole).toBeNull();
    // Only OPEN projects allow self-join; others need a managing role (here: workspace-wide grant).
    const plain = await memberActor('plain', perms('OWN', 'project.read'));
    await expectAppError(() => svc.addMember(plain, invite.id, b({ userId: plain.user.id })), 'PERMISSION_DENIED', 403);
    svc.addMember(plain, open.id, b({ userId: plain.user.id }));
    expect(svc.get(plain, open.id).myRole).toBe('MEMBER');
    // Membership makes a PRIVATE project visible.
    svc.addMember(owner, priv.id, b({ userId: plain.user.id }));
    expect(svc.get(plain, priv.id).myRole).toBe('MEMBER');
    // ... but membership alone does not grant mutation rights.
    await expectAppError(() => svc.update(plain, priv.id, b({ name: 'Mine', version: priv.version }), false), 'PERMISSION_DENIED', 403);
  });

  it('Idempotent linked resource provisioning.', async () => {
    const ctx = await collabApp();
    const { collab, owner } = ctx;
    const calendar = requireModule<unknown>(collab, 'calendar', 'Calendar & Meetings (Project Calendar provisioner)');
    expect(calendar).toBeTruthy();
    const project = collab.tasks.projects.create(owner, b({ name: 'P', tools: ['TASKS'] }));
    // Creating a Project never eagerly provisions linked resources.
    expect(ctx.state.projectTools.filter((row) => row.projectId === project.id && row.linkedResourceId)).toHaveLength(0);
    const first = collab.tasks.projects.enableTool(owner, project.id, 'CALENDAR', true);
    const again = collab.tasks.projects.enableTool(owner, project.id, 'CALENDAR', true);
    collab.tasks.projects.enableTool(owner, project.id, 'CALENDAR', false);
    const reenabled = collab.tasks.projects.enableTool(owner, project.id, 'CALENDAR', true);
    const linked = collab.tasks.projects.linkedResources(owner, project.id);
    expect(new Set([first.linkedResourceId, again.linkedResourceId, reenabled.linkedResourceId, linked.CALENDAR.resourceId]).size).toBe(1);
    expect((ctx.state as unknown as { calendars: Array<{ projectId: string | null }> }).calendars.filter((row) => row.projectId === project.id)).toHaveLength(1);
  });

  it('Archive read-only behavior.', async () => {
    const { collab, owner, memberActor } = await collabApp();
    const worker = await memberActor('worker', perms('OWN', 'project.read', 'task.read', 'task.update', 'task.create', 'project.task_move_stage'));
    const project = collab.tasks.projects.create(owner, b({ name: 'P', memberUserIds: [worker.user.id] }));
    const task = collab.tasks.tasks.create(owner, { title: 'T', projectId: project.id, responsibleUserId: worker.user.id });
    const stages = collab.tasks.stages.list(owner, project.id);
    collab.tasks.projects.archive(owner, project.id);
    await expectAppError(() => collab.tasks.tasks.start(worker, task.id, b()), 'PROJECT_ARCHIVED', 409);
    await expectAppError(() => collab.tasks.stages.moveTask(worker, task.id, b({ stageId: stages[1].id })), 'PROJECT_ARCHIVED', 409);
    await expectAppError(() => collab.tasks.stages.create(owner, project.id, b({ name: 'New' })), 'PROJECT_ARCHIVED', 409);
    await expectAppError(() => collab.tasks.tasks.create(worker, { title: 'late', projectId: project.id }), 'PROJECT_ARCHIVED', 409);
    await expectAppError(() => collab.tasks.projects.enableTool(owner, project.id, 'FEED', true), 'PROJECT_ARCHIVED', 409);
    // History remains readable.
    expect(collab.tasks.tasks.get(worker, task.id).status).toBe('PENDING');
    expect(collab.tasks.tasks.historyList(owner, task.id, new URLSearchParams()).data.length).toBeGreaterThan(0);
    collab.tasks.projects.unarchive(owner, project.id);
    expect(collab.tasks.tasks.start(worker, task.id, b()).status).toBe('IN_PROGRESS');
  });

  it('Hard delete preserving external histories.', async () => {
    const ctx = await collabApp();
    const { collab, owner } = ctx;
    requireModule<unknown>(collab, 'calendar', 'Calendar & Meetings (Project Calendar detach on hard delete)');
    const project = collab.tasks.projects.create(owner, b({ name: 'P', tools: ['TASKS', 'CALENDAR'] }));
    const calendarId = collab.tasks.projects.linkedResources(owner, project.id).CALENDAR.resourceId!;
    const task = collab.tasks.tasks.create(owner, { title: 'T', projectId: project.id });
    collab.tasks.projects.softDelete(owner, project.id);
    collab.tasks.projects.hardDelete(owner, project.id);
    expect(ctx.state.projects.find((row) => row.id === project.id)).toBeUndefined();
    // The Task, the Calendar (detached, history intact) and central Audit all survive.
    expect(ctx.state.tasks.find((row) => row.id === task.id)).toMatchObject({ projectId: null });
    expect((ctx.state as unknown as { calendars: Array<{ id: string; projectId: string | null }> }).calendars.find((row) => row.id === calendarId)).toMatchObject({ projectId: null });
    expect(ctx.state.auditLogs.filter((row) => row.entityId === project.id).map((row) => row.action)).toEqual(expect.arrayContaining(['PROJECT.CREATED', 'PROJECT.HARD_DELETED']));
  });
});
