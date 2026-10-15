import { randomUUID } from 'node:crypto';
import { workflowDatabase, workflowFixture, linear, node, edge, typed } from '@/tests/support/workflow-contract';

/** Log classification/redaction, retention with legal hold, templates and reconciliation recovery. */
const database = workflowDatabase('truecrm_workflow_security_test');

describe('Workflow Security, Runtime Policies, Templates and Administration — unit/integration contract', () => {
  it('nonadmin cannot inspect other workflow sensitive logs', async () => {
    const db = database(), f = await workflowFixture(db);
    const w = await f.define({ ...linear(node('HOLD', 'TIMER', { type: 'RELATIVE', seconds: 600 })), parameters: [typed('SALARY', 'TEXT', { classification: 'SENSITIVE' })] });
    const run = await f.start(w.workflowId, { SALARY: 'confidential-amount' }); await f.drain();
    await db.workflowExecutionLog.createMany({ data: [
      { workspaceId: f.workspace.id, executionId: run.executionId, level: 'WARN', code: 'BUSINESS_TRACE', classification: 'BUSINESS', metadata: { detail: 'business-trace' } },
      { workspaceId: f.workspace.id, executionId: run.executionId, level: 'WARN', code: 'SENSITIVE_TRACE', classification: 'SENSITIVE', metadata: { detail: 'sensitive-trace' } }] });
    const nonadmin = await f.member({ 'WORKFLOW.EXECUTION_ADMIN': null });
    const visible = await f.executions.logs(nonadmin.actor, run.executionId, { limit: 100 });
    expect(visible.entries.map(e => e.code)).toEqual(expect.arrayContaining(['WORKFLOW_STARTED', 'WORKFLOW_NODE_COMPLETED']));
    expect(visible.entries.map(e => e.code)).not.toEqual(expect.arrayContaining(['BUSINESS_TRACE']));
    expect(JSON.stringify(visible)).not.toMatch(/business-trace|sensitive-trace|confidential-amount/);
    const admin = await f.executions.logs(f.actor, run.executionId, { limit: 100 });
    expect(admin.entries.map(e => e.code)).toContain('BUSINESS_TRACE');
    expect(admin.entries.map(e => e.code)).not.toContain('SENSITIVE_TRACE');
    expect(JSON.stringify(admin)).not.toContain('business-trace');
    await expect(f.executions.logs(nonadmin.actor, run.executionId, { level: 'DEBUG' })).rejects.toMatchObject({ status: 400 });
    await expect(f.governance.health(nonadmin.actor, {})).rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
    const other = await f.member({ 'WORKFLOW.LOG_VIEW': 'OWN', 'WORKFLOW.EXECUTION_VIEW': 'OWN' });
    await expect(f.executions.logs(other.actor, run.executionId, {})).rejects.toMatchObject({ code: 'WORKFLOW_EXECUTION_NOT_FOUND', status: 404 });
  });

  it('SECRET tokens never persist to logs', async () => {
    const db = database(), f = await workflowFixture(db), token = 'secret-token-' + randomUUID();
    await expect(f.define({ ...linear(), parameters: [typed('API_TOKEN', 'TEXT', { classification: 'SECRET', defaultValue: 'hardcoded' })] }))
      .rejects.toMatchObject({ code: 'WORKFLOW_GRAPH_INVALID' });
    const approver = await f.member({ 'WORKFLOW.EXECUTION_ADMIN': null });
    const start = node('START', 'START'), copy = node('COPY', 'SET_VARIABLE', { variable: 'COPIED', expression: 'parameters.API_TOKEN' }), end = node('END', 'END');
    const info = node('INFO', 'REQUEST_INFO', { assigneeUserIds: [approver.user.id], informationSchema: [typed('PIN', 'TEXT', { classification: 'SECRET' }), typed('NOTE')] });
    const w = await f.define({ nodes: [start, copy, info, end], edges: [edge(start, copy), edge(copy, info), edge(info, end)],
      parameters: [typed('API_TOKEN', 'TEXT', { classification: 'SECRET', required: true })], variables: [typed('COPIED', 'TEXT', { classification: 'SECRET' })] });
    const run = await f.start(w.workflowId, { API_TOKEN: token }); await f.drain();
    const assignment = await db.workflowHumanAssignment.findFirstOrThrow({ where: { executionId: run.executionId } });
    await f.assignments.decide(approver.actor, assignment.id, { values: { PIN: 'pin-' + token, NOTE: 'public note' } }, randomUUID(), true); await f.drain();
    const finished = await f.execution(run.executionId);
    expect(finished).toMatchObject({ status: 'COMPLETED', parameters: { API_TOKEN: '[REDACTED]' }, variables: { COPIED: '[REDACTED]' } });
    expect((await db.workflowApprovalVote.findFirstOrThrow({ where: { assignmentId: assignment.id } })).fields).toEqual({ PIN: '[REDACTED]', NOTE: 'public note' });
    for (const table of ['workflow_executions', 'workflow_node_executions', 'workflow_execution_logs', 'workflow_approval_votes', 'workflow_human_assignments',
      'workflow_execution_tokens', 'outbox_events', 'audit_logs', 'idempotency_records']) {
      const [row] = await db.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*)::bigint AS count FROM ${table} t WHERE t::text LIKE '%' || $1 || '%'`, token);
      expect([table, Number(row.count)]).toEqual([table, 0]);
    }
    const projection = await f.executions.get(f.actor, run.executionId);
    expect(projection.parameters).toEqual({}); expect(projection.variables).toEqual({});
  });

  it('completed log retention respects legal hold', async () => {
    const db = database(), f = await workflowFixture(db);
    const flow = await f.define({ ...linear(node('MARK', 'SET_VARIABLE', { variable: 'NOTE', expression: '"done"' })), variables: [typed('NOTE')] }, { concurrencyMode: 'ALLOW_PARALLEL' });
    const held = await f.start(flow.workflowId), free = await f.start(flow.workflowId), recent = await f.start(flow.workflowId); await f.drain();
    const old = new Date(Date.now() - 40 * 86400000);
    await db.workflowExecution.updateMany({ where: { id: { in: [held.executionId, free.executionId] } }, data: { completedAt: old } });
    await db.workflowExecution.update({ where: { id: held.executionId }, data: { legalHold: true } });
    await f.triggers.setLimits(f.actor, { maxLoopIterations: 1000, maxNodeRuns: 10000, maxDepth: 10, maxLifetimeDays: 365, retentionDays: 30 });
    expect(await f.outbox('WORKFLOW_RETENTION_CHANGED')).toBe(1);
    const auditBefore = await db.auditLog.count({ where: { workspaceId: f.workspace.id } });
    const result = await f.governance.purgeRetention(50);
    expect(result).toMatchObject({ purged: 1 });
    expect(await db.workflowExecutionLog.count({ where: { executionId: free.executionId } })).toBe(0);
    expect(await db.workflowNodeExecution.findMany({ where: { executionId: free.executionId } })).toEqual(expect.arrayContaining([expect.objectContaining({ input: {}, output: null, status: 'SUCCEEDED' })]));
    expect(await f.execution(free.executionId)).toMatchObject({ status: 'COMPLETED', variables: { NOTE: 'done' } });
    expect(await db.workflowExecutionLog.count({ where: { executionId: held.executionId } })).toBeGreaterThan(0);
    expect(await db.workflowExecutionLog.count({ where: { executionId: recent.executionId } })).toBeGreaterThan(0);
    expect(await db.auditLog.count({ where: { workspaceId: f.workspace.id } })).toBe(auditBefore);
    expect(await f.outbox('WORKFLOW_LOGS_PURGED', free.executionId)).toBe(1);
    expect((await f.governance.purgeRetention(50)).purged).toBe(0);
    await db.workflowExecution.update({ where: { id: held.executionId }, data: { legalHold: false } });
    expect((await f.governance.purgeRetention(50)).purged).toBe(1);
  });

  it('archiving template does not affect instantiated definitions', async () => {
    const db = database(), f = await workflowFixture(db), source = await f.define({ ...linear(node('MARK', 'SET_VARIABLE', { variable: 'NOTE', expression: '"template"' })), variables: [typed('NOTE')] });
    const template = await f.templates.create(f.actor, { name: 'Approval template', category: 'Operations', sourceVersionId: source.versionId });
    const instantiated = await f.templates.instantiate(f.actor, template.id, { name: 'From template', code: 'FROM_TEMPLATE', bindings: { boundEntityTypeId: f.type.id, values: {} } });
    expect(await f.outbox('WORKFLOW_TEMPLATE_CREATED', template.id)).toBe(1);
    // There is no template archive operation in the API contract; archival is the template row's lifecycle state.
    await db.workflowTemplate.update({ where: { id: template.id }, data: { status: 'ARCHIVED' } });
    expect((await f.templates.list(f.actor, {})).data.map(t => t.id)).not.toContain(template.id);
    await expect(f.templates.instantiate(f.actor, template.id, { name: 'Late', code: 'LATE_COPY', bindings: { boundEntityTypeId: f.type.id, values: {} } })).rejects.toMatchObject({ code: 'WORKFLOW_TEMPLATE_INVALID', status: 404 });
    const draft = await db.workflowVersion.findUniqueOrThrow({ where: { id: instantiated.draftVersionId } });
    await f.definitions.publish(f.actor, instantiated.id, draft.id, { expectedVersion: draft.revision });
    const run = await f.start(instantiated.id); await f.drain();
    expect(await f.execution(run.executionId)).toMatchObject({ status: 'COMPLETED', variables: { NOTE: 'template' } });
    expect(await db.workflowDefinition.findUniqueOrThrow({ where: { id: instantiated.id } })).toMatchObject({ status: 'ACTIVE', code: 'FROM_TEMPLATE' });
  });

  it('template copied to another Workspace removes hardcoded target IDs/secrets', async () => {
    const db = database(), f = await workflowFixture(db), target = await workflowFixture(db);
    const create = node('CREATE', 'ACTION', { actionCode: 'SPA.CREATE_ITEM', input: { typeId: f.type.id, item: { title: 'Contact ops@example.com', assignedUserId: f.user.id, fieldValues: { VALUE: 'https://intranet.example.com' } } } });
    const source = await f.define({ ...linear(create), parameters: [typed('OWNER', 'USER', { defaultValue: f.user.id })] });
    await expect(f.templates.create(target.actor, { name: 'Foreign', category: 'Ops', sourceVersionId: source.versionId })).rejects.toMatchObject({ code: 'WORKFLOW_TEMPLATE_INVALID', status: 404 });
    const template = await f.templates.create(f.actor, { name: 'Portable', category: 'Ops', sourceVersionId: source.versionId });
    const stored = JSON.stringify((await db.workflowTemplate.findUniqueOrThrow({ where: { id: template.id } })).snapshot);
    for (const value of [f.type.id, f.user.id, f.workspace.id, f.item.id, 'ops@example.com', 'https://intranet.example.com', ...(await db.workflowNode.findMany({ where: { versionId: source.versionId } })).map(n => n.id)])
      expect(stored).not.toContain(value);
    await expect(target.templates.instantiate(target.actor, template.id, { name: 'Steal', code: 'STEAL', bindings: { values: {} } })).rejects.toMatchObject({ status: 404 });
    // A copied template (export/import of its portable snapshot) must be re-bound to the receiving Workspace.
    const copy = await db.workflowTemplate.create({ data: { workspaceId: target.workspace.id, name: 'Imported', category: 'Ops', ownerUserId: target.user.id,
      snapshot: (await db.workflowTemplate.findUniqueOrThrow({ where: { id: template.id } })).snapshot as object } });
    const slots = ((copy.snapshot as { slots: Array<{ key: string; path: string }> }).slots);
    await expect(target.templates.instantiate(target.actor, copy.id, { name: 'Unbound', code: 'UNBOUND', bindings: { boundEntityTypeId: target.type.id, values: {} } })).rejects.toMatchObject({ code: 'WORKFLOW_TEMPLATE_INVALID' });
    const values = Object.fromEntries(slots.map(slot => [slot.key, slot.path.endsWith('.defaultValue') ? target.user.id
      : slot.path.endsWith('.input') ? { typeId: target.type.id, item: { title: 'Rebound', assignedUserId: target.user.id, fieldValues: { VALUE: 'local' } } } : null]));
    const rebound = await target.templates.instantiate(target.actor, copy.id, { name: 'Rebound', code: 'REBOUND', bindings: { boundEntityTypeId: target.type.id, values } });
    const graph = JSON.stringify((await db.workflowVersion.findUniqueOrThrow({ where: { id: rebound.draftVersionId } })).definition);
    expect(graph).toContain(target.type.id); expect(graph).not.toContain(f.type.id); expect(graph).not.toContain(f.user.id);
    expect(await db.workflowDefinition.findUniqueOrThrow({ where: { id: rebound.id } })).toMatchObject({ workspaceId: target.workspace.id, boundEntityTypeId: target.type.id });
  });

  it('reconcile command does not double-run completed node', async () => {
    const db = database(), f = await workflowFixture(db);
    const create = node('CREATE', 'ACTION', { actionCode: 'SPA.CREATE_ITEM', input: { typeId: f.type.id, item: { title: 'Reconciled', assignedUserId: f.user.id, fieldValues: {} } } });
    const flow = await f.define({ ...linear(create, node('MARK', 'SET_VARIABLE', { variable: 'NOTE', expression: '"recovered"' })), variables: [typed('NOTE')] });
    const run = await f.start(flow.workflowId);
    // CREATE completes; then a worker claims MARK and dies holding its lease.
    await f.runtime.tick(1); await f.runtime.tick(1);
    await (f.runtime as unknown as { claim(limit: number): Promise<unknown[]> }).claim(1);
    const stuck = (await f.runs(run.executionId, 'MARK'))[0];
    expect(stuck.status).toBe('RUNNING');
    await db.workflowNodeExecution.update({ where: { id: stuck.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    expect((await f.governance.health(f.actor, {})).expiredLeases).toBe(1);
    const key = randomUUID(), job = await f.governance.reconcile(f.actor, { executionIds: [run.executionId] }, key);
    expect(await f.governance.reconcile(f.actor, { executionIds: [run.executionId] }, key)).toEqual(job);
    expect(await f.governance.tick(10)).toMatchObject({ completed: 1 });
    expect((await db.workflowReconciliationJob.findUniqueOrThrow({ where: { id: job.jobId } }))).toMatchObject({ status: 'SUCCEEDED', result: { checked: 1, recovered: 1, uncertain: 0 } });
    await f.drain();
    expect(await f.execution(run.executionId)).toMatchObject({ status: 'COMPLETED', variables: { NOTE: 'recovered' } });
    expect(await f.runs(run.executionId, 'CREATE')).toEqual([expect.objectContaining({ status: 'SUCCEEDED', attemptCount: 1 })]);
    expect(await db.spaItem.count({ where: { workspaceId: f.workspace.id, title: 'Reconciled' } })).toBe(1);
    const again = await f.governance.reconcile(f.actor, { executionIds: [run.executionId] }, randomUUID()); await f.governance.tick(10);
    expect((await db.workflowReconciliationJob.findUniqueOrThrow({ where: { id: again.jobId } })).result).toMatchObject({ recovered: 0 });
    await f.drain();
    expect(await db.spaItem.count({ where: { workspaceId: f.workspace.id, title: 'Reconciled' } })).toBe(1);
    expect(await f.outbox('WORKFLOW_RECONCILIATION_COMPLETED')).toBe(2);
  });
});

export {};
