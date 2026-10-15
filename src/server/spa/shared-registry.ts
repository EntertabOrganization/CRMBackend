import type { PrismaClient, SpaItem } from '@prisma/client';
import type { NextRequest } from 'next/server';
import type { ActorContext } from '../access-service';
import type { AccessService } from '../access-service';
import type { CollaborationModule } from '../collab';
import type { TimelineService } from '../activities/timeline-service';
import type { CatalogModule } from '../catalog';
import type { InMemoryStore } from '../store';
import { AppError } from '../errors';
import { resolvePrincipal } from '../process-platform/context';
import { SpaItemService } from './item-service';
import type { TemplateValue } from '../collab/files/document-render';
import { spaEntitlements } from './entitlements';
type SharedOwners = { access: AccessService; collab: CollaborationModule; timeline: TimelineService; catalog: CatalogModule; store: InMemoryStore };

/** Request-local authority over SQL-owned Items, used by the existing synchronous shared owners. */
export class SpaSharedRegistry {
  private workspaceId = '';
  private userId = '';
  private records = new Map<string, SpaItem>();
  private readable = new Map<string, Record<string, unknown>>();
  private editable = new Set<string>();
  private capabilities = new Map<string, Set<string>>();
  constructor(private readonly db: PrismaClient) {}
  clear() { this.records.clear(); this.readable.clear(); this.editable.clear(); this.capabilities.clear(); this.workspaceId = ''; this.userId = ''; }
  find(workspaceId: string, id: string) {
    const row = workspaceId === this.workspaceId ? this.records.get(id) : undefined;
    return row ? { ...row, responsibleUserId: row.assignedUserId } : undefined;
  }
  allowed(actor: ActorContext, id: string, write = false, capability?: string) {
    const row = this.records.get(id);
    return actor.workspaceId === this.workspaceId && actor.user.id === this.userId && row?.status !== 'TRASHED' &&
      this.readable.has(id) && (!write || this.editable.has(id)) && (!capability || !!row && !!this.capabilities.get(row.typeId)?.has(capability));
  }
  bind(context: SharedOwners) {
    context.access.registerRecordOwner('SPA_ITEM', { find: (workspaceId, id) => this.find(workspaceId, id),
      allowed: (actor, id, action) => this.allowed(actor, id, action === 'update', 'ACTIVITIES') });
    context.collab.attachments.register({ entityType: 'SPA_ITEM', exists: (workspaceId, id) => !!this.find(workspaceId, id),
      authorize: (actor, id, write) => { if (!this.allowed(actor, id, write)) throw new AppError('PERMISSION_DENIED', 'Item authority is required.', 403); },
      authorizeContent: (actor, id) => this.db.$transaction(async tx => {
        const principal = await resolvePrincipal(tx, actor.workspaceId, actor.user.id);
        const item = await tx.spaItem.findFirst({ where: { workspaceId: actor.workspaceId, id, status: { not: 'TRASHED' } } });
        if (!item) throw new AppError('PERMISSION_DENIED', 'Item content is unavailable.', 403);
        await new SpaItemService(this.db).policies.assertItem(tx, principal, item, 'SPA.ITEM.READ');
      }) });
    context.collab.tasks.tasks.registerBindingResolver({ entityType: 'SPA_ITEM', canBind: (actor, id) => this.allowed(actor, id, true, 'TASKS'), canRead: (actor, id) => this.allowed(actor, id, false, 'TASKS') });
    context.collab.calendar.events.registerBindingResolver({ entityType: 'SPA_ITEM', canBind: (actor, id) => this.allowed(actor, id, true, 'CALENDAR'), canRead: (actor, id) => this.allowed(actor, id, false, 'CALENDAR') });
    context.timeline.registerTargetAuthority('SPA_ITEM', (actor, id) => this.allowed(actor, id, false, 'ACTIVITIES'));
    context.catalog.rows.registerOwner({ ownerType: 'SPA_ITEM', label: 'Smart Process Item',
      load: (workspaceId, id) => this.find(workspaceId, id) ? { currencyCode: null } : undefined,
      canRead: (actor, id) => this.allowed(actor, id, false, 'PRODUCTS'), canUpdate: (actor, id) => this.allowed(actor, id, true, 'PRODUCTS') });
    context.collab.documents.templates.registerContext({ entityType: 'SPA_ITEM', supportsCustomFields: true,
      fields: ['id', 'title', 'itemNumber', 'status'], read: (actor, id) => {
        if (!this.allowed(actor, id, false, 'DOCUMENTS')) throw new AppError('PERMISSION_DENIED', 'Item document authority is required.', 403);
        const row = this.readable.get(id)!;
        return { fields: { id, title: row.title, itemNumber: row.itemNumber, status: row.status } as Record<string, TemplateValue>,
          customFields: row.fieldValues as Record<string, TemplateValue> };
      } });
  }
  async prepare(context: SharedOwners, request: NextRequest, userId: string, workspaceId: string) {
    this.clear(); this.workspaceId = workspaceId; this.userId = userId;
    const ids = new Set<string>();
    const collect = (raw: unknown): void => {
      if (typeof raw === 'string') for (const match of raw.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) ids.add(match[0]);
      else if (Array.isArray(raw)) raw.forEach(collect);
      else if (raw && typeof raw === 'object') Object.values(raw).forEach(collect);
    };
    collect(request.nextUrl.pathname); collect(request.nextUrl.search);
    if (request.method !== 'GET') {
      // Body parsing still belongs to the HTTP owner; this clone is only a bounded reference preflight.
      const length = Number(request.headers.get('content-length') ?? 0);
      if (length > 262144) throw new AppError('INVALID_ARGUMENT', 'Request body is too large.', 413);
      const text = await request.clone().text();
      if (Buffer.byteLength(text) > 262144) throw new AppError('INVALID_ARGUMENT', 'Request body is too large.', 413);
      try { collect(JSON.parse(text || '{}')); } catch { /* HTTP owner returns the malformed-body error. */ }
    }
    for (const row of context.store.state.fileAttachments) if (row.workspaceId === workspaceId && row.entityType === 'SPA_ITEM') ids.add(row.entityId);
    for (const row of context.store.state.generatedDocuments) if (row.workspaceId === workspaceId && row.entityType === 'SPA_ITEM') ids.add(row.entityId);
    for (const row of context.store.state.crmActivityBindings) if (row.workspaceId === workspaceId && row.entityType === 'SPA_ITEM') ids.add(row.entityId);
    for (const row of context.store.state.taskCrmBindings) if (row.workspaceId === workspaceId && row.entityType === 'SPA_ITEM') ids.add(row.entityId);
    for (const row of context.store.state.calendarEventBindings) if (row.workspaceId === workspaceId && row.entityType === 'SPA_ITEM') ids.add(row.entityId);
    if (!ids.size) return;
    await this.db.$transaction(async tx => {
      // A disabled plan denies only SPA-bound shared resources; it must not fail unrelated CRM requests.
      const limits = await spaEntitlements(tx, workspaceId, false);
      const rows = await tx.spaItem.findMany({ where: { workspaceId, id: { in: [...ids] } } });
      for (const item of rows) this.records.set(item.id, item);
      if (limits.spa === false || !rows.length) return;
      const actor = await resolvePrincipal(tx, workspaceId, userId), owner = new SpaItemService(this.db);
      const typeIds = [...new Set(rows.map(r => r.typeId))];
      const flags = await tx.spaCapability.findMany({ where: { workspaceId, typeId: { in: typeIds }, enabled: true } });
      for (const flag of flags) {
        if (limits['capability.' + flag.key] === false) continue;
        const set = this.capabilities.get(flag.typeId) ?? new Set<string>(); set.add(flag.key); this.capabilities.set(flag.typeId, set);
      }
      const active = new Set((await tx.spaEntityType.findMany({ where: { workspaceId, id: { in: typeIds }, status: 'ACTIVE', deletedAt: null },
        select: { id: true } })).map(t => t.id));
      for (const item of rows) {
        if (item.status === 'TRASHED' || !await owner.policies.allowed(tx, actor, item, 'SPA.ITEM.READ')) continue;
        this.readable.set(item.id, await owner.readInTransaction(tx, actor, item.typeId, item.id));
        if (active.has(item.typeId) && await owner.policies.allowed(tx, actor, item, 'SPA.ITEM.UPDATE')) this.editable.add(item.id);
      }
    }, { timeout: 30000 });
  }
}
