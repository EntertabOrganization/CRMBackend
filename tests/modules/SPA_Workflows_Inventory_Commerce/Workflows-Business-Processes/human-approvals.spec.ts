import { randomUUID } from 'node:crypto';
import { workflowDatabase, workflowFixture, node, edge, typed, type WorkflowFixture } from '@/tests/support/workflow-contract';

/** Durable approval assignments, votes, delegation and timeout policies against an owned migrated database. */
const database = workflowDatabase('truecrm_workflow_approvals_test');

async function approvers(f: WorkflowFixture, count: number) {
  const result = [];
  for (let i = 0; i < count; i++) result.push(await f.member({ 'WORKFLOW.EXECUTION_ADMIN': null }));
  return result;
}
async function approvalFlow(f: WorkflowFixture, config: Record<string, unknown>) {
  const start = node('START', 'START'), approval = node('APPROVAL', 'APPROVAL', config), end = node('END', 'END');
  const ok = node('OK', 'SET_VARIABLE', { variable: 'RESULT', expression: '"approved"' }), no = node('NO', 'SET_VARIABLE', { variable: 'RESULT', expression: '"rejected"' });
  const nodes = [start, approval, ok, no, end], edges = [edge(start, approval), edge(approval, ok, 'APPROVE'), edge(approval, no, 'REJECT'), edge(ok, end), edge(no, end)];
  if (config.dueSeconds) {
    const late = node('LATE', 'SET_VARIABLE', { variable: 'RESULT', expression: '"timeout"' });
    nodes.push(late); edges.push(edge(approval, late, 'TIMEOUT'), edge(late, end));
  }
  const w = await f.define({ nodes, edges, variables: [typed('RESULT')] });
  const run = await f.start(w.workflowId); await f.drain();
  const db = database(), assignment = await db.workflowHumanAssignment.findFirstOrThrow({ where: { executionId: run.executionId } });
  return { w, run, assignment };
}
const vote = (f: WorkflowFixture, actor: WorkflowFixture['actor'], id: string, decision = 'APPROVE', key = randomUUID()) =>
  f.assignments.decide(actor, id, { decision }, key);

describe('Human Approvals, Delegation and Assignments — unit/integration contract', () => {
  it('ALL approval waits for last approver before advancing', async () => {
    const db = database(), f = await workflowFixture(db), team = await approvers(f, 3);
    const { run, assignment } = await approvalFlow(f, { assigneeUserIds: team.map(t => t.user.id), policy: 'ALL' });
    expect(assignment).toMatchObject({ status: 'PENDING', policy: 'ALL' });
    expect(await f.outbox('WORKFLOW_ASSIGNMENT_CREATED', assignment.id)).toBe(1);
    for (const member of team.slice(0, 2)) {
      expect(await vote(f, member.actor, assignment.id)).toMatchObject({ status: 'PENDING', outcome: null }); await f.drain();
      expect((await f.execution(run.executionId)).status).toBe('WAITING');
      expect(await f.runs(run.executionId, 'OK')).toHaveLength(0);
    }
    expect(await vote(f, team[2].actor, assignment.id)).toMatchObject({ status: 'COMPLETED', outcome: 'APPROVE' }); await f.drain();
    expect(await f.execution(run.executionId)).toMatchObject({ status: 'COMPLETED', variables: { RESULT: 'approved' } });
    expect(await db.workflowHumanAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).toMatchObject({ status: 'COMPLETED', result: { decision: 'APPROVE', approved: 3 } });
    expect(await db.workflowApprovalVote.count({ where: { assignmentId: assignment.id } })).toBe(3);
  });

  it('ANY accepts first authorized distinct approval only', async () => {
    const db = database(), f = await workflowFixture(db), team = await approvers(f, 3), outsider = (await approvers(f, 1))[0];
    const { run, assignment } = await approvalFlow(f, { assigneeUserIds: team.map(t => t.user.id), policy: 'ANY' });
    await expect(vote(f, outsider.actor, assignment.id)).rejects.toMatchObject({ code: 'WORKFLOW_ASSIGNMENT_NOT_FOUND', status: 404 });
    expect(await vote(f, team[1].actor, assignment.id)).toMatchObject({ outcome: 'APPROVE' }); await f.drain();
    await expect(vote(f, team[0].actor, assignment.id)).rejects.toMatchObject({ code: 'WORKFLOW_ASSIGNMENT_CLOSED', status: 409 });
    expect(await db.workflowApprovalVote.findMany({ where: { assignmentId: assignment.id } })).toEqual([expect.objectContaining({ assigneeUserId: team[1].user.id, decision: 'APPROVE' })]);
    expect(await f.runs(run.executionId, 'OK')).toHaveLength(1);
    expect((await f.execution(run.executionId)).status).toBe('COMPLETED');
  });

  it('QUORUM 2-of-3 advances once after second vote', async () => {
    const db = database(), f = await workflowFixture(db), team = await approvers(f, 3);
    const { run, assignment } = await approvalFlow(f, { assigneeUserIds: team.map(t => t.user.id), policy: 'QUORUM', quorumCount: 2 });
    expect(await vote(f, team[0].actor, assignment.id)).toMatchObject({ status: 'PENDING' }); await f.drain();
    expect(await f.runs(run.executionId, 'OK')).toHaveLength(0);
    expect(await vote(f, team[2].actor, assignment.id)).toMatchObject({ status: 'COMPLETED', outcome: 'APPROVE' }); await f.drain();
    await expect(vote(f, team[1].actor, assignment.id)).rejects.toMatchObject({ code: 'WORKFLOW_ASSIGNMENT_CLOSED' }); await f.drain();
    expect(await f.runs(run.executionId, 'OK')).toHaveLength(1);
    expect(await db.outboxEvent.count({ where: { entityId: assignment.id, eventType: 'WORKFLOW_ASSIGNMENT_DECIDED', payload: { path: ['outcome'], equals: 'APPROVE' } } })).toBe(1);
    expect(await f.execution(run.executionId)).toMatchObject({ status: 'COMPLETED', variables: { RESULT: 'approved' } });
  });

  it('reject route follows declared rejection edge', async () => {
    const db = database(), f = await workflowFixture(db), team = await approvers(f, 2);
    const { run, assignment } = await approvalFlow(f, { assigneeUserIds: team.map(t => t.user.id), policy: 'ALL' });
    expect(await vote(f, team[0].actor, assignment.id, 'REJECT')).toMatchObject({ status: 'COMPLETED', outcome: 'REJECT' }); await f.drain();
    expect(await f.execution(run.executionId)).toMatchObject({ status: 'COMPLETED', variables: { RESULT: 'rejected' } });
    expect(await f.runs(run.executionId, 'NO')).toHaveLength(1); expect(await f.runs(run.executionId, 'OK')).toHaveLength(0);
    expect(await db.workflowHumanAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).toMatchObject({ status: 'COMPLETED', result: { decision: 'REJECT', rejected: 1 } });
  });

  it('concurrent duplicate vote does not double advance workflow', async () => {
    const db = database(), f = await workflowFixture(db), team = await approvers(f, 2);
    const { run, assignment } = await approvalFlow(f, { assigneeUserIds: team.map(t => t.user.id), policy: 'ANY' });
    const key = randomUUID();
    const sameKey = await Promise.all([vote(f, team[0].actor, assignment.id, 'APPROVE', key), vote(f, team[0].actor, assignment.id, 'APPROVE', key)]);
    expect(sameKey[0]).toEqual(sameKey[1]);
    const racers = await Promise.allSettled([vote(f, team[0].actor, assignment.id), vote(f, team[1].actor, assignment.id)]);
    expect(racers.every(r => r.status === 'rejected' && ['WORKFLOW_ASSIGNMENT_CLOSED', 'WORKFLOW_APPROVAL_DUPLICATE'].includes((r.reason as { code: string }).code))).toBe(true);
    await f.drain();
    expect(await db.workflowApprovalVote.count({ where: { assignmentId: assignment.id } })).toBe(1);
    expect(await f.runs(run.executionId, 'OK')).toHaveLength(1); expect(await f.runs(run.executionId, 'END')).toHaveLength(1);
    expect(await f.outbox('WORKFLOW_COMPLETED', run.executionId)).toBe(1);
    // Two distinct approvers racing an ANY assignment still advance it once.
    const second = await approvalFlow(f, { assigneeUserIds: team.map(t => t.user.id), policy: 'ANY' });
    const raced = await Promise.allSettled(team.map(t => vote(f, t.actor, second.assignment.id))); await f.drain();
    expect(raced.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await f.runs(second.run.executionId, 'OK')).toHaveLength(1);
  });

  it('delegated old actor denied if no remaining authorization', async () => {
    const db = database(), f = await workflowFixture(db), [original, delegate] = await approvers(f, 2);
    const unable = await f.member({ 'WORKFLOW.EXECUTION_ADMIN': null, 'WORKFLOW.ASSIGNMENT_DECIDE': null });
    const { run, assignment } = await approvalFlow(f, { assigneeUserIds: [original.user.id], policy: 'ALL' });
    await expect(f.assignments.delegate(original.actor, assignment.id, { toUserId: unable.user.id, reason: 'Away' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
    expect(await f.assignments.delegate(original.actor, assignment.id, { toUserId: delegate.user.id, reason: 'On leave' })).toMatchObject({ toUserId: delegate.user.id });
    await expect(vote(f, original.actor, assignment.id)).rejects.toMatchObject({ code: 'WORKFLOW_ASSIGNMENT_NOT_FOUND', status: 404 });
    await expect(f.assignments.get(original.actor, assignment.id)).rejects.toMatchObject({ status: 404 });
    expect(await vote(f, delegate.actor, assignment.id)).toMatchObject({ outcome: 'APPROVE' }); await f.drain();
    expect((await f.execution(run.executionId)).status).toBe('COMPLETED');
    const history = await f.assignments.history(delegate.actor, assignment.id, {});
    expect(history.data.find(h => h.action === 'DELEGATED')?.metadata).toMatchObject({ fromUserId: original.user.id, toUserId: delegate.user.id, originalUserId: original.user.id, reason: 'On leave' });
    expect((await db.workflowApprovalVote.findFirstOrThrow({ where: { assignmentId: assignment.id } }))).toMatchObject({ actedByUserId: delegate.user.id });
    expect(await f.outbox('WORKFLOW_ASSIGNMENT_DELEGATED', assignment.id)).toBe(1);
  });

  it('default timeout escalates without auto-approval', async () => {
    const db = database(), f = await workflowFixture(db), [approver, escalation] = await approvers(f, 2);
    const timed = await approvalFlow(f, { assigneeUserIds: [approver.user.id], policy: 'ALL', dueSeconds: 60 });
    expect(timed.assignment.timeoutPolicy).toEqual({ type: 'TIMEOUT_BRANCH' });
    await db.workflowHumanAssignment.update({ where: { id: timed.assignment.id }, data: { dueAt: new Date(Date.now() - 1000) } });
    await expect(vote(f, approver.actor, timed.assignment.id)).rejects.toMatchObject({ code: 'WORKFLOW_ASSIGNMENT_CLOSED' });
    expect((await f.waits.assignments(50)).resolved).toBeGreaterThanOrEqual(1); await f.drain();
    expect(await f.execution(timed.run.executionId)).toMatchObject({ status: 'COMPLETED', variables: { RESULT: 'timeout' } });
    expect(await f.runs(timed.run.executionId, 'OK')).toHaveLength(0);
    expect(await db.workflowHumanAssignment.findUniqueOrThrow({ where: { id: timed.assignment.id } })).toMatchObject({ status: 'EXPIRED', result: { decision: 'TIMEOUT' } });
    expect(await db.workflowApprovalVote.count({ where: { assignmentId: timed.assignment.id } })).toBe(0);
    const escalating = await approvalFlow(f, { assigneeUserIds: [approver.user.id], policy: 'ALL', dueSeconds: 60, timeoutPolicy: { type: 'ESCALATE', toUserId: escalation.user.id } });
    await db.workflowHumanAssignment.update({ where: { id: escalating.assignment.id }, data: { dueAt: new Date(Date.now() - 1000) } });
    await f.waits.assignments(50); await f.drain();
    expect(await db.workflowHumanAssignment.findUniqueOrThrow({ where: { id: escalating.assignment.id } })).toMatchObject({ status: 'PENDING', dueAt: null });
    expect((await db.workflowAssignmentParticipant.findFirstOrThrow({ where: { assignmentId: escalating.assignment.id } }))).toMatchObject({ originalUserId: approver.user.id, effectiveUserId: escalation.user.id });
    expect((await f.execution(escalating.run.executionId)).status).toBe('WAITING');
    expect(await f.outbox('WORKFLOW_ASSIGNMENT_ESCALATED', escalating.assignment.id)).toBe(1);
    expect(await vote(f, escalation.actor, escalating.assignment.id)).toMatchObject({ outcome: 'APPROVE' });
  });

  it('suspended execution does not allow accidental completion', async () => {
    const db = database(), f = await workflowFixture(db), [approver] = await approvers(f, 1);
    const { run, assignment } = await approvalFlow(f, { assigneeUserIds: [approver.user.id], policy: 'ANY', dueSeconds: 60 });
    await f.executions.control(f.actor, run.executionId, 'suspend', { expectedVersion: (await f.execution(run.executionId)).version, reason: 'Investigation' });
    await expect(vote(f, approver.actor, assignment.id)).rejects.toMatchObject({ code: 'WORKFLOW_ASSIGNMENT_CLOSED', status: 409 });
    await db.workflowHumanAssignment.update({ where: { id: assignment.id }, data: { dueAt: new Date(Date.now() - 1000) } });
    await f.waits.assignments(50); await f.drain();
    expect(await db.workflowHumanAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).toMatchObject({ status: 'PENDING' });
    expect(await db.workflowApprovalVote.count({ where: { assignmentId: assignment.id } })).toBe(0);
    expect(await f.execution(run.executionId)).toMatchObject({ status: 'SUSPENDED', variables: { RESULT: null } });
    await db.workflowHumanAssignment.update({ where: { id: assignment.id }, data: { dueAt: new Date(Date.now() + 600000) } });
    await f.executions.control(f.actor, run.executionId, 'resume', { expectedVersion: (await f.execution(run.executionId)).version });
    expect(await vote(f, approver.actor, assignment.id)).toMatchObject({ outcome: 'APPROVE' }); await f.drain();
    expect(await f.execution(run.executionId)).toMatchObject({ status: 'COMPLETED', variables: { RESULT: 'approved' } });
  });
});

export {};
