import { AccessService } from '../access-service';
import { hydrateState } from '../persistence';
import { InMemoryStore } from '../store';
import { RealtimeHub } from '../realtime';
import { CollabSupport } from '../collab/support';
import { TasksPolicy } from '../collab/tasks/policy';
import { ProjectDriveService } from '../collab/files/project-drive-service';
import { createCrmFieldEntityRegistry } from '../fields/entity-registry';
import type { FieldTypeContext } from '../fields/field-types';
import type { Principal, Tx } from '../process-platform/context';
import type { SpaPolicyService } from './policy-service';
import { CollaborationModule } from '../collab';
import { UnconfiguredFilePort } from '../ports';
import { ProductFieldEntityAdapter } from '../catalog/property-service';
import { CatalogSupport } from '../catalog/support';
import { ActivityAccessPolicy } from '../activities/activity-access';
import { ActivityFieldEntityAdapter } from '../activities/activity-field-adapter';

export type SpaReferenceContext = Omit<FieldTypeContext, 'options' | 'existingItems'> & {
  checkTarget(type: string, id: string, subtypeId?: string): Promise<boolean>;
  readFile(fileId: string, maxBytes: number): ReturnType<import('../collab/files/delivery-service').FileDeliveryService['readForProcessing']>;
};

/** Read-only bridge to existing owners. The isolated snapshot is never persisted or shared across requests. */
export async function spaReferenceContext(tx: Tx, principal: Principal, policies: SpaPolicyService,
  spaReferenceIds: string[] = [], targetTypes: Map<string, string> = new Map()): Promise<SpaReferenceContext> {
  const store = new InMemoryStore(await hydrateState(tx));
  const access = new AccessService(store);
  const user = store.state.users.find(u => u.id === principal.userId && u.status === 'ACTIVE' && !u.isDeleted);
  if (!user) throw new Error('Inactive principal');
  const actor = access.actor(user, principal.workspaceId);
  const registry = createCrmFieldEntityRegistry(store, access);
  const support = new CollabSupport({ store, access, realtime: new RealtimeHub() });
  const filePort = new UnconfiguredFilePort();
  const collab = new CollaborationModule({ store, access, realtime: new RealtimeHub(), files: () => filePort });
  registry.register(new ProductFieldEntityAdapter(new CatalogSupport(store, access, new RealtimeHub(), () => filePort)));
  registry.register(new ActivityFieldEntityAdapter(store, new ActivityAccessPolicy(store, access), access));
  for (const adapter of registry.list()) collab.documents.templates.registerContext({ entityType: adapter.entityType,
    supportsCustomFields: false, fields: ['id'], read: (a, id) => {
      if (!adapter.findRecord(a.workspaceId, id) || !adapter.canRead(a, id)) throw new Error('Owner denied access');
      return { fields: { id }, customFields: {} };
    } });
  for (const adapter of registry.list()) collab.attachments.register({ entityType: adapter.entityType,
    exists: (workspaceId, id) => !!adapter.findRecord(workspaceId, id), authorize: (a, id, write) => {
      if (!adapter.findRecord(a.workspaceId, id) || !adapter.canRead(a, id) || write && !adapter.canUpdate(a, id)) throw new Error('Owner denied access');
    } });
  const spaBoundIds = store.state.fileAttachments.filter(a => a.workspaceId === principal.workspaceId && a.entityType === 'SPA_ITEM').map(a => a.entityId);
  const existingSpaIds = new Set<string>(), editableSpaIds = new Set<string>();
  const boundItems = spaBoundIds.length ? await tx.spaItem.findMany({ where: { workspaceId: principal.workspaceId, id: { in: spaBoundIds }, status: { not: 'TRASHED' } } }) : [];
  for (const item of boundItems) {
    if (await policies.allowed(tx, principal, item, 'SPA.ITEM.READ')) existingSpaIds.add(item.id);
    if (await policies.allowed(tx, principal, item, 'SPA.ITEM.UPDATE')) editableSpaIds.add(item.id);
  }
  collab.attachments.register({ entityType: 'SPA_ITEM', exists: (workspaceId, id) => workspaceId === principal.workspaceId && existingSpaIds.has(id),
    authorize: (a, id, write) => { if (a.user.id !== principal.userId || !existingSpaIds.has(id) || write && !editableSpaIds.has(id)) throw new Error('Owner denied access'); } });
  const files = new ProjectDriveService(support, new TasksPolicy(support));
  const visibleSpaIds = new Set<string>();
  if (spaReferenceIds.length) {
    const rows = await tx.spaItem.findMany({ where: { workspaceId: principal.workspaceId, id: { in: spaReferenceIds }, status: { not: 'TRASHED' } } });
    for (const item of rows) if ((!targetTypes.has(item.id) || targetTypes.get(item.id) === item.typeId) &&
      await policies.allowed(tx, principal, item, 'SPA.ITEM.READ')) visibleSpaIds.add(item.id);
  }
  return {
    readFile: (fileId, maxBytes) => collab.files.delivery.readForProcessing(actor, fileId, maxBytes),
    checkTarget: async (type, id, subtypeId) => {
      if (type === 'SPA_ITEM') {
        const item = await tx.spaItem.findFirst({ where: { workspaceId: principal.workspaceId, id, status: { not: 'TRASHED' },
          ...(subtypeId ? { typeId: subtypeId } : {}) } });
        return !!item && await policies.allowed(tx, principal, item, 'SPA.ITEM.READ');
      }
      try {
        if (type === 'FILE') return collab.attachments.check(principal.workspaceId, actor, id) === 'OK';
        if (type === 'TASK') { collab.tasks.policy.task(actor, id); return true; }
        if (type === 'PROJECT') { collab.tasks.policy.project(actor, id); return true; }
        if (type === 'EVENT') {
          const event = store.state.calendarEvents.find(e => e.workspaceId === principal.workspaceId && e.id === id);
          return !!event && collab.calendar.events.canRead(actor, event);
        }
        if (type === 'DOCUMENT') {
          const doc = store.state.generatedDocuments.find(d => d.workspaceId === principal.workspaceId && d.id === id);
          if (!doc) return false;
          if (doc.entityType === 'SPA_ITEM') {
            const source = await tx.spaItem.findFirst({ where: { workspaceId: principal.workspaceId, id: doc.entityId, status: { not: 'TRASHED' } } });
            if (!source || !await policies.allowed(tx, principal, source, 'SPA.ITEM.READ')) return false;
            collab.documents.templates.registerContext({ entityType: 'SPA_ITEM', supportsCustomFields: false, fields: ['id'],
              read: (a, sourceId) => { if (a.user.id !== principal.userId || sourceId !== doc.entityId) throw new Error('Owner denied access');
                return { fields: { id: sourceId }, customFields: {} }; } });
          }
          collab.documents.generated.get(actor, id); return true;
        }
        return registry.has(type) && !!registry.get(type).findRecord(principal.workspaceId, id) && registry.get(type).canRead(actor, id);
      } catch { return false; }
    },
    checkUser: id => store.state.users.some(u => u.id === id && u.status === 'ACTIVE' && !u.isDeleted) ? 'OK' : 'MISSING',
    isUserSelectable: id => access.isActiveMember(principal.workspaceId, id),
    checkCrmReference: (entityType, id) => entityType === 'SPA_ITEM' ? (visibleSpaIds.has(id) ? 'OK' : 'MISSING')
      : !registry.has(entityType) || !registry.get(entityType).findRecord(principal.workspaceId, id) ? 'MISSING'
      : registry.get(entityType).canRead(actor, id) ? 'OK' : 'FORBIDDEN',
    checkFile: id => {
      try {
        return collab.attachments.check(principal.workspaceId, actor, id);
      } catch { return 'FORBIDDEN'; }
    },
    registeredEntityTypes: [...registry.types(), 'SPA_ITEM'],
  };
}
