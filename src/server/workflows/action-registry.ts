import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, type Principal, type Tx } from '../process-platform/context';
import { parse, uuid, version } from '../process-platform/dto';
import { SpaItemService, spaCreateItemDto } from '../spa/item-service';

export type ActionDescriptor = { code: string; domain: string; permission: string; sideEffectClass: 'TRANSACTIONAL' | 'PROVIDER';
  inputSchema: z.ZodType; inverse?: string; timeoutMs: number; maxAttempts: number };
export type ActionAdapter = ActionDescriptor & { execute(context: { tx: Tx; actor: Principal; input: unknown; idempotencyKey: string }): Promise<unknown> };
/** Only installed owning-service adapters appear as executable actions. No generic cross-domain SQL fallback. */
export class WorkflowActionRegistry {
  private readonly adapters = new Map<string,ActionAdapter>();
  register(adapter: ActionAdapter) {
    if (this.adapters.has(adapter.code)) throw new Error('Workflow action already registered');
    this.adapters.set(adapter.code,adapter); return this;
  }
  get(code: string): ActionAdapter {
    const adapter = this.adapters.get(code);
    if (!adapter) throw new AppError('WORKFLOW_ACTION_NOT_ALLOWED','Action is unavailable.',422);
    return adapter;
  }
  validate(actor: Principal, code: string, input: unknown) {
    const adapter = this.get(code); requirePermission(actor,adapter.permission); return parse(adapter.inputSchema,input);
  }
  list() { return [...this.adapters.values()].map(a => ({ actionCode: a.code, domain: a.domain, requiredPermission: a.permission,
    sideEffectClass: a.sideEffectClass, timeoutMs: a.timeoutMs, maxAttempts: a.maxAttempts, inverseActionCode: a.inverse ?? null,
    inputSchema: z.toJSONSchema(a.inputSchema,{ unrepresentable: 'any' }) })); }
  async execute(tx: Tx, actor: Principal, code: string, input: unknown, idempotencyKey: string) {
    const adapter = this.get(code); const validated = this.validate(actor,code,input);
    return adapter.execute({ tx, actor, input: validated, idempotencyKey });
  }
}

export function workflowActions(db: PrismaClient) {
  const registry = new WorkflowActionRegistry(), spa = new SpaItemService(db);
  registry.register({ code: 'SPA.CREATE_ITEM', domain: 'SPA', permission: 'SPA.ITEM.CREATE', sideEffectClass: 'TRANSACTIONAL', timeoutMs: 30000, maxAttempts: 3,
    inputSchema: z.strictObject({ typeId: uuid, item: spaCreateItemDto }), execute: async ({ tx,actor,input,idempotencyKey }) => {
      const parsed = parse(z.strictObject({ typeId: uuid, item: spaCreateItemDto }),input);
      const result = await spa.createInTransaction(tx,actor,parsed.typeId,parsed.item,idempotencyKey);
      return { entityType: 'SPA_ITEM', entityId: result.id };
    } });
  const update = z.strictObject({ typeId: uuid, itemId: uuid, expectedVersion: version, changes: z.record(z.string(),z.json()) });
  registry.register({ code: 'SPA.UPDATE_ITEM', domain: 'SPA', permission: 'SPA.ITEM.UPDATE', sideEffectClass: 'TRANSACTIONAL', timeoutMs: 30000, maxAttempts: 3,
    inputSchema: update, execute: async ({ tx,actor,input }) => {
      const parsed = parse(update,input);
      const result = await spa.updateInTransaction(tx,actor,parsed.typeId,parsed.itemId,{ ...parsed.changes, expectedVersion: parsed.expectedVersion });
      return { entityType: 'SPA_ITEM', entityId: result.id, version: result.version };
    } });
  const transition = z.strictObject({ typeId: uuid, itemId: uuid, expectedVersion: version, pipelineId: uuid, stageId: uuid, reason: z.string().max(2000).optional() });
  registry.register({ code: 'SPA.CHANGE_STAGE', domain: 'SPA', permission: 'SPA.ITEM.STAGE_CHANGE', sideEffectClass: 'TRANSACTIONAL', timeoutMs: 30000, maxAttempts: 3,
    inputSchema: transition, execute: async ({ tx,actor,input }) => {
      const parsed = parse(transition,input);
      const result = await spa.transitionInTransaction(tx,actor,parsed.typeId,parsed.itemId,{
        expectedVersion: parsed.expectedVersion, targetPipelineId: parsed.pipelineId, targetStageId: parsed.stageId,
        ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}) });
      return { entityType: 'SPA_ITEM', entityId: result.id, version: result.version };
    } });
  return registry;
}
