import { createHmac, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { workflowDatabase, workflowFixture, linear, node, edge, typed, type WorkflowFixture } from '@/tests/support/workflow-contract';
import { stockFixture } from '@/tests/support/inventory-fixture';
import { paymentCommandFixture } from '@/tests/support/payment-command-fixture';
import { CommercePaymentCallbackService } from '@/src/server/commerce/payment-callback-service';
import { CommerceRefundService } from '@/src/server/commerce/refund-service';

/** Child Workflows and explicit Saga compensation through owning Inventory/Commerce services. */
const database = workflowDatabase('truecrm_workflow_compensation_test');
const hold = (key = 'HOLD') => node(key, 'TIMER', { type: 'RELATIVE', seconds: 3600 });
const fire = (db: PrismaClient, executionId: string) => db.workflowTimer.updateMany({ where: { executionId, status: 'PENDING' }, data: { scheduledFor: new Date(Date.now() - 1000) } });
const sub = (workflowId: string, extra: Record<string, unknown> = {}) => node('CHILD', 'SUB_WORKFLOW', { workflowId, inputMapping: {}, outputMapping: {}, waitForCompletion: true, ...extra });
async function cancel(f: WorkflowFixture, executionId: string) {
  return f.executions.control(f.actor, executionId, 'cancel', { expectedVersion: (await f.execution(executionId)).version, reason: 'Customer withdrew' });
}
/** Workflow fixture inside a Commerce Workspace with an authorized (uncaptured) sandbox provider payment. */
async function commerceWorkflow(db: PrismaClient) {
  const p = await paymentCommandFixture(db);
  const f = await workflowFixture(db, { paymentProviders: p.authority, existing: p });
  const command = await p.service.create(p.actor, p.order.id, { methodId: p.method.id, amount: '100', mode: 'AUTHORIZE' }, randomUUID());
  await p.service.process(command.commandId);
  const record = await db.commercialPackRecord.findUniqueOrThrow({ where: { id: command.paymentId } }), transactionId = (record.data as { providerTransactionId: string }).providerTransactionId;
  p.provider.authorize(transactionId);
  // Provider authorization confirmation is the shared Payments fixture state, as in the owning payment-command tests.
  await db.commercialPackRecord.update({ where: { id: command.paymentId }, data: { data: { ...record.data as object, authorizedAmount: '100', financialState: 'AUTHORIZED' } } });
  const callbacks = new CommercePaymentCallbackService(db, undefined, p.authority), refunds = new CommerceRefundService(db, undefined, p.authority);
  const confirmCapture = async () => {
    const raw = JSON.stringify({ id: 'evt_' + randomUUID(), created: Math.floor(Date.now() / 1000), account: 'merchant-test', type: 'payment_intent.succeeded',
      data: { object: { id: transactionId, object: 'payment_intent', status: 'succeeded', amount: 10000, amount_received: 10000, amount_capturable: 0, currency: 'egp' } } });
    const at = Math.floor(Date.now() / 1000), secret = JSON.parse(p.secrets.get('test-payment-bundle')!).webhookSecret;
    const ack = await callbacks.receive('stripe', new Headers({ 'x-payment-connection-id': p.connection.id, 'stripe-signature': 't=' + at + ',v1=' + createHmac('sha256', secret).update(at + '.' + raw).digest('hex') }), raw);
    await db.sharedPaymentProviderEvent.update({ where: { id: ack.eventId }, data: { nextAttemptAt: new Date(Date.now() - 1000) } }); await callbacks.tick();
  };
  const captureFlow = () => f.define(linear(node('CAPTURE', 'ACTION', { actionCode: 'COMMERCE.CAPTURE_PAYMENT', input: { paymentId: command.paymentId, amount: '100' },
    compensation: { actionCode: 'COMMERCE.REQUEST_REFUND', input: { orderId: p.order.id, paymentId: command.paymentId, amount: '100', reason: 'Workflow cancelled' } } }), hold()));
  return { p, f, paymentId: command.paymentId, transactionId, refunds, confirmCapture, captureFlow };
}

describe('Subworkflows, Saga Compensation and Entity Locks — unit/integration contract', () => {
  it('A->B->A recursion rejected at configured depth/ancestry', async () => {
    const db = database(), f = await workflowFixture(db);
    const a = await f.define(linear()), b = await f.define(linear(sub(a.workflowId)));
    const draft = await f.definitions.newVersion(f.actor, a.workflowId, {});
    await expect(f.definitions.editGraph(f.actor, a.workflowId, draft.id, 'REPLACE', { expectedVersion: draft.version, ...linear(sub(a.workflowId)), parameters: [], variables: [], constants: [] }))
      .rejects.toMatchObject({ code: 'WORKFLOW_GRAPH_INVALID', details: { problems: [expect.objectContaining({ code: 'WORKFLOW_RECURSION_LIMIT' })] } });
    const saved = await f.definitions.editGraph(f.actor, a.workflowId, draft.id, 'REPLACE', { expectedVersion: draft.version, ...linear(sub(b.workflowId)), parameters: [], variables: [], constants: [] });
    await f.definitions.publish(f.actor, a.workflowId, draft.id, { expectedVersion: saved.version });
    const run = await f.start(a.workflowId); await f.drain(); await f.waits.children(50); await f.drain();
    const child = await db.workflowExecution.findFirstOrThrow({ where: { definitionId: b.workflowId } });
    expect(child).toMatchObject({ parentExecutionId: run.executionId, depth: 1, status: 'FAILED', resultCode: 'WORKFLOW_RECURSION_LIMIT' });
    expect(child.ancestry).toEqual([a.workflowId, b.workflowId]);
    expect(await db.workflowExecution.count({ where: { definitionId: a.workflowId } })).toBe(1);
    expect(await db.workflowExecution.count({ where: { definitionId: b.workflowId } })).toBe(1);
    expect((await f.execution(run.executionId)).status).toBe('FAILED');
    // A configured depth lower than the chain stops the deepest child.
    await f.triggers.setLimits(f.actor, { maxLoopIterations: 1000, maxNodeRuns: 10000, maxDepth: 1, maxLifetimeDays: 365 });
    const z = await f.define(linear()), y = await f.define(linear(sub(z.workflowId))), x = await f.define(linear(sub(y.workflowId)));
    const other = await f.create('Depth'); const top = await f.start(x.workflowId, {}, randomUUID(), f.actor, other.id); await f.drain();
    expect(await db.workflowExecution.findFirstOrThrow({ where: { definitionId: y.workflowId } })).toMatchObject({ depth: 1, status: 'FAILED', resultCode: 'WORKFLOW_RECURSION_LIMIT' });
    expect(await db.workflowExecution.count({ where: { definitionId: z.workflowId } })).toBe(0);
    expect((await f.execution(top.executionId)).status).toBe('WAITING');
  });

  it('parent wait child completion maps result correctly', async () => {
    const db = database(), f = await workflowFixture(db);
    const cs = node('START', 'START'), ch = hold(), ce = node('END', 'END', { result: 'parameters.INPUT' });
    const child = await f.define({ nodes: [cs, ch, ce], edges: [edge(cs, ch), edge(ch, ce)], parameters: [typed('INPUT', 'TEXT', { required: true })] });
    const parent = await f.define({ ...linear(sub(child.workflowId, { inputMapping: { INPUT: 'entity.title' }, outputMapping: { CHILD_RESULT: 'outputs.CHILD.result' } })), variables: [typed('CHILD_RESULT')] });
    const run = await f.start(parent.workflowId); await f.drain();
    const childRun = await db.workflowExecution.findFirstOrThrow({ where: { parentExecutionId: run.executionId } });
    expect(childRun).toMatchObject({ definitionId: child.workflowId, status: 'WAITING', startedByType: 'WORKFLOW', parameters: { INPUT: 'Case' } });
    expect((await f.execution(run.executionId)).status).toBe('WAITING');
    expect(await f.waits.children(50)).toMatchObject({ resumed: 0 });
    await fire(db, childRun.id); await f.waits.timers(50); await f.drain();
    expect(await f.execution(childRun.id)).toMatchObject({ status: 'COMPLETED', result: 'Case' });
    expect((await f.waits.children(50)).resumed).toBe(1); expect((await f.waits.children(50)).resumed).toBe(0);
    await f.drain();
    expect(await f.execution(run.executionId)).toMatchObject({ status: 'COMPLETED', variables: { CHILD_RESULT: 'Case' } });
    expect(await f.compensations.children(f.actor, run.executionId)).toEqual([expect.objectContaining({ id: childRun.id, status: 'COMPLETED', waitForCompletion: true })]);
    expect(await f.outbox('WORKFLOW_CHILD_STARTED', run.executionId)).toBe(1);
    expect(await f.runs(run.executionId, 'CHILD')).toEqual([expect.objectContaining({ status: 'SUCCEEDED' })]);
  });

  it('nonwaiting parent does not block on child', async () => {
    const db = database(), f = await workflowFixture(db);
    const child = await f.define(linear(hold()));
    const parent = await f.define(linear(sub(child.workflowId, { waitForCompletion: false })));
    const run = await f.start(parent.workflowId); await f.drain();
    const childRun = await db.workflowExecution.findFirstOrThrow({ where: { parentExecutionId: run.executionId } });
    expect((await f.execution(run.executionId)).status).toBe('COMPLETED');
    expect(childRun.status).toBe('WAITING');
    expect((await f.runs(run.executionId, 'CHILD'))[0].output).toEqual({ childExecutionId: childRun.id });
    await fire(db, childRun.id); await f.waits.timers(50); await f.drain();
    expect((await f.waits.children(50)).resumed).toBe(0);
    expect((await f.execution(childRun.id)).status).toBe('COMPLETED');
  });

  it('cancellation compensates reserved stock exactly once', async () => {
    const db = database(), f = await workflowFixture(db), stock = await stockFixture(db, f.actor, { quantity: '5' });
    const reserve = node('RESERVE', 'ACTION', { actionCode: 'INVENTORY.RESERVE', input: { sourceType: 'SPA_ITEM', productId: stock.product.id, quantity: '2', warehouseId: stock.warehouse.id },
      inputExpressions: { sourceId: 'entity.id' }, compensation: { actionCode: 'INVENTORY.RELEASE_RESERVATION', input: { reason: 'Workflow cancelled' }, inputExpressions: { reservationId: 'outputs.RESERVE.entityId' } } });
    const w = await f.define(linear(reserve, hold()));
    const run = await f.start(w.workflowId); await f.drain();
    const reservation = await db.inventoryReservation.findFirstOrThrow({ where: { workspaceId: f.workspace.id, sourceId: f.item.id } });
    expect(await stock.balance()).toEqual({ onHand: 5, reserved: 2 });
    const planned = await f.compensations.list(f.actor, run.executionId);
    expect(planned).toEqual([expect.objectContaining({ actionType: 'INVENTORY.RELEASE_RESERVATION', status: 'PENDING', requested: false })]);
    expect((await f.compensations.tick(20)).completed).toBe(0);
    await cancel(f, run.executionId);
    const results = await Promise.all([f.compensations.tick(20), f.compensations.tick(20)]); await f.compensations.tick(20);
    expect(results.reduce((sum, r) => sum + r.completed, 0)).toBe(1);
    expect(await stock.balance()).toEqual({ onHand: 5, reserved: 0 });
    expect(await db.inventoryReservation.findUniqueOrThrow({ where: { id: reservation.id } })).toMatchObject({ status: 'RELEASED' });
    expect(await db.inventoryReservationHistory.count({ where: { reservationId: reservation.id, action: 'RELEASED' } })).toBe(1);
    expect(await f.outbox('WORKFLOW_COMPENSATION_COMPLETED', run.executionId)).toBe(1);
    // Asking again never re-runs a succeeded inverse.
    await f.compensations.request(f.actor, run.executionId, { reason: 'Again' }, randomUUID()); await f.compensations.tick(20);
    expect(await db.inventoryReservationHistory.count({ where: { reservationId: reservation.id, action: 'RELEASED' } })).toBe(1);
    expect((await f.compensations.list(f.actor, run.executionId))[0]).toMatchObject({ status: 'SUCCEEDED', attemptCount: 1 });
  });

  it('failed refund compensation retains retryable failure evidence', async () => {
    const db = database(), { p, f, paymentId, confirmCapture, captureFlow } = await commerceWorkflow(db);
    const w = await captureFlow(), run = await f.start(w.workflowId); await f.drain();
    const capture = await db.sharedPaymentCommand.findFirstOrThrow({ where: { paymentId, kind: 'CAPTURE' } });
    expect(capture.status).toBe('QUEUED');
    await cancel(f, run.executionId);
    expect(await f.compensations.tick(20)).toMatchObject({ failed: 1, completed: 0 });
    const failed = (await f.compensations.list(f.actor, run.executionId))[0];
    expect(failed).toMatchObject({ actionType: 'COMMERCE.REQUEST_REFUND', status: 'FAILED', errorCode: 'REFUND_AMOUNT_EXCEEDED', attemptCount: 1 });
    expect(await f.outbox('WORKFLOW_COMPENSATION_FAILED', run.executionId)).toBe(1);
    expect((await f.governance.health(f.actor, {})).failedCompensations).toBeGreaterThanOrEqual(1);
    expect(await db.commerceRefundBinding.count({ where: { paymentId } })).toBe(0);
    expect((await f.compensations.tick(20)).candidates).toBe(0);
    // The provider capture settles; an operator retries only the failed inverse.
    await p.service.process(capture.id); await confirmCapture();
    const key = randomUUID();
    await f.compensations.request(f.actor, run.executionId, {}, key, failed.id);
    expect(await f.compensations.request(f.actor, run.executionId, {}, key, failed.id)).toEqual({ executionId: run.executionId, accepted: true });
    expect((await f.compensations.tick(20)).completed).toBe(1);
    expect((await f.compensations.list(f.actor, run.executionId))[0]).toMatchObject({ status: 'SUCCEEDED', attemptCount: 2, errorCode: null });
    expect(await db.commerceRefundBinding.count({ where: { paymentId } })).toBe(1);
    await expect(f.compensations.request(f.actor, run.executionId, {}, randomUUID(), failed.id)).rejects.toMatchObject({ code: 'WORKFLOW_COMPENSATION_UNDEFINED', status: 404 });
  });

  it('compensation without declared inverse action is rejected', async () => {
    const db = database(), f = await workflowFixture(db);
    const create = node('CREATE', 'ACTION', { actionCode: 'SPA.CREATE_ITEM', input: { typeId: f.type.id, item: { title: 'x', assignedUserId: f.user.id, fieldValues: {} } },
      compensation: { actionCode: 'SPA.UPDATE_ITEM', input: {} } });
    await expect(f.define(linear(create))).rejects.toMatchObject({ code: 'WORKFLOW_GRAPH_INVALID', details: { problems: [expect.objectContaining({ code: 'WORKFLOW_COMPENSATION_UNDEFINED' })] } });
    const w = await f.define(linear(hold())), run = await f.start(w.workflowId); await f.drain();
    await expect(f.compensations.request(f.actor, run.executionId, { reason: 'Undo' }, randomUUID())).rejects.toMatchObject({ code: 'WORKFLOW_INVALID_STATE', status: 409 });
    await cancel(f, run.executionId);
    await expect(f.compensations.request(f.actor, run.executionId, { reason: 'Undo' }, randomUUID())).rejects.toMatchObject({ code: 'WORKFLOW_COMPENSATION_UNDEFINED', status: 422 });
    expect(await db.workflowCompensationAction.count({ where: { executionId: run.executionId } })).toBe(0);
    expect(await f.outbox('WORKFLOW_COMPENSATION_REQUESTED', run.executionId)).toBe(0);
  });

  it('simulated provider timeout cannot double-send refund on retry', async () => {
    const db = database(), { p, f, paymentId, refunds, confirmCapture, captureFlow } = await commerceWorkflow(db);
    const w = await captureFlow(), run = await f.start(w.workflowId); await f.drain();
    const capture = await db.sharedPaymentCommand.findFirstOrThrow({ where: { paymentId, kind: 'CAPTURE' } });
    await p.service.process(capture.id); await confirmCapture();
    await cancel(f, run.executionId); expect((await f.compensations.tick(20)).completed).toBe(1);
    const binding = await db.commerceRefundBinding.findFirstOrThrow({ where: { paymentId } });
    // The compensation's stable key is the owning Refund request dedupe record; a replay cannot create a second Refund.
    const inverse = await db.workflowCompensationAction.findFirstOrThrow({ where: { executionId: run.executionId } });
    expect(await db.commerceRefundRequest.count({ where: { workspaceId: f.workspace.id, key: inverse.idempotencyKey } })).toBe(1);
    const replay = await db.$transaction(tx => refunds.createInTransaction(tx, f.actor, p.order.id, { paymentId, amount: '100', reason: 'Workflow cancelled' }, inverse.idempotencyKey)) as { id: string };
    expect(replay.id).toBe(binding.refundId);
    const approver = await f.member();
    const refund = await refunds.get(f.actor, binding.refundId);
    const approved = await refunds.approve(approver.actor, binding.refundId, { expectedVersion: refund.version, decision: 'APPROVE', reason: 'Saga compensation' });
    const ack = await refunds.process(f.actor, binding.refundId, { expectedVersion: approved.version }, randomUUID());
    const original = p.provider.refund.bind(p.provider); let calls = 0;
    p.provider.refund = async input => { calls++; const result = await original(input); if (calls === 1) throw new Error('socket timeout after provider accepted'); return result; };
    expect(await refunds.processCommand(ack.jobId)).toBe(false);
    const uncertain = await db.sharedRefundCommand.findUniqueOrThrow({ where: { id: ack.jobId } });
    expect(uncertain).toMatchObject({ status: 'QUEUED', uncertain: true, lastErrorCode: 'REFUND_PROVIDER_FAILURE' });
    await db.sharedRefundCommand.update({ where: { id: ack.jobId }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    expect(await refunds.processCommand(ack.jobId)).toBe(true);
    expect(calls).toBe(2); expect(p.provider.refundEffects.size).toBe(1);
    expect((await db.sharedRefundCommand.findUniqueOrThrow({ where: { id: ack.jobId } })).status).toBe('WAITING_CONFIRMATION');
    expect(await db.commerceRefundBinding.count({ where: { paymentId } })).toBe(1);
    await expect(f.compensations.request(f.actor, run.executionId, {}, randomUUID(), (await f.compensations.list(f.actor, run.executionId))[0].id))
      .rejects.toMatchObject({ code: 'WORKFLOW_COMPENSATION_UNDEFINED' });
  });
});

export {};
