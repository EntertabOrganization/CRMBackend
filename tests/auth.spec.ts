import { verifiedUser, testApp } from './helpers';

describe('Authentication module', () => {
  it('normalizes signup email, stores token hashes, and waits for verification before workspace bootstrap', async () => {
    const app = testApp();
    const result = await app.auth.signup({
      firstName: 'Faris',
      lastName: 'Hassan',
      email: ' Faris@Example.com ',
      password: 'Password1',
    });

    expect(result.user.email).toBe('faris@example.com');
    expect(app.store.state.authIdentities[0].passwordHash).not.toBe('Password1');
    expect(app.store.state.emailVerificationTokens[0].tokenHash).not.toBe(result.verificationToken);
    expect(app.store.state.emailVerificationTokens[0].expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    expect(app.store.state.workspaces).toHaveLength(0);
  });

  it('verifies email and atomically creates workspace, Owner/Admin role, membership, session and audit logs', async () => {
    const { app, session, user } = await verifiedUser();

    expect(user.status).toBe('ACTIVE');
    expect(session.workspace?.name).toBe("Faris's Workspace");
    expect(session.role?.isOwnerRole).toBe(true);
    expect(session.membership?.userId).toBe(user.id);
    expect(session.accessToken).toBeTruthy();
    expect(session.refreshToken).toBeTruthy();
    expect(app.store.state.auditLogs.map((log) => log.action)).toEqual(
      expect.arrayContaining(['AUTH.EMAIL_VERIFIED', 'WORKSPACE.CREATED']),
    );
  });

  it('rejects duplicate normalized emails', async () => {
    const app = testApp();
    await app.auth.signup({ firstName: 'A', lastName: 'B', email: 'a@example.com', password: 'Password1' });
    await expect(app.auth.signup({ firstName: 'A', lastName: 'B', email: ' A@EXAMPLE.COM ', password: 'Password1' }))
      .rejects.toMatchObject({ code: 'EMAIL_ALREADY_EXISTS' });
  });

  it('rejects unverified, suspended and soft-deleted users at signin', async () => {
    const app = testApp();
    await app.auth.signup({ firstName: 'A', lastName: 'B', email: 'a@example.com', password: 'Password1' });
    await expect(app.auth.signin('a@example.com', 'Password1')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const user = app.store.state.users[0];
    user.status = 'SUSPENDED';
    await expect(app.auth.signin('a@example.com', 'Password1')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    user.status = 'ACTIVE';
    user.isDeleted = true;
    await expect(app.auth.signin('a@example.com', 'Password1')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('rotates refresh tokens and rejects the previous token', async () => {
    const { app, session } = await verifiedUser();
    const refreshed = await app.auth.refresh(session.refreshToken);
    expect(refreshed.refreshToken).not.toBe(session.refreshToken);
    await expect(app.auth.refresh(session.refreshToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('password reset revokes active sessions', async () => {
    const { app, session, user } = await verifiedUser();
    const reset = await app.auth.forgotPassword(user.email);
    await app.auth.resetPassword(reset.resetToken!, 'NewPass1');
    await expect(app.auth.refresh(session.refreshToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(app.auth.signin(user.email, 'Password1')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(app.auth.signin(user.email, 'NewPass1')).resolves.toHaveProperty('accessToken');
  });

  it('links Google identity by verified normalized email without duplicate user', async () => {
    const { app, user } = await verifiedUser();
    app.google.addCredential('google-token', {
      providerUserId: 'google-1',
      email: 'FARIS@example.com',
      emailVerified: true,
      firstName: 'Faris',
      lastName: 'Hassan',
    });
    await app.auth.googleAuth('google-token');
    expect(app.store.state.users).toHaveLength(1);
    expect(app.store.state.authIdentities.some((identity) => identity.userId === user.id && identity.provider === 'GOOGLE')).toBe(true);
  });
});
