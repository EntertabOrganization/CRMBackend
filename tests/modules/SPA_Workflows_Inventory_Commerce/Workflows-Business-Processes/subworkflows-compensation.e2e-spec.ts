import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { workflowHttpContract } from '@/tests/support/workflow-http-contract';
import { linear, node } from '@/tests/support/workflow-graph';
import type { WorkflowFixture } from '@/tests/support/workflow-contract';

/** Real Nest + Next HTTP contracts against an owned migrated database. */
async function reserved(f: WorkflowFixture, db: PrismaClient) {
  const { stockFixture } = await import('@/tests/support/inventory-fixture');
  const stock = await stockFixture(db, f.actor, { quantity: '5' });
  const reserve = node('RESERVE', 'ACTION', { actionCode: 'INVENTORY.RESERVE', input: { sourceType: 'SPA_ITEM', productId: stock.product.id, quantity: '1', warehouseId: stock.warehouse.id },
    inputExpressions: { sourceId: 'entity.id' }, compensation: { actionCode: 'INVENTORY.RELEASE_RESERVATION', input: { reason: 'Saga' }, inputExpressions: { reservationId: 'outputs.RESERVE.entityId' } } });
  const w = await f.define(linear(reserve, node('HOLD', 'TIMER', { type: 'RELATIVE', seconds: 3600 }))), run = await f.start(w.workflowId); await f.drain();
  const cancel = async () => f.executions.control(f.actor, run.executionId, 'cancel', { expectedVersion: (await f.execution(run.executionId)).version, reason: 'Stop' });
  return { stock, run, cancel };
}
const contract = workflowHttpContract('truecrm_workflow_compensation_http_test', {
  'GET /api/v1/workflow-executions/:executionId/children': async (f, db) => {
    const child = await f.define(linear(node('HOLD', 'TIMER', { type: 'RELATIVE', seconds: 3600 })));
    const parent = await f.define(linear(node('CHILD', 'SUB_WORKFLOW', { workflowId: child.workflowId, inputMapping: {}, outputMapping: {}, waitForCompletion: false })));
    const run = await f.start(parent.workflowId); await f.drain();
    const childRun = await db.workflowExecution.findFirstOrThrow({ where: { parentExecutionId: run.executionId } });
    return { permission: 'WORKFLOW.EXECUTION_VIEW', ids: { executionId: run.executionId },
      verify: async data => { expect(data).toEqual([expect.objectContaining({ id: childRun.id, workflowId: child.workflowId, status: 'WAITING', waitForCompletion: false })]); } }; },
  'GET /api/v1/workflow-executions/:executionId/compensations': async (f, db) => { const { run } = await reserved(f, db);
    return { permission: 'WORKFLOW.EXECUTION_VIEW', ids: { executionId: run.executionId },
      verify: async data => { expect(data).toEqual([expect.objectContaining({ actionType: 'INVENTORY.RELEASE_RESERVATION', status: 'PENDING', requested: false, sequence: 0 })]); } }; },
  'POST /api/v1/workflow-executions/:executionId/compensate': async (f, db) => { const { run, cancel } = await reserved(f, db);
    await cancel();
    return { permission: 'WORKFLOW.EXECUTION_ADMIN', ids: { executionId: run.executionId }, body: { reason: 'Customer withdrew' },
      verify: async data => { expect(data).toEqual({ executionId: run.executionId, accepted: true });
        expect(await db.workflowCompensationAction.findFirstOrThrow({ where: { executionId: run.executionId } })).toMatchObject({ requested: true, status: 'PENDING' });
        expect(await db.outboxEvent.count({ where: { entityId: run.executionId, eventType: 'WORKFLOW_COMPENSATION_REQUESTED' } })).toBe(1); } }; },
  'POST /api/v1/workflow-executions/:executionId/compensations/:actionId/retry': async (f, db) => { const { stock, run, cancel } = await reserved(f, db);
    const reservation = await db.inventoryReservation.findFirstOrThrow({ where: { workspaceId: f.workspace.id } });
    // The reservation is released out of band, so the declared inverse fails and stays visible for retry.
    await stock.reservations.release(f.actor, reservation.id, { reason: 'Manual release' }, randomUUID());
    await cancel(); await f.compensations.tick(20);
    const failed = await db.workflowCompensationAction.findFirstOrThrow({ where: { executionId: run.executionId } });
    expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'RESERVATION_EXPIRED' });
    return { permission: 'WORKFLOW.EXECUTION_ADMIN', ids: { executionId: run.executionId, actionId: failed.id }, body: {},
      verify: async data => { expect(data).toEqual({ executionId: run.executionId, accepted: true });
        expect(await db.workflowCompensationAction.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({ status: 'PENDING', requested: true, errorCode: null }); } }; },
});

describe('Subworkflows, Saga Compensation and Entity Locks — REST E2E contract', () => {
  it('GET /api/v1/workflow-executions/:executionId/children verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflow-executions/:executionId/children'); });
  it('GET /api/v1/workflow-executions/:executionId/compensations verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/workflow-executions/:executionId/compensations'); });
  it('POST /api/v1/workflow-executions/:executionId/compensate verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflow-executions/:executionId/compensate'); });
  it('POST /api/v1/workflow-executions/:executionId/compensations/:actionId/retry verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/workflow-executions/:executionId/compensations/:actionId/retry'); });
});

export {};
