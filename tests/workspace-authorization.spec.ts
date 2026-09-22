import { verifiedUser } from './helpers';

describe('Workspace and authorization module', () => {
  it('validates workspace membership when switching active workspace', async () => {
    const { app, user, workspace } = await verifiedUser();
    expect(app.workspaces.switchWorkspace(user, workspace.id).workspace.id).toBe(workspace.id);
    await expect(async () => app.workspaces.switchWorkspace(user, crypto.randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('blocks Owner/Admin role permission edits and deletion', async () => {
    const { app, user, workspace, session } = await verifiedUser();
    expect(() => app.roles.replacePermissions(user, workspace.id, session.role!.id, [])).toThrow('Owner/Admin role permissions are implicit and protected.');
    expect(() => app.roles.delete(user, workspace.id, session.role!.id)).toThrow('Owner/Admin role is protected.');
  });

  it('blocks role deletion while assigned to an active member', async () => {
    const { app, user, workspace } = await verifiedUser();
    const role = app.roles.create(user, workspace.id, { name: 'Agent' });
    app.store.state.workspaceMemberships.push({
      id: crypto.randomUUID(),
      workspaceId: workspace.id,
      userId: crypto.randomUUID(),
      roleId: role.id,
      status: 'ACTIVE',
      isDeleted: false,
    });
    expect(() => app.roles.delete(user, workspace.id, role.id)).toThrow('Role is assigned to active workspace members.');
  });
});
