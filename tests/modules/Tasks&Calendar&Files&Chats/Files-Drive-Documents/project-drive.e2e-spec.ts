import { randomUUID } from 'node:crypto';
import { call, db, disconnect, expectError, expectOk, member, prepareCollabDatabase, register, type Session } from '../support/e2e';
jest.setTimeout(180_000);
let owner: Session, alice: Session, stranger: Session, foreign: Session;
beforeAll(async () => {
  await prepareCollabDatabase(); owner = await register('drive-owner');
  alice = await member(owner, 'drive-alice', [['project.read', 'OWN'], ['storage.read', 'OWN'], ['folder.read', 'OWN']]);
  stranger = await member(owner, 'drive-stranger', [['storage.read', 'WORKSPACE'], ['folder.read', 'WORKSPACE']]);
  foreign = await register('drive-foreign');
});
afterAll(disconnect);

describe('Project resources through HTTP and PostgreSQL', () => {
  it('atomically provisions and preserves Chat, Calendar, Drive and root through lifecycle', async () => {
    const prisma = await db();
    const p = expectOk(await call(owner, 'POST', 'projects', { body: { name: 'Complete resources', tools: ['TASKS', 'CHAT', 'CALENDAR', 'DRIVE'], memberUserIds: [alice.userId] } }));
    const resources = expectOk(await call(owner, 'GET', `projects/${p.id}/linked-resources`));
    for (const type of ['CHAT', 'CALENDAR', 'DRIVE']) expect(resources[type].resourceId).toBeTruthy();
    const id = resources.DRIVE.resourceId;
    const root = expectOk(await call(alice, 'GET', `file-storages/${id}/root`));
    expectOk(await call(alice, 'GET', `folders/${root.id}`));
    expect(expectOk(await call(alice, 'GET', 'file-storages')).map((s: any) => s.id)).toContain(id);
    expectError(await call(stranger, 'GET', `file-storages/${id}`), 404, 'STORAGE_NOT_FOUND');
    expectError(await call(foreign, 'GET', `folders/${root.id}`), 404, 'FOLDER_NOT_FOUND');
    expectError(await call(null, 'GET', `file-storages/${id}`, { workspaceId: owner.workspaceId }), 401, 'UNAUTHENTICATED');
    expectOk(await call(owner, 'POST', `projects/${p.id}/tools/DRIVE/disable`, { body: {} }));
    expectOk(await call(owner, 'POST', `projects/${p.id}/tools/DRIVE/enable`, { body: {} }));
    expect(expectOk(await call(owner, 'GET', `projects/${p.id}/linked-resources`)).DRIVE.resourceId).toBe(id);
    expect(await prisma.projectFileStorage.count({ where: { projectId: p.id } })).toBe(1);
    expect(await prisma.projectRootFolder.count({ where: { storageId: id } })).toBe(1);
    expectOk(await call(owner, 'POST', `projects/${p.id}/archive`, { body: {} }));
    expect(expectOk(await call(alice, 'GET', `file-storages/${id}`)).isReadOnly).toBe(true);
    expectOk(await call(owner, 'POST', `projects/${p.id}/unarchive`, { body: {} }));
    expect(expectOk(await call(alice, 'GET', `file-storages/${id}`)).isReadOnly).toBe(false);
    expectOk(await call(owner, 'DELETE', `projects/${p.id}/members/${alice.userId}`));
    expectError(await call(alice, 'GET', `folders/${root.id}`), 404, 'FOLDER_NOT_FOUND');
    expectOk(await call(owner, 'POST', `projects/${p.id}/members`, { body: { userId: alice.userId } }));
    expectOk(await call(owner, 'DELETE', `projects/${p.id}`, { body: {} }));
    expectOk(await call(owner, 'DELETE', `projects/${p.id}/hard`, { body: {} }));
    expect(expectOk(await call(alice, 'GET', `file-storages/${id}`))).toMatchObject({ projectId: null, isReadOnly: true });
    expect(expectOk(await call(alice, 'GET', `folders/${root.id}`)).id).toBe(root.id);
    expect(await prisma.outboxEvent.count({ where: { eventType: 'STORAGE_CREATED', entityId: id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'STORAGE.PROVISIONED', entityId: id } })).toBe(1);
  });

  it('enforces canonical links and composite storage/root tenant references in PostgreSQL', async () => {
    const prisma = await db();
    const p = expectOk(await call(owner, 'POST', 'projects', { body: { name: 'Drive SQL', tools: ['DRIVE'] } }));
    expectOk(await call(owner, 'GET', `projects/${p.id}/linked-resources`));
    const storage = (await prisma.projectFileStorage.findUnique({ where: { projectId: p.id } }))!;
    const root = (await prisma.projectRootFolder.findFirst({ where: { storageId: storage.id, parentFolderId: null } }))!;
    await expect(prisma.projectFileStorage.create({ data: { ...storage, id: randomUUID() } })).rejects.toThrow();
    await expect(prisma.projectFileStorage.create({ data: { ...storage, id: randomUUID(), workspaceId: foreign.workspaceId } })).rejects.toThrow();
    await expect(prisma.projectRootFolder.create({ data: { ...root, id: randomUUID() } })).rejects.toThrow();
    await expect(prisma.projectRootFolder.update({ where: { id: root.id }, data: { workspaceId: foreign.workspaceId } })).rejects.toThrow();
    expect((await prisma.projectRootFolder.findUnique({ where: { id: root.id } }))?.workspaceId).toBe(owner.workspaceId);
  });
});
