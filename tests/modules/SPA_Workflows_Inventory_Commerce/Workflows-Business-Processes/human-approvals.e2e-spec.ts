import type { PrismaClient } from '@prisma/client';
import { workflowHttpContract } from '@/tests/support/workflow-http-contract';
import { node, edge, typed } from '@/tests/support/workflow-graph';
import type { WorkflowFixture } from '@/tests/support/workflow-contract';

/** Real Nest + Next HTTP contracts against an owned migrated database. */
async function pending(f: WorkflowFixture, db: PrismaClient, type: 'APPROVAL' | 'REQUEST_INFO' = 'APPROVAL') {
  const start = node('START', 'START'), end = node('END', 'END');
  const task = node('TASK', type, { assigneeUserIds: [f.user.id], policy: 'ANY', ...(type === 'REQUEST_INFO' ? { informationSchema: [typed('NOTE', 'TEXT', { required: true })] } : {}) });
  const edges = type === 'APPROVAL' ? [edge(start, task), edge(task, end, 'APPROVE'), edge(task, end, 'REJECT')] : [edge(start, task), edge(task, end)];
  const w = await f.define({ nodes: [start, task, end], edges }), run = await f.start(w.workflowId); await f.drain();
  return { run, assignment: await db.workflowHumanAssignment.findFirstOrThrow({ where: { executionId: run.executionId } }) };
}
const contract = workflowHttpContract('truecrm_workflow_approvals_http_test', {
  'GET /api/v1/workflow-assignments/my': async (f, db) => { const { assignment } = await pending(f, db);
    return { permission: 'WORKFLOW.ASSIGNMENT_VIEW', ids: {}, query: '?status=PENDING',
      verify: async data => { expect(data).toEqual([expect.objectContaining({ id: assignment.id, status: 'PENDING', myDecision: null })]); } }; },
  'GET /api/v1/workflow-assignments/:assignmentId': async (f, db) => { const { assignment } = await pending(f, db);
    return { permission: 'WORKFLOW.ASSIGNMENT_VIEW', ids: { assignmentId: assignment.id },
      verify: async data => { expect(data).toMatchObject({ id: assignment.id, assignmentType: 'APPROVAL', policy: 'ANY', participants: [{ userId: f.user.id, hasDecided: false }] }); } }; },
  'POST /api/v1/workflow-assignments/:assignmentId/decide': async (f, db) => { const { run, assignment } = await pending(f, db);
    return { permission: 'WORKFLOW.ASSIGNMENT_DECIDE', ids: { assignmentId: assignment.id }, body: { decision: 'APPROVE', comment: 'Looks good' },
      verify: async data => { expect(data).toMatchObject({ status: 'COMPLETED', outcome: 'APPROVE' });
        expect(await db.workflowApprovalVote.findFirstOrThrow({ where: { assignmentId: assignment.id } })).toMatchObject({ decision: 'APPROVE', comment: 'Looks good', actedByUserId: f.user.id });
        await f.drain(); expect((await f.execution(run.executionId)).status).toBe('COMPLETED'); } }; },
  'POST /api/v1/workflow-assignments/:assignmentId/delegate': async (f, db) => { const { assignment } = await pending(f, db), delegate = await f.member({ 'WORKFLOW.EXECUTION_ADMIN': null });
    return { permission: 'WORKFLOW.ASSIGNMENT_DELEGATE', ids: { assignmentId: assignment.id }, body: { toUserId: delegate.user.id, reason: 'Vacation' },
      verify: async data => { expect(data.toUserId).toBe(delegate.user.id);
        expect(await db.workflowAssignmentParticipant.findFirstOrThrow({ where: { assignmentId: assignment.id } })).toMatchObject({ originalUserId: f.user.id, effectiveUserId: delegate.user.id }); } }; },
  'POST /api/v1/workflow-assignments/:assignmentId/submit-information': async (f, db) => { const { run, assignment } = await pending(f, db, 'REQUEST_INFO');
    return { permission: 'WORKFLOW.ASSIGNMENT_DECIDE', ids: { assignmentId: assignment.id }, body: { values: { NOTE: 'Provided details' } },
      verify: async data => { expect(data).toMatchObject({ status: 'COMPLETED', decision: 'SUBMIT_INFORMATION' });
        expect(await db.workflowHumanAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).toMatchObject({ status: 'COMPLETED', result: { values: { NOTE: 'Provided details' } } });
        await f.drain(); expect((await f.execution(run.executionId)).status).toBe('COMPLETED'); } }; },
  'GET /api/v1/workflow-assignments/:assignmentId/history': async (f, db) => { const { assignment } = await pending(f, db);
    return { permission: 'WORKFLOW.ASSIGNMENT_VIEW', ids: { assignmentId: assignment.id },
      verify: async data => { expect(data).toEqual([expect.objectContaining({ action: 'CREATED', metadata: { participantCount: 1 } })]); } }; },
});

describe('Human Approvals, Delegation and Assignments — REST E2E contract', () => {
  it('GET /api/v1/workflow-assignments/my verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflow-assignments/my'); });
  it('GET /api/v1/workflow-assignments/:assignmentId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflow-assignments/:assignmentId'); });
  it('POST /api/v1/workflow-assignments/:assignmentId/decide verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflow-assignments/:assignmentId/decide'); });
  it('POST /api/v1/workflow-assignments/:assignmentId/delegate verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflow-assignments/:assignmentId/delegate'); });
  it('POST /api/v1/workflow-assignments/:assignmentId/submit-information verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflow-assignments/:assignmentId/submit-information'); });
  it('GET /api/v1/workflow-assignments/:assignmentId/history verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflow-assignments/:assignmentId/history'); });
});

export {};
