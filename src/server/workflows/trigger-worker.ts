import { Prisma,type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppError,isAppError } from '../errors';
import { evidence,lock,resolvePrincipal } from '../process-platform/context';
import { parse,uuid } from '../process-platform/dto';
import { compileExpression,evaluateExpression } from './expression';
import { eventConfig,scheduleConfig,nextWorkflowSchedule,WorkflowTriggerService } from './trigger-service';
import { WorkflowRuntime } from './runtime';

/** Independent outbox consumer. It never consumes another module's delivery cursor. */
export class WorkflowTriggerWorker {
  constructor(private readonly db: PrismaClient, readonly runtime = new WorkflowRuntime(db), readonly triggers = new WorkflowTriggerService(db,runtime.executions)) {}
  private async enqueueEvents(limit: number) {
    await this.db.$executeRaw`
      INSERT INTO workflow_event_deliveries(id,workspace_id,event_id,status,attempts,next_attempt_at,created_at)
      SELECT gen_random_uuid(),e.workspace_id,e.id,'QUEUED',0,now(),now() FROM outbox_events e
      WHERE NOT EXISTS (SELECT 1 FROM workflow_event_deliveries d WHERE d.workspace_id=e.workspace_id AND d.event_id=e.id)
        AND (EXISTS (SELECT 1 FROM workflow_triggers t JOIN workflow_definitions w ON w.workspace_id=t.workspace_id AND w.id=t.definition_id
          WHERE t.workspace_id=e.workspace_id AND t.enabled AND t.type='EVENT' AND t.created_at<=e.occurred_at AND w.status='ACTIVE'
            AND w.bound_entity_type=e.entity_type AND t.configuration_json->>'eventType'=e.event_type)
          OR EXISTS (SELECT 1 FROM workflow_event_subscriptions s WHERE s.workspace_id=e.workspace_id AND s.status='PENDING' AND s.created_at<=e.occurred_at AND s.event_type=e.event_type))
      ORDER BY e.occurred_at,e.id LIMIT ${limit}
      ON CONFLICT (workspace_id,event_id) DO NOTHING`;
  }
  async events(limit = 20) {
    await this.enqueueEvents(limit);
    const token = randomUUID();
    const jobs = await this.db.$queryRaw<Array<{ id: string; workspace_id: string; event_id: string }>>`
      WITH due AS (SELECT id FROM workflow_event_deliveries WHERE (status='QUEUED' AND next_attempt_at<=now())
        OR (status='RUNNING' AND lease_expires_at<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT ${limit})
      UPDATE workflow_event_deliveries d SET status='RUNNING',claim_token=${token}::uuid,lease_expires_at=now()+interval '5 minutes'
      FROM due WHERE d.id=due.id RETURNING d.id,d.workspace_id,d.event_id`;
    let completed = 0,failed = 0;
    for (const claimed of jobs) try {
      const event = await this.db.outboxEvent.findFirstOrThrow({ where: { workspaceId: claimed.workspace_id,id: claimed.event_id } });
      const correlation = event.payload && typeof event.payload==='object' && !Array.isArray(event.payload) && typeof event.payload.correlationKey==='string'
        ? event.payload.correlationKey : event.entityId;
      const waits = await this.db.workflowEventSubscription.findMany({ where: { workspaceId: event.workspaceId,status: 'PENDING',eventType: event.eventType,
        correlationKey: correlation,createdAt: { lte: event.occurredAt },OR: [{ expiresAt: null },{ expiresAt: { gt: new Date() } }] } });
      let resumed = 0,started = 0,denied = 0;
      for (const candidate of waits) {
        const done = await this.db.$transaction(async tx => {
          await lock(tx,event.workspaceId,'workflow:execution:' + candidate.executionId);
          const wait = await tx.workflowEventSubscription.findFirst({ where: { workspaceId: event.workspaceId,id: candidate.id,status: 'PENDING' } });
          if (!wait || !await this.runtime.resumeWait(tx,event.workspaceId,wait.executionId,wait.nodeRunId,{ eventId: event.id,eventType: event.eventType })) return false;
          await tx.workflowEventSubscription.update({ where: { id: wait.id },data: { status: 'FULFILLED',fulfilledByEventId: event.id } });
          const execution = await tx.workflowExecution.findUniqueOrThrow({ where: { id: wait.executionId } });
          const actor = await resolvePrincipal(tx,event.workspaceId,execution.executionUserId);
          await evidence(tx,actor,'WORKFLOW_EXECUTION',execution.id,'WORKFLOW_WAIT_RESUMED',{ eventId: event.id,nodeRunId: wait.nodeRunId }); return true;
        },{ timeout: 60000 });
        if (done) resumed++;
      }
      const candidates = await this.db.workflowTrigger.findMany({ where: { workspaceId: event.workspaceId,type: 'EVENT',enabled: true,createdAt: { lte: event.occurredAt } },orderBy: [{ priority: 'asc' },{ id: 'asc' }] });
      for (const candidate of candidates) {
        const config = parse(eventConfig,candidate.configuration); if (config.eventType!==event.eventType) continue;
        try {
          const done = await this.db.$transaction(async tx => {
            await lock(tx,event.workspaceId,'workflow:starts'); await lock(tx,event.workspaceId,'workflow:' + candidate.definitionId);
            const trigger = await tx.workflowTrigger.findFirst({ where: { workspaceId: event.workspaceId,id: candidate.id,revision: candidate.revision,enabled: true } });
            const definition = await tx.workflowDefinition.findFirst({ where: { workspaceId: event.workspaceId,id: candidate.definitionId,status: 'ACTIVE',boundEntityType: event.entityType } });
            if (!trigger || !definition) return false;
            const actorId = definition.runAs==='SERVICE_ACCOUNT' ? definition.serviceAccountUserId : event.actorUserId;
            if (!actorId) return false;
            const actor = await resolvePrincipal(tx,event.workspaceId,actorId);
            const entity = await this.runtime.executions.entities.read(tx,actor,event.entityType,event.entityId,definition.boundEntityTypeId ?? undefined);
            if (config.condition && evaluateExpression(compileExpression(config.condition),{ entity,parameters: config.parameters,variables: {},constants: {},outputs: {},actor: { id: actor.userId },now: event.occurredAt.toISOString(),iteration: {} })!==true) return false;
            const sourceId = event.causationId && uuid.safeParse(event.causationId).success ? event.causationId : null;
            const parent = sourceId ? await tx.workflowExecution.findFirst({ where: { workspaceId: event.workspaceId,id: sourceId } }) : null;
            await this.runtime.executions.startInTransaction(tx,actor,definition.id,{ entityType: event.entityType,entityId: event.entityId,parameters: config.parameters },
              'workflow.event:' + trigger.id + ':' + event.id,parent ? { executionId: parent.id,depth: parent.depth,ancestry: parent.ancestry as string[] } : undefined,{ type: 'EVENT',id: event.id }); return true;
          },{ timeout: 60000 });
          if (done) started++;
        } catch (error) {
          if (isAppError(error) && error.status<500) denied++; else throw error;
        }
      }
      const result = await this.db.workflowEventDelivery.updateMany({ where: { workspaceId: claimed.workspace_id,id: claimed.id,status: 'RUNNING',claimToken: token },
        data: { status: 'SUCCEEDED',result: { resumed,started,denied },claimToken: null,leaseExpiresAt: null,errorCode: null } });
      if (result.count) completed++;
    } catch (error) {
      const current = await this.db.workflowEventDelivery.findFirst({ where: { workspaceId: claimed.workspace_id,id: claimed.id,claimToken: token } });
      if (!current) continue;
      const attempts = current.attempts+1;
      await this.db.workflowEventDelivery.updateMany({ where: { workspaceId: current.workspaceId,id: current.id,claimToken: token,status: 'RUNNING' },data: {
        status: attempts>=5 || isAppError(error) && error.status<500 ? 'FAILED' : 'QUEUED',attempts,errorCode: isAppError(error) ? error.code : 'WORKFLOW_NODE_FAILED',
        claimToken: null,leaseExpiresAt: null,nextAttemptAt: new Date(Date.now()+Math.min(3600000,30000*2**attempts)) } }); failed++;
    }
    return { claimed: jobs.length,completed,failed };
  }
  async schedules(limit = 10) {
    const candidates = await this.db.workflowTrigger.findMany({ where: { type: 'SCHEDULE',enabled: true,nextScheduledAt: { lte: new Date() },
      OR: [{ nextAttemptAt: null },{ nextAttemptAt: { lte: new Date() } }] },orderBy: [{ nextScheduledAt: 'asc' },{ id: 'asc' }],take: limit });
    let started = 0,failed = 0;
    for (const candidate of candidates) try {
      const done = await this.db.$transaction(async tx => {
        await lock(tx,candidate.workspaceId,'workflow:starts'); await lock(tx,candidate.workspaceId,'workflow:' + candidate.definitionId);
        const trigger = await tx.workflowTrigger.findFirst({ where: { workspaceId: candidate.workspaceId,id: candidate.id,enabled: true,revision: candidate.revision,nextScheduledAt: candidate.nextScheduledAt } });
        if (!trigger?.nextScheduledAt) return false;
        const definition = await tx.workflowDefinition.findFirstOrThrow({ where: { workspaceId: trigger.workspaceId,id: trigger.definitionId } });
        const config = parse(scheduleConfig,trigger.configuration);
        const next = nextWorkflowSchedule(config,definition.status==='ACTIVE' ? trigger.nextScheduledAt : new Date());
        if (definition.status!=='ACTIVE') { await tx.workflowTrigger.update({ where: { id: trigger.id },data: { nextScheduledAt: next,enabled: next!==null } }); return false; }
        const actor = await resolvePrincipal(tx,trigger.workspaceId,definition.runAs==='SERVICE_ACCOUNT' && definition.serviceAccountUserId ? definition.serviceAccountUserId : definition.createdByUserId);
        await this.runtime.executions.startInTransaction(tx,actor,definition.id,{ entityType: definition.boundEntityType,entityId: config.entityId,parameters: config.parameters },
          'workflow.schedule:' + trigger.id + ':' + trigger.nextScheduledAt.toISOString(),undefined,{ type: 'SCHEDULE',id: trigger.id });
        await tx.workflowTrigger.update({ where: { id: trigger.id },data: { nextScheduledAt: next,enabled: next!==null,failureCount: 0,lastErrorCode: null,nextAttemptAt: null } }); return true;
      },{ timeout: 60000 });
      if (done) started++;
    } catch (error) {
      const failures = candidate.failureCount+1;
      await this.db.workflowTrigger.updateMany({ where: { workspaceId: candidate.workspaceId,id: candidate.id,revision: candidate.revision,nextScheduledAt: candidate.nextScheduledAt },data: {
        failureCount: failures,lastErrorCode: isAppError(error) ? error.code : 'WORKFLOW_SCHEDULE_INVALID',enabled: failures<5,
        nextAttemptAt: new Date(Date.now()+Math.min(3600000,30000*2**failures)) } }); failed++;
    }
    return { candidates: candidates.length,started,failed };
  }
}
