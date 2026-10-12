import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { assertVersion,evidence,lock,requirePermission,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { parse,uuid,version,timezone } from '../process-platform/dto';
import { graph,limits } from './dto';
import { compileExpression } from './expression';
import { typedRecord } from './typed-values';
import { WorkflowExecutionService } from './execution-service';
import { validateRecurrence,expandRecurrence,wallClockOf,type RecurrenceDefinition } from '../collab/calendar/recurrence-engine';

export const scheduleConfig = z.strictObject({ rrule: z.string().min(1).max(2000),timeZone: timezone,startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).optional(),entityId: uuid,parameters: z.record(z.string(),z.json()).default({}) });
export const eventConfig = z.strictObject({ eventType: z.string().regex(/^[A-Z][A-Z0-9_.]{1,100}$/),condition: z.string().max(4000).optional(),
  parameters: z.record(z.string(),z.json()).default({}) });
const trigger = z.discriminatedUnion('type',[z.strictObject({ type: z.literal('MANUAL'),enabled: z.boolean().default(true) }),
  z.strictObject({ type: z.literal('EVENT'),enabled: z.boolean().default(true),priority: z.number().int().min(0).max(1000).default(0),config: eventConfig }),
  z.strictObject({ type: z.literal('SCHEDULE'),enabled: z.boolean().default(true),config: scheduleConfig })]);
export function workflowSchedule(config: z.infer<typeof scheduleConfig>): RecurrenceDefinition {
  if (config.endsAt && new Date(config.endsAt)<=new Date(config.startsAt) || !/FREQ=(?:MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)(?:;|$)/.test(config.rrule))
    throw new AppError('WORKFLOW_SCHEDULE_INVALID','Schedule bounds or frequency are invalid.',422);
  try { return validateRecurrence({ rruleText: config.rrule,sourceTimezone: config.timeZone,dtstartLocal: wallClockOf(new Date(config.startsAt),config.timeZone),isAllDay: false }); }
  catch { throw new AppError('WORKFLOW_SCHEDULE_INVALID','Schedule is invalid.',422); }
}
export function nextWorkflowSchedule(config: z.infer<typeof scheduleConfig>, after?: Date) {
  const result = expandRecurrence(workflowSchedule(config),{ limit: 1,...(after ? { after: wallClockOf(after,config.timeZone) } : {}) })[0]?.startAt ?? null;
  return result && config.endsAt && result>new Date(config.endsAt) ? null : result;
}
export class WorkflowTriggerService {
  constructor(private readonly db: PrismaClient, readonly executions = new WorkflowExecutionService(db)) {}
  async get(actor: Principal, workflowId: string) {
    return this.db.$transaction(async tx => {
      const definition = await this.executions.definitions.definition(tx,actor,workflowId,'WORKFLOW.VIEW');
      const rows = await tx.workflowTrigger.findMany({ where: { workspaceId: actor.workspaceId,definitionId: workflowId },orderBy: [{ priority: 'asc' },{ id: 'asc' }] });
      return { version: definition.version,triggers: rows.map(row => ({ id: row.id,type: row.type,enabled: row.enabled,priority: row.priority,
        config: row.configuration,revision: row.revision,nextScheduledAt: row.nextScheduledAt,failureCount: row.failureCount,lastErrorCode: row.lastErrorCode })) };
    });
  }
  async update(actor: Principal, workflowId: string, raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion: version,triggers: z.array(trigger).max(100) }),raw); requirePermission(actor,'WORKFLOW.DESIGN');
    if (input.triggers.filter(t => t.type==='MANUAL').length>1) throw new AppError('WORKFLOW_SCHEDULE_INVALID','Only one manual policy is allowed.',422);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'workflow:' + workflowId); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const definition = await this.executions.definitions.definition(tx,actor,workflowId,'WORKFLOW.DESIGN'); assertVersion(definition.version,input.expectedVersion);
      if (definition.status==='ARCHIVED') throw new AppError('WORKFLOW_ARCHIVED','Archived Workflow triggers are read only.',409);
      for (const candidate of input.triggers) {
        if (candidate.type==='EVENT' && candidate.config.condition) compileExpression(candidate.config.condition);
        if (candidate.type==='SCHEDULE') {
          workflowSchedule(candidate.config);
          const executor = definition.runAs==='SERVICE_ACCOUNT' && definition.serviceAccountUserId ? await resolvePrincipal(tx,actor.workspaceId,definition.serviceAccountUserId) : actor;
          requirePermission(executor,'WORKFLOW.START');
          await this.executions.entities.read(tx,executor,definition.boundEntityType,candidate.config.entityId,definition.boundEntityTypeId ?? undefined);
          if (definition.currentVersionId) {
            const publication = await tx.workflowVersion.findFirstOrThrow({ where: { workspaceId: actor.workspaceId,id: definition.currentVersionId } });
            const parameters = typedRecord(parse(graph,publication.definition).parameters,candidate.config.parameters);
            await this.executions.entities.validateReferences(tx,executor,parameters);
          }
        }
      }
      await tx.workflowTrigger.deleteMany({ where: { workspaceId: actor.workspaceId,definitionId: workflowId } });
      for (const candidate of input.triggers) {
        const config = candidate.type==='MANUAL' ? {} : candidate.config;
        await tx.workflowTrigger.create({ data: { workspaceId: actor.workspaceId,definitionId: workflowId,type: candidate.type,enabled: candidate.enabled,
          priority: candidate.type==='EVENT' ? candidate.priority : 0,configuration: JSON.parse(JSON.stringify(config)) as Prisma.InputJsonValue,revision: definition.version+1,
          nextScheduledAt: candidate.type==='SCHEDULE' && candidate.enabled ? nextWorkflowSchedule(candidate.config,new Date(Date.now()-1)) : undefined } });
      }
      await tx.workflowDefinition.update({ where: { id: workflowId },data: { version: { increment: 1 } } });
      await evidence(tx,actor,'WORKFLOW_DEFINITION',workflowId,'WORKFLOW_TRIGGERS_CHANGED',{ version: definition.version+1,count: input.triggers.length },false);
      await tx.auditLog.create({ data: { workspaceId: actor.workspaceId,actorUserId: actor.userId,entityType: 'WORKFLOW_DEFINITION',entityId: workflowId,
        action: 'WORKFLOW_TRIGGERS_CHANGED',afterData: { version: definition.version+1,triggers: JSON.parse(JSON.stringify(input.triggers)) as Prisma.InputJsonValue } } });
      return { version: definition.version+1 };
    },{ timeout: 60000 });
  }
  async waits(actor: Principal, executionId: string) {
    return this.db.$transaction(async tx => {
      await this.executions.load(tx,actor,executionId);
      const [timers,events] = await Promise.all([tx.workflowTimer.findMany({ where: { workspaceId: actor.workspaceId,executionId,status: { in: ['PENDING','PAUSED'] } } }),
        tx.workflowEventSubscription.findMany({ where: { workspaceId: actor.workspaceId,executionId,status: 'PENDING' } })]);
      return { timers: timers.map(t => ({ id: t.id,nodeRunId: t.nodeRunId,type: t.type,status: t.status,scheduledFor: t.scheduledFor,remainingSeconds: t.remainingSeconds })),
        events: events.map(e => ({ id: e.id,nodeRunId: e.nodeRunId,eventType: e.eventType,status: e.status,expiresAt: e.expiresAt })) };
    });
  }
  async runtimeLimits(actor: Principal) {
    requirePermission(actor,'WORKFLOW.RUNTIME_MANAGE',true);
    const policy = await this.db.workflowRuntimePolicy.findUnique({ where: { workspaceId: actor.workspaceId } });
    return { maxLoopIterations: policy?.maxLoopIterations ?? 1000,maxNodeRuns: policy?.maxNodeRuns ?? 10000,maxDepth: policy?.maxDepth ?? 10,
      maxLifetimeDays: policy?.maxLifetimeDays ?? 365,maxConcurrentExecutions: policy?.maxConcurrentExecutions ?? 100,retentionDays: policy?.retentionDays ?? 365,version: policy?.version ?? 0 };
  }
  async setLimits(actor: Principal, raw: unknown) {
    requirePermission(actor,'WORKFLOW.RUNTIME_MANAGE',true); const input = parse(limits,raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'workflow:runtime-policy'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'WORKFLOW.RUNTIME_MANAGE',true);
      const row = await tx.workflowRuntimePolicy.upsert({ where: { workspaceId: actor.workspaceId },create: { workspaceId: actor.workspaceId,...input },update: { ...input,version: { increment: 1 } } });
      await evidence(tx,actor,'WORKFLOW_RUNTIME_POLICY',row.id,'WORKFLOW_RUNTIME_POLICY_CHANGED',{ ...input,version: row.version }); return row;
    });
  }
}
