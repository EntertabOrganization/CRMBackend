import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';

describe('Canonical Project Drive dependency', () => {
  it('provisions one storage and root, preserves them through tool toggles and hard deletion', async () => {
    const ctx = await collabApp(); const { owner, collab } = ctx;
    const project = collab.tasks.projects.create(owner, b({ name: 'All project resources', tools: ['TASKS', 'CHAT', 'CALENDAR', 'DRIVE'] }));
    const resources = collab.tasks.projects.linkedResources(owner, project.id);
    const id = resources.DRIVE.resourceId!;
    expect([resources.CHAT.resourceId, resources.CALENDAR.resourceId, id].every(Boolean)).toBe(true);
    expect(collab.files.storages.root(owner, id).storageId).toBe(id);
    collab.tasks.projects.enableTool(owner, project.id, 'DRIVE', false);
    collab.tasks.projects.enableTool(owner, project.id, 'DRIVE', true);
    expect(collab.tasks.projects.linkedResources(owner, project.id).DRIVE.resourceId).toBe(id);
    expect(ctx.state.fileStorages).toHaveLength(1); expect(ctx.state.fileFolders).toHaveLength(1);
    collab.tasks.projects.archive(owner, project.id);
    expect(collab.files.storages.get(owner, id).isReadOnly).toBe(true);
    collab.tasks.projects.unarchive(owner, project.id);
    expect(collab.files.storages.get(owner, id).isReadOnly).toBe(false);
    collab.tasks.projects.softDelete(owner, project.id); collab.tasks.projects.hardDelete(owner, project.id);
    expect(collab.files.storages.get(owner, id)).toMatchObject({ projectId: null, isReadOnly: true });
    expect(collab.files.storages.root(owner, id).storageId).toBe(id);
    expect(ctx.state.outboxEvents.filter(e => e.eventType === 'STORAGE_CREATED' && e.entityId === id)).toHaveLength(1);
  });

  it('uses live Project membership and tenant boundaries for storage and root reads', async () => {
    const ctx = await collabApp(); const { owner, collab } = ctx;
    const alice = await ctx.memberActor('drive-alice', perms('OWN', 'project.read', 'storage.read', 'folder.read'));
    const stranger = await ctx.memberActor('drive-stranger', perms('WORKSPACE', 'storage.read', 'folder.read'));
    const foreign = await ctx.foreignActor();
    const p = collab.tasks.projects.create(owner, b({ name: 'Drive access', tools: ['DRIVE'], memberUserIds: [alice.user.id] }));
    const id = collab.tasks.projects.linkedResources(owner, p.id).DRIVE.resourceId!;
    const root = collab.files.storages.root(alice, id);
    await expectAppError(() => collab.files.storages.get(stranger, id), 'STORAGE_NOT_FOUND', 404);
    await expectAppError(() => collab.files.storages.folder(foreign, root.id), 'FOLDER_NOT_FOUND', 404);
    collab.tasks.projects.removeMember(owner, p.id, alice.user.id);
    await expectAppError(() => collab.files.storages.get(alice, id), 'STORAGE_NOT_FOUND', 404);
    await expectAppError(() => collab.files.storages.folder(alice, root.id), 'FOLDER_NOT_FOUND', 404);
    collab.tasks.projects.addMember(owner, p.id, b({ userId: alice.user.id }));
    expect(collab.files.storages.get(alice, id).id).toBe(id);
  });
});
