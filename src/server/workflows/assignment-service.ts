import { Prisma, type PrismaClient, type WorkflowHumanAssignment } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { command, evidence, lock, requirePermission, resolvePrincipal, type Principal, type Tx } from '../process-platform/context';
import { pageQuery, parse, uuid } from '../process-platform/dto';
import { graph, parameterDefinition } from './dto';
import { typedRecord } from './typed-values';
import { WorkflowRuntime } from './runtime';

const decisionInput = z.strictObject({ decision: z.enum(['APPROVE','REJECT','REQUEST_CHANGES']),comment: z.string().max(2000).optional(),fields: z.record(z.string(),z.json()).optional() });
const informationInput = z.strictObject({ values: z.record(z.string(),z.json()) });
export class WorkflowAssignmentService {
  readonly runtime: WorkflowRuntime;
  constructor(private readonly db: PrismaClient, runtime?: WorkflowRuntime) { this.runtime = runtime ?? new WorkflowRuntime(db); }
  private async load(tx: Tx, actor: Principal, id: string, permission: string) {
    parse(uuid,id); requirePermission(actor,permission);
    const row = await tx.workflowHumanAssignment.findFirst({ where: { workspaceId: actor.workspaceId,id } });
    const participant = row ? await tx.workflowAssignmentParticipant.findFirst({ where: { workspaceId: actor.workspaceId,assignmentId: id,effectiveUserId: actor.userId,isActive: true } }) : null;
    if (!row || !participant && !actor.grants.has('WORKFLOW.EXECUTION_ADMIN')) throw new AppError('WORKFLOW_ASSIGNMENT_NOT_FOUND','Assignment was not found.',404);
    const execution = await tx.workflowExecution.findFirstOrThrow({ where: { workspaceId: actor.workspaceId,id: row.executionId } });
    await this.runtime.executions.entities.execution(tx,actor,execution);
    return { row,participant,execution };
  }
  private async lockAssignment(tx: Tx, workspaceId: string, id: string) {
    parse(uuid,id);
    const row = await tx.workflowHumanAssignment.findFirst({ where: { workspaceId,id } });
    if (!row) throw new AppError('WORKFLOW_ASSIGNMENT_NOT_FOUND','Assignment was not found.',404);
    await lock(tx,workspaceId,'workflow:execution:' + row.executionId);
    await lock(tx,workspaceId,'workflow:assignment:' + id);
  }
  private async projection(tx: Tx, actor: Principal, row: WorkflowHumanAssignment) {
    const participants = await tx.workflowAssignmentParticipant.findMany({ where: { workspaceId: actor.workspaceId,assignmentId: row.id,isActive: true } });
    const votes = await tx.workflowApprovalVote.findMany({ where: { workspaceId: actor.workspaceId,assignmentId: row.id } });
    return { id: row.id,executionId: row.executionId,nodeRunId: row.nodeRunId,assignmentType: row.assignmentType,status: row.status,policy: row.policy,
      quorumCount: row.quorumCount,dueAt: row.dueAt,version: row.version,informationSchema: row.informationSchema,
      participants: participants.map(p => ({ userId: p.effectiveUserId,hasDecided: votes.some(v => v.participantId===p.id) })),
      myDecision: votes.find(v => v.assigneeUserId===actor.userId)?.decision ?? null,result: row.result ? { resolved: true } : null };
  }
  async my(actor: Principal, raw: unknown) {
    requirePermission(actor,'WORKFLOW.ASSIGNMENT_VIEW'); const query = parse(pageQuery.extend({ status: z.enum(['PENDING','COMPLETED','CANCELLED','EXPIRED']).optional(),dueBefore: z.iso.datetime({ offset: true }).optional() }),raw);
    return this.db.$transaction(async tx => {
      const participation = await tx.workflowAssignmentParticipant.findMany({ where: { workspaceId: actor.workspaceId,effectiveUserId: actor.userId,isActive: true } });
      const rows = await tx.workflowHumanAssignment.findMany({ where: { workspaceId: actor.workspaceId,id: { in: participation.map(p => p.assignmentId) },
        status: query.status,...(query.dueBefore ? { dueAt: { lte: new Date(query.dueBefore) } } : {}) },orderBy: [{ createdAt: 'desc' },{ id: 'asc' }] });
      const allowed: WorkflowHumanAssignment[] = [];
      for (const row of rows) {
        try { await this.load(tx,actor,row.id,'WORKFLOW.ASSIGNMENT_VIEW'); allowed.push(row); }
        catch (error) { if (!(error instanceof AppError && [403,404].includes(error.status))) throw error; }
      }
      const data = [];
      for (const row of allowed.slice((query.page-1)*query.limit,query.page*query.limit)) data.push(await this.projection(tx,actor,row));
      return { data,meta: { page: query.page,limit: query.limit,total: allowed.length,totalPages: Math.ceil(allowed.length/query.limit) } };
    },{ timeout: 60000 });
  }
  async get(actor: Principal, id: string) {
    return this.db.$transaction(async tx => this.projection(tx,actor,(await this.load(tx,actor,id,'WORKFLOW.ASSIGNMENT_VIEW')).row));
  }
  async decide(actor: Principal, id: string, raw: unknown, key: string | null, information = false) {
    const input = information ? parse(informationInput,raw) : parse(decisionInput,raw); requirePermission(actor,'WORKFLOW.ASSIGNMENT_DECIDE');
    return this.db.$transaction(async tx => {
      await this.lockAssignment(tx,actor.workspaceId,id); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const { row,participant,execution } = await this.load(tx,actor,id,'WORKFLOW.ASSIGNMENT_DECIDE');
      if (!participant) throw new AppError('PERMISSION_DENIED','An effective assignee is required to vote.',403);
      return command(tx,actor,'workflow.assignment.' + (information ? 'information:' : 'decision:') + id,key,input,async () => {
        if (row.status !== 'PENDING' || !['RUNNING','WAITING'].includes(execution.status)) throw new AppError('WORKFLOW_ASSIGNMENT_CLOSED','Assignment cannot receive decisions in this state.',409);
        if (row.dueAt && row.dueAt <= new Date()) throw new AppError('WORKFLOW_ASSIGNMENT_CLOSED','Assignment deadline has elapsed.',409);
        if (information !== (row.assignmentType === 'REQUEST_INFO')) throw new AppError('WORKFLOW_APPROVAL_POLICY_INVALID','Decision does not match the assignment type.',422);
        if (await tx.workflowApprovalVote.findFirst({ where: { workspaceId: actor.workspaceId,assignmentId: id,OR: [{ participantId: participant.id },{ assigneeUserId: actor.userId }] } }))
          throw new AppError('WORKFLOW_APPROVAL_DUPLICATE','A final vote is already recorded.',409);
        const schema = parse(z.array(parameterDefinition),row.informationSchema);
        const fields = information ? typedRecord(schema,(input as z.infer<typeof informationInput>).values)
          : (input as z.infer<typeof decisionInput>).fields ? typedRecord(schema,(input as z.infer<typeof decisionInput>).fields!) : {};
        await this.runtime.executions.entities.validateReferences(tx,actor,fields);
        for (const definition of schema.filter(p => p.datatype==='USER')) if (fields[definition.code]) await resolvePrincipal(tx,actor.workspaceId,String(fields[definition.code]));
        const decision = information ? 'SUBMIT_INFORMATION' : (input as z.infer<typeof decisionInput>).decision;
        await tx.workflowApprovalVote.create({ data: { workspaceId: actor.workspaceId,assignmentId: id,participantId: participant.id,
          assigneeUserId: actor.userId,actedByUserId: actor.userId,decision,comment: !information ? (input as z.infer<typeof decisionInput>).comment : undefined,
          fields: JSON.parse(JSON.stringify(fields)) as Prisma.InputJsonValue } });
        const participants = await tx.workflowAssignmentParticipant.findMany({ where: { workspaceId: actor.workspaceId,assignmentId: id,isActive: true } });
        const votes = await tx.workflowApprovalVote.findMany({ where: { workspaceId: actor.workspaceId,assignmentId: id } });
        const approved = votes.filter(v => ['APPROVE','SUBMIT_INFORMATION'].includes(v.decision)).length, rejected = votes.filter(v => ['REJECT','REQUEST_CHANGES'].includes(v.decision)).length;
        const needed = row.policy==='ANY' ? 1 : row.policy==='QUORUM' ? row.quorumCount! : participants.length;
        const rejectNeeded = row.rejectPolicy==='ALL_REJECT' ? participants.length : row.rejectPolicy==='QUORUM_REJECT' ? needed : 1;
        const rejectedOutcome = rejected>=rejectNeeded, acceptedOutcome = approved>=needed;
        let outcome: string | null = null;
        if (rejectedOutcome) outcome = 'REJECT'; else if (acceptedOutcome) outcome = information ? 'NEXT' : 'APPROVE';
        if (outcome) {
          const result = information ? { values: fields,decision: 'SUBMIT_INFORMATION' } : { decision: outcome,approved,rejected };
          if (!await this.runtime.resumeWait(tx,actor.workspaceId,row.executionId,row.nodeRunId,result,outcome)) throw new AppError('WORKFLOW_ASSIGNMENT_CLOSED','Assignment checkpoint is unavailable.',409);
          await tx.workflowHumanAssignment.update({ where: { id },data: { status: 'COMPLETED',result: result as Prisma.InputJsonValue,version: { increment: 1 } } });
        } else await tx.workflowHumanAssignment.update({ where: { id },data: { version: { increment: 1 } } });
        await tx.workflowAssignmentHistory.create({ data: { workspaceId: actor.workspaceId,assignmentId: id,actorUserId: actor.userId,action: 'DECIDED',metadata: { decision,participantId: participant.id,outcome } } });
        await evidence(tx,actor,'WORKFLOW_ASSIGNMENT',id,'WORKFLOW_ASSIGNMENT_DECIDED',{ executionId: row.executionId,decision,outcome,approved,rejected });
        return { assignmentId: id,status: outcome ? 'COMPLETED' : 'PENDING',decision,outcome,version: row.version+1 };
      });
    },{ timeout: 60000 });
  }
  async delegate(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ toUserId: uuid,reason: z.string().trim().min(1).max(2000) }),raw); requirePermission(actor,'WORKFLOW.ASSIGNMENT_DELEGATE');
    return this.db.$transaction(async tx => {
      await this.lockAssignment(tx,actor.workspaceId,id); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const { row,participant,execution } = await this.load(tx,actor,id,'WORKFLOW.ASSIGNMENT_DELEGATE');
      if (!participant || row.status!=='PENDING' || !['RUNNING','WAITING'].includes(execution.status)) throw new AppError('WORKFLOW_DELEGATE_INVALID','Only an open effective assignment can be delegated.',409);
      if (input.toUserId===actor.userId || await tx.workflowAssignmentParticipant.findFirst({ where: { workspaceId: actor.workspaceId,assignmentId: id,effectiveUserId: input.toUserId,isActive: true } }) ||
        await tx.workflowApprovalVote.findFirst({ where: { workspaceId: actor.workspaceId,assignmentId: id,OR: [{ participantId: participant.id },{ assigneeUserId: input.toUserId }] } }))
        throw new AppError('WORKFLOW_DELEGATE_INVALID','Delegation cannot duplicate a participant or change a final vote.',409);
      const next = await resolvePrincipal(tx,actor.workspaceId,input.toUserId); requirePermission(next,'WORKFLOW.ASSIGNMENT_VIEW'); requirePermission(next,'WORKFLOW.ASSIGNMENT_DECIDE');
      await this.runtime.executions.entities.execution(tx,next,execution);
      await tx.workflowAssignmentParticipant.update({ where: { id: participant.id },data: { effectiveUserId: next.userId } });
      await tx.workflowHumanAssignment.update({ where: { id },data: { version: { increment: 1 } } });
      await tx.workflowAssignmentHistory.create({ data: { workspaceId: actor.workspaceId,assignmentId: id,actorUserId: actor.userId,action: 'DELEGATED',
        metadata: { fromUserId: actor.userId,toUserId: next.userId,originalUserId: participant.originalUserId,reason: input.reason } } });
      await evidence(tx,actor,'WORKFLOW_ASSIGNMENT',id,'WORKFLOW_ASSIGNMENT_DELEGATED',{ fromUserId: actor.userId,toUserId: next.userId });
      return { assignmentId: id,toUserId: next.userId,version: row.version+1 };
    },{ timeout: 60000 });
  }
  async history(actor: Principal, id: string, raw: unknown) {
    const query = parse(pageQuery,raw);
    return this.db.$transaction(async tx => {
      await this.load(tx,actor,id,'WORKFLOW.ASSIGNMENT_VIEW'); const where = { workspaceId: actor.workspaceId,assignmentId: id };
      const [rows,total] = await Promise.all([tx.workflowAssignmentHistory.findMany({ where,orderBy: [{ occurredAt: 'asc' },{ id: 'asc' }],skip: (query.page-1)*query.limit,take: query.limit }),tx.workflowAssignmentHistory.count({ where })]);
      return { data: rows,meta: { page: query.page,limit: query.limit,total,totalPages: Math.ceil(total/query.limit) } };
    });
  }
}
