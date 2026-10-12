import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission,resolvePrincipal,type Principal } from '../process-platform/context';
import { parse,uuid,code } from '../process-platform/dto';
import { actionConfig,graph } from './dto';
import { assertNoSecrets } from './graph-validator';
import { compileExpression } from './expression';
import { WorkflowExecutionService } from './execution-service';

/** Descriptor/validation reads never call an action adapter or expose invocation request bodies. */
export class WorkflowActionsService {
  constructor(private readonly db: PrismaClient,readonly executions = new WorkflowExecutionService(db)) {}
  async list(actor: Principal,raw: unknown) {
    requirePermission(actor,'WORKFLOW.DESIGN');
    const query = parse(z.strictObject({ search: z.string().max(160).optional(),domain: z.string().max(64).optional() }),raw);
    return this.executions.definitions.actions.list().filter(a => (!query.domain || a.domain===query.domain) &&
      (!query.search || a.actionCode.toLowerCase().includes(query.search.toLowerCase())));
  }
  async validate(actor: Principal,workflowId: string,actionCode: string,raw: unknown) {
    const input = parse(z.strictObject({ versionId: uuid,nodeKey: code,config: actionConfig }),raw);
    assertNoSecrets(input.config);
    if (input.config.actionCode!==actionCode) throw new AppError('WORKFLOW_ACTION_NOT_ALLOWED','Action code does not match configuration.',422);
    return this.db.$transaction(async tx => {
      const { definition,row } = await this.executions.definitions.workflowVersion(tx,actor,workflowId,input.versionId,'WORKFLOW.DESIGN');
      const snapshot = parse(graph,row.definition), node = snapshot.nodes.find(n => n.nodeKey===input.nodeKey);
      if (!node || !['ACTION','CREATE_TASK','CREATE_ENTITY','UPDATE_ENTITY','CHANGE_STAGE','NOTIFY','GENERATE_DOCUMENT'].includes(node.nodeType))
        throw new AppError('WORKFLOW_NODE_INVALID','Action node was not found.',422);
      const executor = definition.runAs==='SERVICE_ACCOUNT' && definition.serviceAccountUserId
        ? await resolvePrincipal(tx,actor.workspaceId,definition.serviceAccountUserId) : actor;
      const adapter = this.executions.definitions.actions.get(actionCode); requirePermission(executor,adapter.permission);
      for (const expression of Object.values(input.config.inputExpressions)) compileExpression(expression);
      // Expression-bound values require runtime source data; validate static fields without executing expressions.
      const jsonSchema = z.toJSONSchema(adapter.inputSchema,{ unrepresentable: 'any' }) as { properties?: Record<string,unknown>; required?: string[] };
      const provided = new Set([...Object.keys(input.config.input),...Object.keys(input.config.inputExpressions)]);
      if ([...provided].some(key => !Object.hasOwn(jsonSchema.properties ?? {},key)) || (jsonSchema.required ?? []).some(key => !provided.has(key)))
        throw new AppError('WORKFLOW_NODE_INVALID','Action inputs do not match the installed schema.',422);
      if (!Object.keys(input.config.inputExpressions).length) this.executions.definitions.actions.validate(executor,actionCode,input.config.input);
      if (input.config.compensation) {
        const inverse = this.executions.definitions.actions.get(input.config.compensation.actionCode);
        if (adapter.inverse!==inverse.code) throw new AppError('WORKFLOW_ACTION_NOT_ALLOWED','Compensation is not a declared inverse.',422);
        requirePermission(executor,inverse.permission);
        for (const expression of Object.values(input.config.compensation.inputExpressions)) compileExpression(expression);
        if (!Object.keys(input.config.compensation.inputExpressions).length)
          this.executions.definitions.actions.validate(executor,inverse.code,input.config.compensation.input);
      }
      return { valid: true,actionCode,nodeKey: input.nodeKey,requiresRuntimeValidation: Object.keys(input.config.inputExpressions).length>0 };
    });
  }
  async invocations(actor: Principal,executionId: string,raw: unknown) {
    const query = parse(z.strictObject({ page: z.coerce.number().int().min(1).default(1),limit: z.coerce.number().int().min(1).max(100).default(20) }),raw);
    return this.db.$transaction(async tx => {
      await this.executions.load(tx,actor,executionId);
      const where = { workspaceId: actor.workspaceId,executionId };
      const [rows,total] = await Promise.all([tx.workflowActionInvocation.findMany({ where,orderBy: { id: 'asc' },skip: (query.page-1)*query.limit,take: query.limit }),tx.workflowActionInvocation.count({ where })]);
      return { data: rows.map(row => ({ id: row.id,nodeRunId: row.nodeRunId,actionCode: row.actionCode,status: row.status,errorCode: row.errorCode })),
        meta: { page: query.page,limit: query.limit,total,totalPages: Math.ceil(total/query.limit) } };
    });
  }
}
