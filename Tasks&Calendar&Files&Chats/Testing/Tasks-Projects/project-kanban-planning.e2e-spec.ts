/**
 * TrueCRM API E2E contract for Project Kanban & Planning Specification.
 * Wired to the real Next route handlers, the transactional request wrapper and PostgreSQL (see ../support/e2e.ts).
 */
import { ALL_TASK_PERMISSIONS, MISSING_ID, PROJECT_MEMBER_PERMISSIONS, call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register } from '../support/e2e';
import type { Session } from '../support/e2e';

jest.setTimeout(180_000);

let owner: Session;
let teammate: Session;
let noPerm: Session;
let outsider: Session;

beforeAll(async () => {
  await prepareCollabDatabase();
  owner = await register('kanban-owner');
  teammate = await member(owner, 'kanban-teammate', [...PROJECT_MEMBER_PERMISSIONS, ...ALL_TASK_PERMISSIONS]);
  noPerm = await member(owner, 'kanban-noperm', [['task.read', 'OWN']]);
  outsider = await register('kanban-outsider');
});

afterAll(disconnect);

async function board() {
  const project = expectOk(await call(owner, 'POST', 'projects', { body: { name: `Board ${Math.random().toString(36).slice(2, 8)}`, memberUserIds: [teammate.userId] } }));
  const stages = expectOk(await call(owner, 'GET', `projects/${project.id}/stages`));
  return { project, stages };
}

describe('Project Kanban & Planning Specification E2E contract', () => {
  it('exposes and enforces representative routes: GET    /api/v1/projects/:projectId/stages; POST   /api/v1/projects/:projectId/stages; GET    /api/v1/project-stages/:id; PATCH  /api/v1/project-stages/:id', async () => {
    const { project, stages } = await board();
    expect(stages.map((row: any) => row.code)).toEqual(['NEW', 'IN_PROGRESS', 'DONE']);
    expect(stages.filter((row: any) => row.isDefault).map((row: any) => row.code)).toEqual(['NEW']);
    const created = expectOk(await call(owner, 'POST', `projects/${project.id}/stages`, { body: { name: 'QA review', isTerminalVisualStage: false } }));
    expect(created).toMatchObject({ name: 'QA review', code: 'QA_REVIEW', sortOrder: 400, isDefault: false, projectId: project.id });
    expect(expectOk(await call(teammate, 'GET', `project-stages/${created.id}`)).id).toBe(created.id);
    // PATCH: make it the default (the previous default is unset in the same transaction).
    const updated = expectOk(await call(owner, 'PATCH', `project-stages/${created.id}`, { body: { name: 'QA', isDefault: true, version: created.version } }));
    expect(updated).toMatchObject({ name: 'QA', isDefault: true, version: created.version + 1 });
    const after = expectOk(await call(owner, 'GET', `projects/${project.id}/stages`));
    expect(after.filter((row: any) => row.isDefault).map((row: any) => row.id)).toEqual([created.id]);
    expectError(await call(owner, 'PATCH', `project-stages/${created.id}`, { body: { name: 'stale', version: created.version } }), 409, 'RESOURCE_VERSION_CONFLICT');
    expectError(await call(owner, 'PATCH', `project-stages/${created.id}`, { body: { isDefault: false, version: updated.version } }), 409, 'PROJECT_STAGE_REQUIRED');
    // Plain project members cannot configure stages.
    expectError(await call(teammate, 'POST', `projects/${project.id}/stages`, { body: { name: 'Nope' } }), 403, 'PERMISSION_DENIED');
  });

  it('requires authenticated/authorized workspace context for protected endpoints', async () => {
    const { project, stages } = await board();
    expectError(await call(null, 'GET', `projects/${project.id}/stages`, { workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    expectError(await call(null, 'GET', `project-stages/${stages[0].id}`, { workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    expectError(await call(null, 'GET', 'tasks/planner', { workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    expectError(await call(noPerm, 'GET', `projects/${project.id}/stages`), 403, 'PERMISSION_DENIED');
    expectError(await call(outsider, 'GET', `projects/${project.id}/stages`, { workspaceId: owner.workspaceId }), 403, 'PERMISSION_DENIED');
    // noPerm can see this Task (responsible) but lacks project.task_move_stage.
    const task = expectOk(await call(owner, 'POST', 'tasks', { body: { title: 'Card', projectId: project.id, responsibleUserId: noPerm.userId } }));
    expect(expectOk(await call(noPerm, 'GET', `tasks/${task.id}`)).id).toBe(task.id);
    expectError(await call(noPerm, 'POST', `tasks/${task.id}/project-stage`, { body: { stageId: stages[1].id } }), 403, 'PERMISSION_DENIED');
  });

  it('rejects cross-workspace resource access without leaking resource existence', async () => {
    const { project, stages } = await board();
    const task = expectOk(await call(owner, 'POST', 'tasks', { body: { title: 'Card', projectId: project.id } }));
    expectError(await call(outsider, 'GET', `projects/${project.id}/stages`), 404, 'PROJECT_NOT_FOUND');
    expectError(await call(outsider, 'GET', `project-stages/${stages[0].id}`), 404, 'PROJECT_STAGE_NOT_FOUND');
    expectError(await call(outsider, 'PATCH', `project-stages/${stages[0].id}`, { body: { name: 'x', version: 1 } }), 404, 'PROJECT_STAGE_NOT_FOUND');
    expectError(await call(outsider, 'DELETE', `project-stages/${stages[0].id}`), 404, 'PROJECT_STAGE_NOT_FOUND');
    expectError(await call(outsider, 'PATCH', `projects/${project.id}/stages/reorder`, { body: { stages: [] } }), 404, 'PROJECT_NOT_FOUND');
    expectError(await call(outsider, 'POST', `tasks/${task.id}/project-stage`, { body: { stageId: stages[1].id } }), 404, 'TASK_NOT_FOUND');
    expectError(await call(outsider, 'GET', `tasks/${task.id}/project-stage-history`), 404, 'TASK_NOT_FOUND');
    expectError(await call(outsider, 'PUT', `tasks/${task.id}/planner-position`, { body: { plannerColumn: 'TODAY', sortOrder: 1 } }), 404, 'TASK_NOT_FOUND');
    // A stage of another project/workspace cannot be targeted.
    const foreign = expectOk(await call(outsider, 'POST', 'projects', { body: { name: 'Foreign board' } }));
    const foreignStages = expectOk(await call(outsider, 'GET', `projects/${foreign.id}/stages`));
    expectError(await call(owner, 'POST', `tasks/${task.id}/project-stage`, { body: { stageId: foreignStages[0].id } }), 404, 'PROJECT_STAGE_NOT_FOUND');
  });

  it('returns stable machine-readable error envelopes for invalid requests', async () => {
    const { project, stages } = await board();
    const other = await board();
    const task = expectOk(await call(owner, 'POST', 'tasks', { body: { title: 'Card', projectId: project.id } }));
    const loose = expectOk(await call(owner, 'POST', 'tasks', { body: { title: 'No project' } }));
    expectError(await call(owner, 'POST', `projects/${project.id}/stages`, { body: {} }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'POST', `projects/${project.id}/stages`, { body: { name: 'Dup', code: 'NEW' } }), 409, 'PROJECT_STAGE_CODE_CONFLICT');
    expectError(await call(owner, 'POST', `tasks/${task.id}/project-stage`, { body: { stageId: other.stages[0].id } }), 409, 'TASK_PROJECT_MISMATCH');
    expectError(await call(owner, 'POST', `tasks/${loose.id}/project-stage`, { body: { stageId: stages[0].id } }), 409, 'TASK_PROJECT_MISMATCH');
    expectError(await call(owner, 'POST', `tasks/${task.id}/project-stage`, { body: { stageId: MISSING_ID } }), 404, 'PROJECT_STAGE_NOT_FOUND');
    expectError(await call(owner, 'GET', `project-stages/${MISSING_ID}`), 404, 'PROJECT_STAGE_NOT_FOUND');
    expectError(await call(owner, 'PATCH', `projects/${project.id}/stages/reorder`, { body: { stages: [{ id: stages[0].id, version: 1 }] } }), 400, 'VALIDATION_ERROR');
    expectError(await call(owner, 'PUT', `tasks/${task.id}/planner-position`, { body: { plannerColumn: '', sortOrder: 1 } }), 400, 'VALIDATION_ERROR');
  });

  it('persists critical state and outbox/audit consistently on successful mutation', async () => {
    const { project, stages } = await board();
    const task = expectOk(await call(teammate, 'POST', 'tasks', { body: { title: 'Card', projectId: project.id } }));
    expect(task.projectStageId).toBe(stages[0].id);
    expectOk(await call(teammate, 'POST', `tasks/${task.id}/start`));
    // Stage move never changes Task status.
    const moved = expectOk(await call(teammate, 'POST', `tasks/${task.id}/project-stage`, { body: { stageId: stages[2].id } }));
    expect(moved.task).toMatchObject({ projectStageId: stages[2].id, status: 'IN_PROGRESS' });
    const history = expectOk(await call(teammate, 'GET', `tasks/${task.id}/project-stage-history`));
    expect(history.map((row: any) => [row.oldStageId, row.newStageId])).toEqual([[null, stages[0].id], [stages[0].id, stages[2].id]]);
    const prisma = await db();
    expect(await prisma.outboxEvent.count({ where: { entityId: task.id, eventType: 'TASK_PROJECT_STAGE_CHANGED' } })).toBe(1);
    expect((await prisma.task.findUnique({ where: { id: task.id } }))?.status).toBe('IN_PROGRESS');
    // Reorder atomically with versions; stale entry rejects everything.
    const reordered = expectOk(await call(owner, 'PATCH', `projects/${project.id}/stages/reorder`, { body: { stages: [stages[2], stages[0], stages[1]].map((row: any) => ({ id: row.id, version: row.version })) } }));
    expect(reordered.map((row: any) => row.code)).toEqual(['DONE', 'NEW', 'IN_PROGRESS']);
    expectError(await call(owner, 'PATCH', `projects/${project.id}/stages/reorder`, { body: { stages: stages.map((row: any) => ({ id: row.id, version: row.version })) } }), 409, 'RESOURCE_VERSION_CONFLICT');
    expect((await prisma.projectStage.findMany({ where: { projectId: project.id }, orderBy: { sortOrder: 'asc' } })).map((row) => row.code)).toEqual(['DONE', 'NEW', 'IN_PROGRESS']);
    // Delete in-use stage: rejected without target, migrated with target.
    expectError(await call(owner, 'DELETE', `project-stages/${stages[2].id}`), 409, 'PROJECT_STAGE_IN_USE');
    const removed = expectOk(await call(owner, 'DELETE', `project-stages/${stages[2].id}`, { query: { migrateToStageId: stages[1].id } }));
    expect(removed).toMatchObject({ deleted: true, migratedTaskCount: 1, migratedToStageId: stages[1].id });
    expect((await prisma.task.findUnique({ where: { id: task.id } }))).toMatchObject({ projectStageId: stages[1].id, status: 'IN_PROGRESS' });
    expect((await prisma.auditLog.findMany({ where: { entityId: stages[2].id } })).map((row) => row.action)).toContain('PROJECT.STAGE_DELETED');
    // The last live stage can never be removed.
    expectOk(await call(owner, 'DELETE', `project-stages/${stages[0].id}`));
    expectError(await call(owner, 'DELETE', `project-stages/${stages[1].id}`, { query: { migrateToStageId: stages[0].id } }), 409, 'PROJECT_STAGE_REQUIRED');
  });
});

describe('Personal planner', () => {
  it('GET /tasks/planner and PUT planner-position only affect the caller', async () => {
    const { project } = await board();
    const task = expectOk(await call(owner, 'POST', 'tasks', { body: { title: 'Shared', projectId: project.id } }));
    expectOk(await call(owner, 'PUT', `tasks/${task.id}/planner-position`, { body: { plannerColumn: 'TODAY', sortOrder: 10 } }));
    expectOk(await call(teammate, 'PUT', `tasks/${task.id}/planner-position`, { body: { plannerColumn: 'LATER', sortOrder: 5 } }));
    const updated = expectOk(await call(owner, 'PUT', `tasks/${task.id}/planner-position`, { body: { plannerColumn: 'THIS_WEEK', sortOrder: 1 } }));
    expect(updated.plannerColumn).toBe('THIS_WEEK');
    const mine = await call(owner, 'GET', 'tasks/planner');
    expect(expectOk(mine).filter((row: any) => row.taskId === task.id).map((row: any) => row.plannerColumn)).toEqual(['THIS_WEEK']);
    const theirs = expectOk(await call(teammate, 'GET', 'tasks/planner'));
    expect(theirs.filter((row: any) => row.taskId === task.id).map((row: any) => row.plannerColumn)).toEqual(['LATER']);
    // The Task itself is untouched by planner moves.
    const prisma = await db();
    expect((await prisma.task.findUnique({ where: { id: task.id } }))).toMatchObject({ version: 1, status: 'PENDING' });
    expect(await prisma.taskPlannerPosition.count({ where: { taskId: task.id } })).toBe(2);
  });
});
