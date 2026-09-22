import { verifiedUser } from './helpers';

describe('User, partner and audit module', () => {
  it('invites users with a mandatory role and never globally deletes another user as workspace owner', async () => {
    const { app, user, workspace } = await verifiedUser();
    const role = app.roles.create(user, workspace.id, { name: 'Member' });
    const invitation = await app.users.invite(user, { workspaceId: workspace.id, email: 'new@example.com', roleId: role.id });
    expect('tokenHash' in invitation.invitation).toBe(false);

    const invited = await app.auth.signup({ firstName: 'New', lastName: 'User', email: 'new@example.com', password: 'Password1' });
    await app.auth.verifyEmail(invited.verificationToken);
    const invitedUser = app.store.state.users.find((candidate) => candidate.email === 'new@example.com')!;
    expect(() => app.users.softDelete(user, invitedUser.id)).toThrow('Workspace owners cannot globally delete another user.');
  });

  it('keeps audit logs immutable and preserves them after hard workspace deletion', async () => {
    const { app, user, workspace } = await verifiedUser();
    app.workspaces.softDelete(user, workspace.id);
    app.workspaces.hardDelete(user, workspace.id);
    expect(app.store.state.workspaces.some((item) => item.id === workspace.id)).toBe(false);
    expect(app.store.state.auditLogs.some((log) => log.workspaceId === workspace.id)).toBe(true);
  });

  it('approves partner applications only for platform admin users', async () => {
    const { app, user } = await verifiedUser();
    const application = app.partners.submitApplication(user, {
      phone: '+201000000000',
      partnerName: 'EntertabCRM',
      country: 'EG',
      businessDescription: 'Implementation partner',
    });
    expect(() => app.partners.approve(false, user.id, application.id)).toThrow('Platform admin access is required.');
    const approved = app.partners.approve(true, user.id, application.id);
    expect(approved.partner.defaultDiscount).toBe(10);
    expect(app.store.state.partnerMemberships[0].userId).toBe(user.id);
  });
});
