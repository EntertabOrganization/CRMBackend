import { fullApp, verified } from './support/domain';

it('accepts only the matching recipient and token when several invitations are pending', async () => {
  const { app, user: owner, workspace } = await fullApp();
  const target = await verified(app, 'invited'), unrelated = await verified(app, 'unrelated');
  const role = app.roles.create(owner, workspace.id, { name: 'Invited member' });
  const first = await app.users.invite(owner, { workspaceId: workspace.id, email: unrelated.user.email, roleId: role.id });
  const second = await app.users.invite(owner, { workspaceId: workspace.id, email: target.user.email, roleId: role.id });
  await expect(app.users.acceptInvitation(target.user, first.invitationToken)).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
  await expect(app.users.acceptInvitation(target.user, 'wrong-token')).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
  const membership = await app.users.acceptInvitation(target.user, second.invitationToken);
  expect(membership).toMatchObject({ workspaceId: workspace.id, userId: target.user.id, roleId: role.id });
  expect(app.store.state.workspaceInvitations.find(row => row.id === first.invitation.id)!.status).toBe('PENDING');
  await expect(app.users.acceptInvitation(target.user, second.invitationToken)).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
});

it('rejects expired invitations and prevents concurrent acceptance from creating duplicate membership', async () => {
  const { app, user: owner, workspace } = await fullApp();
  const target = await verified(app, 'invited');
  const role = app.roles.create(owner, workspace.id, { name: 'Invited member' });
  const expired = await app.users.invite(owner, { workspaceId: workspace.id, email: target.user.email, roleId: role.id });
  app.store.state.workspaceInvitations.find(row => row.id === expired.invitation.id)!.expiresAt = new Date(0);
  await expect(app.users.acceptInvitation(target.user, expired.invitationToken)).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
  const live = await app.users.invite(owner, { workspaceId: workspace.id, email: target.user.email, roleId: role.id });
  const attempts = await Promise.allSettled([1, 2].map(() => app.users.acceptInvitation(target.user, live.invitationToken)));
  expect(attempts.filter(row => row.status === 'fulfilled')).toHaveLength(1);
  expect(app.store.state.workspaceMemberships.filter(row => row.workspaceId === workspace.id && row.userId === target.user.id)).toHaveLength(1);
});
