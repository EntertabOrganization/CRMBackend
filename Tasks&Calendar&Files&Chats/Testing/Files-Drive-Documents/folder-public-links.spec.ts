import { expectAppError } from '@/tests/support/domain';
import { b, collabApp, perms } from '../support/domain';

describe('Revocable folder public capabilities', () => {
  it('protects secrets, requires passwords, limits tree scope and never revives a trashed link', async () => {
    const c = await collabApp(), s = c.collab.files.storages, links = c.collab.files.publicLinks;
    const storage = s.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Public' })), root = s.root(c.owner, storage.id);
    const branch = s.createFolder(c.owner, b({ storageId: storage.id, parentFolderId: root.id, name: 'Branch' }));
    const child = s.createFolder(c.owner, b({ storageId: storage.id, parentFolderId: branch.id, name: 'Child' }));
    const created = await links.createFolder(c.owner, branch.id, b({ password: 'sharing-password', includeChildren: true }));
    expect(created.token).toHaveLength(43);
    expect(JSON.stringify(links.get(c.owner, created.id))).not.toMatch(/tokenHash|passwordHash|sharing-password/);
    expect(JSON.stringify(c.state.auditLogs)).not.toContain(created.token);
    await expectAppError(() => links.publicFolder(created.id, new URLSearchParams(), null, 'client'), 'PUBLIC_LINK_NOT_FOUND', 404);
    await expectAppError(() => links.publicFolder(created.token, new URLSearchParams(), 'wrong', 'client'), 'PUBLIC_LINK_PASSWORD_INVALID', 403);
    expect((await links.publicFolder(created.token, new URLSearchParams(), 'sharing-password', 'client')).children).toHaveLength(1);
    c.collab.files.folders.move(c.owner, child.id, b({ parentFolderId: root.id, version: child.version }));
    await expectAppError(() => links.publicFolder(created.token, new URLSearchParams({ folderId: child.id }), 'sharing-password', 'client'), 'PUBLIC_LINK_NOT_FOUND', 404);
    c.collab.files.folders.trash(c.owner, branch.id, b({ version: branch.version }));
    await expectAppError(() => links.publicFolder(created.token, new URLSearchParams(), 'sharing-password', 'client'), 'PUBLIC_LINK_REVOKED', 410);
    c.collab.files.folders.restore(c.owner, branch.id, b({ version: branch.version }));
    await expectAppError(() => links.publicFolder(created.token, new URLSearchParams(), 'sharing-password', 'client'), 'PUBLIC_LINK_REVOKED', 410);
  });
  it('enforces action/resource authority, expiry policy and irreversible revocation', async () => {
    const c = await collabApp();
    const manager = await c.memberActor('public-link-manager', perms('WORKSPACE', 'file.public_link_manage'));
    const foreign = await c.foreignActor();
    const s = c.collab.files.storages, links = c.collab.files.publicLinks;
    const storage = s.createStorage(c.owner, b({ type: 'PERSONAL', name: 'Policies' })), root = s.root(c.owner, storage.id);
    await expectAppError(() => links.createFolder(manager, root.id, b()), 'FOLDER_NOT_FOUND', 404);
    await expectAppError(() => links.createFolder(foreign, root.id, b()), 'FOLDER_NOT_FOUND', 404);
    c.state.workspaces.find(workspace => workspace.id === c.owner.workspaceId)!.settings.publicLinkMaxExpiryDays = 7;
    await expectAppError(() => links.createFolder(c.owner, root.id, b({ expiresAt: new Date(Date.now() + 8 * 86400000).toISOString() })), 'PUBLIC_LINK_POLICY_INVALID', 400);
    const created = await links.createFolder(c.owner, root.id, b());
    expect(created.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(7 * 86400000);
    expect(links.list(c.owner, new URLSearchParams()).data).toHaveLength(1);
    const updated = await links.update(c.owner, created.id, b({ includeChildren: true, password: 'another-password', version: 1 }));
    await expectAppError(() => links.update(c.owner, created.id, b({ version: 1, includeChildren: false })), 'RESOURCE_VERSION_CONFLICT', 409);
    const row = c.state.filePublicLinks.find(row => row.id === created.id)!;
    row.expiresAt = new Date(0);
    await expectAppError(() => links.publicFolder(created.token, new URLSearchParams(), 'another-password', 'client'), 'PUBLIC_LINK_EXPIRED', 410);
    links.revoke(c.owner, created.id, b({ version: updated.version }));
    await expectAppError(() => links.update(c.owner, created.id, b({ version: row.version, isActive: true })), 'PUBLIC_LINK_REVOKED', 410);
  });
});
