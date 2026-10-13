import type { PrismaClient, WorkflowExecution } from '@prisma/client';
import { AppError } from '../errors';
import type { Principal, Tx } from '../process-platform/context';
import { SpaItemService } from '../spa/item-service';
import { spaReferenceContext } from '../spa/reference-adapter';
import { InMemoryStore } from '../store';
import { hydrateState } from '../persistence';
import { AccessService } from '../access-service';
import { createCrmFieldEntityRegistry } from '../fields/entity-registry';

/** Source owner projection. New Inventory/Commerce authorities register here during integration. */
export class WorkflowEntityAuthority {
  private readonly spa: SpaItemService;
  private readonly readers = new Map<string,(tx: Tx,actor: Principal,id: string) => Promise<Record<string,unknown>>>();
  constructor(db: PrismaClient) { this.spa = new SpaItemService(db); }
  register(type: string, reader: (tx: Tx,actor: Principal,id: string) => Promise<Record<string,unknown>>) { this.readers.set(type,reader); }
  references(tx: Tx,actor: Principal) { return spaReferenceContext(tx,actor,this.spa.policies); }
  async read(tx: Tx, actor: Principal, entityType: string, entityId: string, subtypeId?: string) {
    if (this.readers.has(entityType)) return this.readers.get(entityType)!(tx,actor,entityId);
    if (entityType === 'SPA_ITEM') {
      const item = await tx.spaItem.findFirst({ where: { workspaceId: actor.workspaceId,id: entityId,status: { not: 'TRASHED' },...(subtypeId ? { typeId: subtypeId } : {}) } });
      if (!item) throw new AppError('WORKFLOW_ENTITY_BINDING_INVALID','Bound entity is unavailable.',404);
      const projection = await this.spa.readInTransaction(tx,actor,item.typeId,item.id);
      return { ...projection,...projection.fieldValues } as Record<string,unknown>;
    }
    const references = await spaReferenceContext(tx,actor,this.spa.policies);
    if (!await references.checkTarget(entityType,entityId,subtypeId)) throw new AppError('WORKFLOW_ENTITY_BINDING_INVALID','Bound entity is unavailable.',404);
    if (['CONTACT','COMPANY','LEAD','DEAL'].includes(entityType)) {
      const store = new InMemoryStore(await hydrateState(tx)), access = new AccessService(store);
      const user = store.state.users.find(u => u.id === actor.userId)!;
      const owningActor = access.actor(user,actor.workspaceId), adapter = createCrmFieldEntityRegistry(store,access).get(entityType);
      if (!adapter.canRead(owningActor,entityId)) throw new AppError('WORKFLOW_ENTITY_BINDING_INVALID','Bound entity is unavailable.',404);
      const row = adapter.findRecord(actor.workspaceId,entityId);
      const values = adapter.systemValues(row);
      return { id: entityId,...Object.fromEntries(adapter.systemFields().filter(f => f.conditionCapable).map(f => [f.key,values[f.key]])) };
    }
    return { id: entityId };
  }
  async execution(tx: Tx, actor: Principal, row: WorkflowExecution) {
    return this.read(tx,actor,row.entityType,row.entityId);
  }
  async validateReferences(tx: Tx, actor: Principal, values: Record<string,unknown>) {
    for (const value of Object.values(values)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const reference = value as Record<string,unknown>;
      if (typeof reference.entityType === 'string' && typeof reference.entityId === 'string') await this.read(tx,actor,reference.entityType,reference.entityId);
    }
  }
}
