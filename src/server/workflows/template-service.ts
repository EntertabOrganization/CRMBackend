import { Prisma,type PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { evidence,requirePermission,resolvePrincipal,type Principal } from '../process-platform/context';
import { ownerVisible } from '../process-platform/owner-scope';
import { parse,uuid,name,code,pageQuery } from '../process-platform/dto';
import { createDefinition,graph,type Graph } from './dto';
import { assertNoSecrets } from './graph-validator';
import { WorkflowDefinitionService } from './definition-service';

type Slot = { key: string; path: string };
const marker = '__WORKFLOW_BINDING_';
/** No original identity, address, business default or private value is retained in a template slot. */
function portable(snapshot: Graph) {
  const slots: Slot[] = [];
  const bind = (path: string) => { const key = 'VALUE_' + slots.length; slots.push({ key,path }); return { [marker]: key }; };
  function visit(value: unknown,path: string,structural = false): unknown {
    if (structural) return value;
    if (typeof value==='string' && /(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|__WORKFLOW_BINDING_)/i.test(value)) return bind(path);
    if (Array.isArray(value)) return value.map((v,i) => visit(v,path + '.' + i));
    if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([key,v]) => {
      const next = path + '.' + key;
      if (['defaultValue','input','body'].includes(key)) return [key,bind(next)];
      return [key,visit(v,next,/^graph\.(?:nodes\.\d+\.id|edges\.\d+\.(?:id|fromNodeId|toNodeId))$/.test(next))];
    }));
    return value;
  }
  // Graph UUIDs describe topology only; regenerate them before storing rather than retaining source graph IDs.
  const mapping = new Map(snapshot.nodes.map(n => [n.id,randomUUID()]));
  snapshot.nodes = snapshot.nodes.map(n => ({ ...n,id: mapping.get(n.id)! }));
  snapshot.edges = snapshot.edges.map(e => ({ ...e,id: randomUUID(),fromNodeId: mapping.get(e.fromNodeId)!,toNodeId: mapping.get(e.toNodeId)! }));
  return { graph: visit(snapshot,'graph'),slots };
}
function fill(value: unknown,bindings: Record<string,unknown>): unknown {
  if (Array.isArray(value)) return value.map(v => fill(v,bindings));
  if (value && typeof value==='object') {
    const object = value as Record<string,unknown>;
    if (Object.hasOwn(object,marker)) return bindings[String(object[marker])];
    return Object.fromEntries(Object.entries(object).map(([key,v]) => [key,fill(v,bindings)]));
  }
  return value;
}
export class WorkflowTemplateService {
  constructor(private readonly db: PrismaClient,readonly definitions = new WorkflowDefinitionService(db)) {}
  async list(actor: Principal,raw: unknown) {
    requirePermission(actor,'WORKFLOW.TEMPLATE_MANAGE'); const query = parse(pageQuery.extend({ category: name.optional() }),raw);
    return this.db.$transaction(async tx => {
      const rows = await tx.workflowTemplate.findMany({ where: { workspaceId: actor.workspaceId,status: 'ACTIVE',category: query.category,
        ...(query.search ? { name: { contains: query.search,mode: 'insensitive' } } : {}) },orderBy: [{ createdAt: 'desc' },{ id: 'asc' }] });
      const visible = [];
      for (const row of rows) if (await ownerVisible(tx,actor,row.ownerUserId,'WORKFLOW.TEMPLATE_MANAGE')) visible.push(row);
      return { data: visible.slice((query.page-1)*query.limit,query.page*query.limit),meta: { page: query.page,limit: query.limit,total: visible.length,totalPages: Math.ceil(visible.length/query.limit) } };
    });
  }
  async create(actor: Principal,raw: unknown) {
    requirePermission(actor,'WORKFLOW.TEMPLATE_MANAGE'); const input = parse(z.strictObject({ name,category: name,sourceVersionId: uuid }),raw);
    return this.db.$transaction(async tx => {
      actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'WORKFLOW.TEMPLATE_MANAGE');
      const version = await tx.workflowVersion.findFirst({ where: { workspaceId: actor.workspaceId,id: input.sourceVersionId } });
      if (!version) throw new AppError('WORKFLOW_TEMPLATE_INVALID','Source version is unavailable.',404);
      const { definition } = await this.definitions.workflowVersion(tx,actor,version.definitionId,version.id,'WORKFLOW.DESIGN');
      const source = parse(graph,version.definition); assertNoSecrets(source);
      const snapshot = { ...portable(source),boundEntityType: definition.boundEntityType,type: definition.type,concurrencyMode: definition.concurrencyMode };
      const row = await tx.workflowTemplate.create({ data: { workspaceId: actor.workspaceId,name: input.name,category: input.category,ownerUserId: actor.userId,
        snapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue } });
      await evidence(tx,actor,'WORKFLOW_TEMPLATE',row.id,'WORKFLOW_TEMPLATE_CREATED',{ name: row.name,category: row.category }); return row;
    });
  }
  async instantiate(actor: Principal,templateId: string,raw: unknown) {
    requirePermission(actor,'WORKFLOW.DESIGN'); parse(uuid,templateId);
    const input = parse(z.strictObject({ name,code,bindings: z.strictObject({ boundEntityTypeId: uuid.optional(),values: z.record(z.string(),z.json()).default({}) }) }),raw);
    return this.db.$transaction(async tx => {
      actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'WORKFLOW.DESIGN');
      const template = await tx.workflowTemplate.findFirst({ where: { workspaceId: actor.workspaceId,id: templateId,status: 'ACTIVE' } });
      if (!template || !await ownerVisible(tx,actor,template.ownerUserId,'WORKFLOW.DESIGN')) throw new AppError('WORKFLOW_TEMPLATE_INVALID','Template is unavailable.',404);
      const snapshot = template.snapshot as { graph: unknown;slots: Slot[];boundEntityType: string;type: string;concurrencyMode: string };
      const keys = snapshot.slots.map(s => s.key);
      if (Object.keys(input.bindings.values).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(input.bindings.values,key)))
        throw new AppError('WORKFLOW_TEMPLATE_INVALID','Provide every declared template binding.',422,{ slots: snapshot.slots });
      const resolved = parse(graph,fill(snapshot.graph,input.bindings.values)); assertNoSecrets(resolved);
      const mapping = new Map(resolved.nodes.map(n => [n.id,randomUUID()]));
      resolved.nodes = resolved.nodes.map(n => ({ ...n,id: mapping.get(n.id)! }));
      resolved.edges = resolved.edges.map(e => ({ ...e,id: randomUUID(),fromNodeId: mapping.get(e.fromNodeId)!,toNodeId: mapping.get(e.toNodeId)! }));
      const definition = parse(createDefinition,{ name: input.name,code: input.code,boundEntityType: snapshot.boundEntityType,
        boundEntityTypeId: input.bindings.boundEntityTypeId,type: snapshot.type,concurrencyMode: snapshot.concurrencyMode,runAs: 'STARTER' });
      return this.definitions.instantiateInTransaction(tx,actor,definition,resolved);
    },{ timeout: 60000 });
  }
}
