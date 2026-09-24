import { fullApp } from './support/domain';

describe('session workspace resolution', () => {
  it('skips memberships of deleted workspaces so the user still lands in a live workspace', async () => {
    const { app, user, workspace } = await fullApp();
    const second = await app.workspaces.createOwnedWorkspace(user, 'Second workspace');
    // The first membership now points at a workspace that no longer exists.
    app.workspaces.softDelete(user, workspace.id);
    user.settings = { ...user.settings, lastActiveWorkspaceId: workspace.id };

    const session = app.auth.me(user.id);

    expect(session.workspace?.id).toBe(second.id);
    expect(session.membership?.workspaceId).toBe(second.id);
    expect(session.permissions.length).toBeGreaterThan(0);
  });

  it('returns no workspace (rather than a dangling one) when every workspace is deleted', async () => {
    const { app, user, workspace } = await fullApp();
    app.workspaces.softDelete(user, workspace.id);
    const session = app.auth.me(user.id);
    expect(session.workspace).toBeNull();
    expect(session.membership).toBeNull();
  });
});
