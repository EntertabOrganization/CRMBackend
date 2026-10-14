import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { spaContractDatabase, contractFixture } from './support/spa-contract';
import { FileArtifactService } from '../src/server/collab/files/artifact-service';
import { authorizeSpaFileBindings } from '../src/server/spa/file-authority';
import { SpaSharedRegistry } from '../src/server/spa/shared-registry';
import { SpaTransferService } from '../src/server/spa/transfer-service';
import { hydrateState, persistStateInTransaction } from '../src/server/persistence';
import { resetAppContextForTests } from '../src/server/app-context';
import { CollaborationModule } from '../src/server/collab';
import { RealtimeHub } from '../src/server/realtime';
import { UnconfiguredFilePort } from '../src/server/ports';
import { Body } from '../src/server/collab/support';
const database = spaContractDatabase();
const previousSecret = process.env.FILE_DELIVERY_SECRET;
beforeAll(() => { process.env.FILE_DELIVERY_SECRET = 'spa-shared-content-test-secret-32-bytes'; });
afterAll(() => { if (previousSecret === undefined) delete process.env.FILE_DELIVERY_SECRET; else process.env.FILE_DELIVERY_SECRET = previousSecret; });

async function fixture() {
  const db = database(), f = await contractFixture(db), item = await f.create('Private');
  const bytes = new Map<string, Buffer>(); let afterRead: (() => Promise<void>) | undefined;
  const objects = { putImmutable: async (key: string, value: Buffer) => { if (bytes.has(key)) throw new Error('Immutable object exists'); bytes.set(key, Buffer.from(value)); },
    read: async (key: string) => { const value = bytes.get(key); if (!value) throw new Error('Missing object'); await afterRead?.(); return Buffer.from(value); } };
  const scanner = { process: async () => ({ scanStatus: 'CLEAN' as const, processed: true }) };
  const artifacts = new FileArtifactService(objects, scanner), prepared = await artifacts.prepare(f.workspace.id, Buffer.from('Private content'), 'text/plain');
  const fileId = await db.$transaction(tx => artifacts.publish(tx, f.actor, prepared, 'Private.txt'), { timeout: 30000 });
  const context = resetAppContextForTests(); context.store.state = await hydrateState(db);
  context.collab = new CollaborationModule({ store: context.store, access: context.access, realtime: new RealtimeHub(), files: () => new UnconfiguredFilePort(),
    authorizeFileContent: (actor, key, purpose) => db.$transaction(tx => authorizeSpaFileBindings(tx, f.policies, actor.workspaceId, actor.user.id, key, purpose)) });
  context.collab.files.uploads.configure(objects, scanner);
  const registry = new SpaSharedRegistry(db); registry.bind(context);
  const actor = context.access.actor(context.store.state.users.find(u => u.id === f.user.id)!, f.workspace.id);
  await registry.prepare(context, new NextRequest('http://test.local/api/v1/attachments', { method: 'POST', body: JSON.stringify({ entityId: item.id }) }), f.user.id, f.workspace.id);
  const before = context.store.cloneState();
  const attachment = context.collab.attachments.attach(actor, new Body({ fileId, entityType: 'SPA_ITEM', entityId: item.id }));
  await db.$transaction(tx => persistStateInTransaction(tx, before, context.store.state), { timeout: 30000 });
  const redeem = (path: string) => { const url = new URL(path, 'http://test.local'); return context.collab.files.delivery.redeem(url.pathname.split('/').at(-1)!, url.searchParams, 'test'); };
  return { ...f, db, item, objects, context, registry, sharedActor: actor, attachment, fileId, prepared, redeem,
    duringRead: (callback: () => Promise<void>) => { afterRead = callback; } };
}
describe('SPA ordinary shared File authority and lifecycle', () => {
  it('cached delivery succeeds with a cleared request snapshot and current SQL Item authority', async () => {
    const f = await fixture(), grant = await f.context.collab.files.delivery.issue(f.sharedActor, f.fileId, new URLSearchParams());
    f.registry.clear();
    expect((await f.redeem(grant.deliveryPath)).bytes.toString()).toBe('Private content');
  });
  it('cached delivery rejects a policy change before consuming bytes', async () => {
    const f = await fixture(), grant = await f.context.collab.files.delivery.issue(f.sharedActor, f.fileId, new URLSearchParams());
    await f.matrix({ rolePolicies: [{ roleId: f.role.id, action: 'SPA.ITEM.READ', scope: 'NONE' }] });
    f.registry.clear(); await expect(f.redeem(grant.deliveryPath)).rejects.toMatchObject({ status: 410 });
    expect(f.context.store.state.fileDeliveryGrants[0].consumedAt).toBeNull();
  });
  it('byte delivery rechecks Item authority after provider I/O', async () => {
    const f = await fixture(), grant = await f.context.collab.files.delivery.issue(f.sharedActor, f.fileId, new URLSearchParams());
    f.duringRead(async () => { await f.matrix({ rolePolicies: [{ roleId: f.role.id, action: 'SPA.ITEM.READ', scope: 'NONE' }] }); });
    await expect(f.redeem(grant.deliveryPath)).rejects.toMatchObject({ status: 410 });
    expect(f.context.store.state.fileDeliveryGrants[0].consumedAt).toBeNull();
  });
  it('trash and restore preserve the owning File, version, binding and immutable history', async () => {
    const f = await fixture(); const deleted = await f.items.lifecycle(f.actor, f.type.id, f.item.id, { expectedVersion: 1 });
    expect(await f.db.fileAttachment.findUnique({ where: { id: f.attachment.id } })).toMatchObject({ fileId: f.fileId });
    await expect(f.db.$transaction(tx => authorizeSpaFileBindings(tx, f.policies, f.workspace.id, f.user.id, f.prepared.objectKey, 'DOWNLOAD'))).rejects.toMatchObject({ status: 403 });
    await f.items.lifecycle(f.actor, f.type.id, f.item.id, { expectedVersion: deleted.version }, true);
    expect(await f.db.driveFile.count({ where: { id: f.fileId } })).toBe(1); expect(await f.db.driveFileVersion.count({ where: { fileId: f.fileId } })).toBe(1);
    expect(await f.db.spaHistory.count({ where: { itemId: f.item.id, action: { in: ['SPA_ITEM_TRASHED','SPA_ITEM_RESTORED'] } } })).toBe(2);
  });
  it('physical purge retains shared objects and refuses held or restored Items', async () => {
    const f = await fixture(), service = new SpaTransferService(f.db);
    await f.items.lifecycle(f.actor, f.type.id, f.item.id, { expectedVersion: 1 });
    await expect(service.queuePurge(f.actor, f.type.id, f.item.id, {})).rejects.toMatchObject({ code: 'SPA_PURGE_BLOCKED' });
    await f.db.spaItem.update({ where: { id: f.item.id }, data: { purgeAfter: new Date(Date.now() - 1000), legalHold: true } });
    await expect(service.queuePurge(f.actor, f.type.id, f.item.id, {})).rejects.toMatchObject({ code: 'SPA_RETENTION_HOLD' });
    await f.db.spaItem.update({ where: { id: f.item.id }, data: { legalHold: false } });
    await service.queuePurge(f.actor, f.type.id, f.item.id, {});
    expect((await service.runPurges()).purged).toBe(1);
    expect(await f.db.spaItem.count({ where: { id: f.item.id } })).toBe(0);
    expect(await f.db.driveFile.count({ where: { id: f.fileId } })).toBe(1); expect(await f.db.fileAttachment.count({ where: { id: f.attachment.id } })).toBe(1);
    expect(await f.db.spaHistory.count({ where: { itemId: f.item.id } })).toBeGreaterThan(0);
    expect(await f.db.outboxEvent.count({ where: { entityId: f.item.id, eventType: 'SPA_ITEM_PURGED' } })).toBe(1);
  });
});
