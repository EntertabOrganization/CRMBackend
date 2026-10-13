import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError,isAppError } from '../errors';
import { lock,requirePermission,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { parse,uuid } from '../process-platform/dto';
import { hydrateState,persistStateInTransaction } from '../persistence';
import { InMemoryStore } from '../store';
import { AccessService } from '../access-service';
import { RealtimeHub } from '../realtime';
import { createCrmFieldEntityRegistry } from '../fields/entity-registry';
import { ActivityAccessPolicy } from './activity-access';
import { TimelineService } from './timeline-service';
import { WorkflowExecutionService } from '../workflows/execution-service';
import { ownerVisible } from '../process-platform/owner-scope';

const commentInput = z.strictObject({ body: z.string().max(10000),fileIds: z.array(uuid).max(20).optional(),mentions: z.array(uuid).max(50).optional(),linkedActivityId: uuid.optional() });
const editInput = z.strictObject({ body: z.string().max(10000).optional(),fileIds: z.array(uuid).max(20).optional(),mentions: z.array(uuid).max(50).optional(),expectedVersion: z.number().int().positive() });
export class ResourceTimelineService {
  readonly executions: WorkflowExecutionService;
  constructor(private readonly db: PrismaClient,executions?: WorkflowExecutionService) { this.executions = executions ?? new WorkflowExecutionService(db); }
  async recognizesComment(id: string) {
    if (!uuid.safeParse(id).success) return false;
    return Boolean(await this.db.crmTimelineComment.count({ where: { id,entityType: 'WORKFLOW_EXECUTION' } }));
  }
  private async context(tx: Tx,actor: Principal,id: string,mentions: string[] = []) {
    const execution = await this.executions.load(tx,actor,id);
    const allowed = new Set<string>();
    for (const userId of mentions) try {
      const recipient = await resolvePrincipal(tx,actor.workspaceId,userId); requirePermission(recipient,'timeline.read');
      const target = await this.executions.load(tx,recipient,id);
      if (await ownerVisible(tx,recipient,target.startedByUserId,'timeline.read')) allowed.add(userId);
    } catch (error) { if (!isAppError(error) || ![403,404].includes(error.status)) throw error; }
    const before = await hydrateState(tx),store = new InMemoryStore(structuredClone(before)),access = new AccessService(store),registry = createCrmFieldEntityRegistry(store,access),realtime = new RealtimeHub();
    const user = store.state.users.find(u => u.id===actor.userId && u.status==='ACTIVE' && !u.isDeleted)!;
    const references = await this.executions.entities.references(tx,actor);
    const timeline = new TimelineService(store,access,registry,new ActivityAccessPolicy(store,access),realtime,() => ({ check: (workspaceId,principal,fileId) => workspaceId===actor.workspaceId && principal.user.id===actor.userId ? references.checkFile(fileId) : 'FORBIDDEN' }));
    const targetMatches = (principal: { workspaceId: string },targetId: string) => principal.workspaceId===actor.workspaceId && targetId===id;
    timeline.registerTargetAuthority('WORKFLOW_EXECUTION',(principal,targetId) => targetMatches(principal,targetId) && principal.user.id===actor.userId,
      (principal,targetId) => targetMatches(principal,targetId) && allowed.has(principal.user.id));
    return { before,store,timeline,user,execution };
  }
  async reference(actor: Principal,id: string) {
    return this.db.$transaction(async tx => {
      actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'timeline.read');
      const row = await this.executions.load(tx,actor,id);
      if (!await ownerVisible(tx,actor,row.startedByUserId,'timeline.read')) throw new AppError('TIMELINE_ACCESS_FORBIDDEN','Timeline scope does not cover this resource.',403);
      return { provider: 'TIMELINE',sharedDiscussionId: id,entityType: 'WORKFLOW_EXECUTION',entityId: id,href: '/api/v1/crm/WORKFLOW_EXECUTION/'+id+'/timeline' };
    },{ timeout: 60000 });
  }
  async read(actor: Principal,id: string,query: Record<string,string>) {
    return this.db.$transaction(async tx => {
      actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'timeline.read');
      const row = await this.executions.load(tx,actor,id);
      if (!await ownerVisible(tx,actor,row.startedByUserId,'timeline.read')) throw new AppError('TIMELINE_ACCESS_FORBIDDEN','Timeline scope does not cover this resource.',403);
      const owner = await this.context(tx,actor,id); return owner.timeline.getTimeline(owner.user,actor.workspaceId,'WORKFLOW_EXECUTION',id,new URLSearchParams(query));
    },{ timeout: 60000 });
  }
  async create(actor: Principal,id: string,raw: unknown,key: string|null) {
    const input = parse(commentInput,raw); if (!key || key.length<8 || key.length>128) throw new AppError('INVALID_ARGUMENT','Idempotency-Key must contain 8 to 128 characters.',400);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'shared:timeline:WORKFLOW_EXECUTION:'+id);
      actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'timeline.comment');
      const row = await this.executions.load(tx,actor,id);
      if (!await ownerVisible(tx,actor,row.startedByUserId,'timeline.comment')) throw new AppError('TIMELINE_ACCESS_FORBIDDEN','Comment scope does not cover this resource.',403);
      const owner = await this.context(tx,actor,id,input.mentions),result = await owner.timeline.createComment(owner.user,actor.workspaceId,'WORKFLOW_EXECUTION',id,input,key);
      await persistStateInTransaction(tx,owner.before,owner.store.state); return result;
    },{ timeout: 60000 });
  }
  async comment(actor: Principal,commentId: string,action: 'READ'|'EDIT'|'DELETE',raw: unknown = {}) {
    parse(uuid,commentId); const input = action==='EDIT' ? parse(editInput,raw) : parse(z.strictObject({}),raw);
    return this.db.$transaction(async tx => {
      const row = await tx.crmTimelineComment.findFirst({ where: { workspaceId: actor.workspaceId,id: commentId,entityType: 'WORKFLOW_EXECUTION' } });
      if (!row) throw new AppError('TIMELINE_COMMENT_NOT_FOUND','Comment was not found.',404);
      await lock(tx,actor.workspaceId,'shared:timeline:WORKFLOW_EXECUTION:'+row.entityId);
      actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,action==='READ' ? 'timeline.read' : action==='EDIT' ? 'timeline.comment_edit' : 'timeline.comment_delete');
      if (action!=='READ' && !await ownerVisible(tx,actor,row.authorUserId,action==='EDIT' ? 'timeline.comment_edit' : 'timeline.comment_delete')) throw new AppError(action==='EDIT' ? 'TIMELINE_COMMENT_EDIT_FORBIDDEN' : 'TIMELINE_COMMENT_DELETE_FORBIDDEN','Comment scope does not cover this author.',403);
      const mentions = 'mentions' in input ? input.mentions as string[]|undefined : undefined;
      const owner = await this.context(tx,actor,row.entityId,mentions);
      if (action==='READ' && !await ownerVisible(tx,actor,owner.execution.startedByUserId,'timeline.read')) throw new AppError('TIMELINE_ACCESS_FORBIDDEN','Timeline scope does not cover this resource.',403);
      if (action==='DELETE' && owner.execution.legalHold) throw new AppError('WORKFLOW_RETENTION_HOLD','Execution discussion is under legal hold.',409);
      const result = action==='READ' ? owner.timeline.getComment(owner.user,actor.workspaceId,commentId)
        : action==='EDIT' ? owner.timeline.updateComment(owner.user,actor.workspaceId,commentId,input) : owner.timeline.deleteComment(owner.user,actor.workspaceId,commentId);
      if (action!=='READ') await persistStateInTransaction(tx,owner.before,owner.store.state); return result;
    },{ timeout: 60000 });
  }
}
