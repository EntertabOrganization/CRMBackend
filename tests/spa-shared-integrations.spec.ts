import { randomUUID, createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { spaContractDatabase, contractFixture } from './support/spa-contract';
import { resolvePrincipal, authenticate } from '../src/server/process-platform/context';
import { hydrateState, persistStateInTransaction } from '../src/server/persistence';
import { SpaSharedRegistry } from '../src/server/spa/shared-registry';
import { resetAppContextForTests } from '../src/server/app-context';
const database = spaContractDatabase();

async function sharedFixture() {
  const db = database(), f = await contractFixture(db), item = await f.create('Visible');
  for (const key of ['TASKS', 'CALENDAR', 'DOCUMENTS', 'PRODUCTS']) {
    const t = await f.types.get(f.actor, f.type.id);
    await f.types.setCapability(f.actor, t.id, key, { expectedVersion: t.version, enabled: true, configuration: {} });
  }
  await f.publish();
  const context = resetAppContextForTests(); context.store.state = await hydrateState(db);
  const registry = new SpaSharedRegistry(db); registry.bind(context);
  const actor = context.access.actor(context.store.state.users.find(u => u.id === f.user.id)!, f.workspace.id);
  const request = new NextRequest('http://test.local/api/v1/crm/SPA_ITEM/' + item.id + '/timeline');
  await registry.prepare(context, request, f.user.id, f.workspace.id);
  return { ...f, db, item, context, registry, actor, request };
}
describe('SPA shared owner registrations and current authority', () => {
  it('registers Files, document context and the shared Catalog row owner with current field redaction', async () => {
    const f = await sharedFixture();
    expect(() => f.context.collab.attachments.authorizeEntity(f.actor, 'SPA_ITEM', f.item.id, true)).not.toThrow();
    expect(f.context.collab.documents.templates.adapter('SPA_ITEM').read(f.actor, f.item.id).customFields).toEqual({ VALUE: 'Visible' });
    await f.hide(); await f.registry.prepare(f.context, f.request, f.user.id, f.workspace.id);
    expect(f.context.collab.documents.templates.adapter('SPA_ITEM').read(f.actor, f.item.id).customFields).toEqual({});
    expect(f.context.catalog.rows.list(f.actor.user, f.workspace.id, 'SPA_ITEM', f.item.id)).toBeDefined();
  });
  it('next request revokes shared read/write authority without an owner-role bypass', async () => {
    const f = await sharedFixture(); await f.matrix({ rolePolicies: [{ roleId: f.role.id, action: 'SPA.ITEM.READ', scope: 'NONE' }] });
    await f.registry.prepare(f.context, f.request, f.user.id, f.workspace.id);
    expect(() => f.context.collab.attachments.authorizeEntity(f.actor, 'SPA_ITEM', f.item.id)).toThrow();
    expect(() => f.context.collab.documents.templates.adapter('SPA_ITEM').read(f.actor, f.item.id)).toThrow();
    expect(f.registry.allowed({ ...f.actor, workspaceId: randomUUID() }, f.item.id)).toBe(false);
  });
  it('shared Task and Calendar bindings require the current Item capability and mutation grant', async () => {
    const f = await sharedFixture();
    const created = f.context.collab.tasks.tasks.create(f.actor, { title: 'Shared task', responsibleUserId: f.user.id,
      bindings: [{ entityType: 'SPA_ITEM', entityId: f.item.id }] });
    expect(created.title).toBe('Shared task');
    await f.matrix({ rolePolicies: [{ roleId: f.role.id, action: 'SPA.ITEM.UPDATE', scope: 'NONE' }] });
    await f.registry.prepare(f.context, f.request, f.user.id, f.workspace.id);
    expect(() => f.context.collab.tasks.tasks.create(f.actor, { title: 'Denied', responsibleUserId: f.user.id,
      bindings: [{ entityType: 'SPA_ITEM', entityId: f.item.id }] })).toThrow();
    expect(f.registry.allowed(f.actor, f.item.id, true, 'CALENDAR')).toBe(false);
  });
  it('shared Timeline projects Item events exactly once without copying private field values', async () => {
    const f = await sharedFixture(); f.context.timeline.projectPending(f.workspace.id); f.context.timeline.projectPending(f.workspace.id);
    const entries = f.context.store.state.crmTimelineEntries.filter(e => e.entityType === 'SPA_ITEM' && e.entityId === f.item.id);
    expect(entries).toHaveLength(1); expect(entries[0].summaryCode).toBe('SPA_ITEM_CREATED');
    expect(JSON.stringify(entries[0])).not.toContain('Visible');
    expect(f.context.access.canAccessCrmRecord(f.actor, 'SPA_ITEM', f.item.id, 'read')).toBe(true);
  });
  it('SPA policy revocation fences a shared mutation hydrated before the change', async () => {
    const f = await sharedFixture(), before = await hydrateState(f.db), after = structuredClone(before);
    after.crmTimelineComments.push({ id: randomUUID(), workspaceId: f.workspace.id, entityType: 'SPA_ITEM', entityId: f.item.id,
      authorUserId: f.user.id, body: 'Stale', fileIds: [], version: 1, createdAt: new Date(), updatedAt: new Date(), isDeleted: false,
      deletedAt: null, deletedByUserId: null } as typeof after.crmTimelineComments[number]);
    await f.matrix({ rolePolicies: [{ roleId: f.role.id, action: 'SPA.ITEM.READ', scope: 'NONE' }] });
    await expect(f.db.$transaction(tx => persistStateInTransaction(tx, before, after))).rejects.toMatchObject({ code: 'CONCURRENCY_CONFLICT' });
    expect(await f.db.crmTimelineComment.count({ where: { entityId: f.item.id } })).toBe(0);
  });
  it('shared entitlement grants intersect Workspace field/type quotas and capability activation', async () => {
    const db = database(), f = await contractFixture(db);
    const grant = async (capability: string, enabled: boolean, limit: number | null = null) => db.commercialPackRecord.create({ data: {
      id: randomUUID(), workspaceId: f.workspace.id, collection: 'entitlementGrants', data: { workspaceId: f.workspace.id, capability, enabled, limit } } });
    await grant('spa.max_fields', true, 1);
    await expect(f.schemas.addField(f.actor, f.type.id, { code: 'SECOND', name: 'Second', fieldType: 'TEXT' })).rejects.toMatchObject({ code: 'SPA_PLAN_LIMIT' });
    await grant('spa.max_types', true, 1);
    await expect(f.types.create(f.actor, { code: 'SECOND', name: 'Second', pluralName: 'Seconds', placement: 'CRM' })).rejects.toMatchObject({ code: 'SPA_PLAN_LIMIT' });
    await grant('spa.capability.TASKS', false);
    const t = await f.types.get(f.actor, f.type.id);
    await expect(f.types.setCapability(f.actor, t.id, 'TASKS', { expectedVersion: t.version, enabled: true, configuration: {} })).rejects.toMatchObject({ code: 'SPA_PLAN_LIMIT' });
    await grant('spa.enabled', false);
    await expect(f.types.get(await resolvePrincipal(db, f.workspace.id, f.user.id), f.type.id)).rejects.toMatchObject({ code: 'SPA_PLAN_LIMIT' });
  });
  it('external API scopes intersect current membership, explicit grants and revocation', async () => {
    const db = database(), f = await contractFixture(db), raw = 'trm_api_' + randomUUID(), id = randomUUID();
    const data = { id, workspaceId: f.workspace.id, principalId: f.user.id, secretHash: createHash('sha256').update(raw).digest('hex'), status: 'ACTIVE', scopes: ['spa.read'] };
    await db.commercialPackRecord.create({ data: { id, workspaceId: f.workspace.id, collection: 'apiCredentials', data } });
    const request = (method: string, workspaceId = f.workspace.id) => new NextRequest('http://test.local/api/v1/spa/types', {
      method, headers: { authorization: 'Bearer ' + raw, 'x-workspace-id': workspaceId } });
    expect((await authenticate(db, request('GET'))).userId).toBe(f.user.id);
    await expect(authenticate(db, request('POST'))).rejects.toMatchObject({ code: 'API_SCOPE_DENIED' });
    await expect(authenticate(db, request('GET', randomUUID()))).rejects.toMatchObject({ status: 403 });
    await db.workspaceMembership.updateMany({ where: { workspaceId: f.workspace.id }, data: { status: 'SUSPENDED' } });
    await expect(authenticate(db, request('GET'))).rejects.toMatchObject({ status: 403 });
    await db.commercialPackRecord.update({ where: { id }, data: { data: { ...data, status: 'REVOKED' } } });
    await expect(authenticate(db, request('GET'))).rejects.toMatchObject({ code: 'CREDENTIAL_REVOKED' });
  });
  it('SQL eligibility paginates after OWN/observer and target-stage deny intersections', async () => {
    const f = await contractFixture(database()), p = await f.pipeline(), m = await f.member({ 'SPA.ITEM.READ': 'OWN' });
    const own = await f.items.create(m.actor, f.type.id, { title: 'Own', assignedUserId: m.user.id, fieldValues: { VALUE: 'Own' } }, randomUUID());
    const other = await f.create('Other'); await f.items.observer(f.actor, f.type.id, other.id, { userId: m.user.id });
    const page = await f.items.list(m.actor, f.type.id, { limit: 1 }); expect(page.meta.total).toBe(2); expect(page.data).toHaveLength(1);
    const next = await f.items.list(m.actor, f.type.id, { page: 2, limit: 1 }); expect(next.data[0].id).not.toBe(page.data[0].id);
    await f.matrix({ stagePolicies: [{ roleId: m.role.id, action: 'SPA.ITEM.READ', scope: 'NONE', pipelineId: p.p.id, stageId: p.start.id }] });
    expect((await f.items.list(m.actor, f.type.id, {})).meta.total).toBe(0);
    expect((await f.items.kanban(m.actor, f.type.id, { pipelineId: p.p.id, limit: 1 })).columns.flatMap(c => c.items)).toEqual([]);
    expect(await database().spaItem.findUnique({ where: { id: own.id } })).toBeDefined();
  });
});

