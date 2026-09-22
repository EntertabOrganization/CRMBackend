import type { SessionContext, User } from './domain';
import { AuditService } from './audit-service';
import { badRequest, conflict, forbidden, notFound, unauthorized } from './errors';
import type { GoogleAuthProvider, MailService } from './providers';
import { safeUser } from './sanitize';
import {
  addDays,
  addHours,
  assertPasswordPolicy,
  hashSecret,
  newSecretToken,
  normalizeEmail,
  signAccessToken,
  verifyHash,
} from './security';
import type { InMemoryStore } from './store';
import { WorkspaceService } from './workspace-service';

type AuthResult = SessionContext & {
  accessToken: string;
  refreshToken: string;
};

export class AuthService {
  constructor(
    private readonly store: InMemoryStore,
    private readonly mailer: MailService,
    private readonly google: GoogleAuthProvider,
  ) {}

  async signup(input: { firstName: string; lastName: string; email: string; password: string }) {
    assertPasswordPolicy(input.password);
    const email = normalizeEmail(input.email);
    if (this.store.state.users.some((user) => user.email === email)) {
      throw conflict('EMAIL_ALREADY_EXISTS', 'A user with this email already exists.');
    }

    const token = newSecretToken();
    const user: User = {
      id: this.store.id(),
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      email,
      settings: {},
      meta: null,
      status: 'PENDING_VERIFICATION',
      emailVerifiedAt: null,
      isDeleted: false,
    };
    this.store.state.users.push(user);
    this.store.state.authIdentities.push({
      id: this.store.id(),
      userId: user.id,
      provider: 'LOCAL',
      providerUserId: null,
      passwordHash: await hashSecret(input.password),
      isDeleted: false,
    });
    this.store.state.emailVerificationTokens.push({
      id: this.store.id(),
      userId: user.id,
      tokenHash: await hashSecret(token),
      expiresAt: addHours(new Date(), 24),
      consumedAt: null,
      isDeleted: false,
    });
    new AuditService(this.store).write({
      actorUserId: user.id,
      action: 'AUTH.USER_SIGNED_UP',
      entityType: 'User',
      entityId: user.id,
      afterData: safeUser(user),
    });
    await this.mailer.sendVerificationEmail(email, token);
    return { user: safeUser(user), verificationToken: token };
  }

  async verifyEmail(token: string): Promise<AuthResult> {
    const now = new Date();
    const record = await this.findValidToken(this.store.state.emailVerificationTokens, token, now);
    const user = this.store.state.users.find((item) => item.id === record.userId && !item.isDeleted);
    if (!user || user.status !== 'PENDING_VERIFICATION') {
      throw badRequest('TOKEN_INVALID', 'Email verification token is invalid.');
    }

    user.status = 'ACTIVE';
    user.emailVerifiedAt = now;
    record.consumedAt = now;
    const workspace = await new WorkspaceService(this.store).bootstrapFirstWorkspace(user);
    return this.issueSession(user, workspace.id, 'AUTH.EMAIL_VERIFIED');
  }

  async resendVerification(emailInput: string) {
    const email = normalizeEmail(emailInput);
    const user = this.store.state.users.find((item) => item.email === email && item.status === 'PENDING_VERIFICATION' && !item.isDeleted);
    if (!user) return { sent: true };

    for (const existing of this.store.state.emailVerificationTokens.filter((item) => item.userId === user.id && !item.consumedAt)) {
      existing.consumedAt = new Date();
    }
    const token = newSecretToken();
    this.store.state.emailVerificationTokens.push({
      id: this.store.id(),
      userId: user.id,
      tokenHash: await hashSecret(token),
      expiresAt: addHours(new Date(), 24),
      consumedAt: null,
      isDeleted: false,
    });
    await this.mailer.sendVerificationEmail(email, token);
    return { sent: true, verificationToken: token };
  }

  async signin(emailInput: string, password: string): Promise<AuthResult> {
    const email = normalizeEmail(emailInput);
    const user = this.store.state.users.find((item) => item.email === email);
    const identity = user
      ? this.store.state.authIdentities.find((item) => item.userId === user.id && item.provider === 'LOCAL' && !item.isDeleted)
      : null;
    if (!user || !identity || !(await verifyHash(identity.passwordHash, password))) {
      new AuditService(this.store).write({ action: 'AUTH.SIGN_IN_FAILED', entityType: 'User', metadata: { email } });
      throw unauthorized('Invalid email or password.');
    }
    this.assertCanAuthenticate(user);
    return this.issueSession(user, undefined, 'AUTH.SIGN_IN_SUCCEEDED');
  }

  async refresh(refreshToken: string): Promise<AuthResult> {
    const now = new Date();
    const session = await this.findValidSession(refreshToken, now);
    const user = this.store.state.users.find((item) => item.id === session.userId);
    if (!user) throw unauthorized('Invalid refresh token.');
    this.assertCanAuthenticate(user);
    session.revokedAt = now;
    return this.issueSession(user, undefined, 'AUTH.REFRESH_ROTATED');
  }

  async logout(refreshToken: string) {
    const session = await this.findValidSession(refreshToken, new Date());
    session.revokedAt = new Date();
    new AuditService(this.store).write({
      actorUserId: session.userId,
      action: 'AUTH.LOGGED_OUT',
      entityType: 'RefreshSession',
      entityId: session.id,
    });
    return { revoked: true };
  }

  async logoutAll(userId: string) {
    const now = new Date();
    for (const session of this.store.state.refreshSessions.filter((item) => item.userId === userId && !item.revokedAt)) {
      session.revokedAt = now;
    }
    new AuditService(this.store).write({
      actorUserId: userId,
      action: 'AUTH.LOGGED_OUT_ALL',
      entityType: 'RefreshSession',
      metadata: { userId },
    });
    return { revoked: true };
  }

  async forgotPassword(emailInput: string) {
    const email = normalizeEmail(emailInput);
    const user = this.store.state.users.find((item) => item.email === email && !item.isDeleted);
    if (!user) return { sent: true };
    const token = newSecretToken();
    this.store.state.passwordResetTokens.push({
      id: this.store.id(),
      userId: user.id,
      tokenHash: await hashSecret(token),
      expiresAt: addHours(new Date(), 1),
      consumedAt: null,
      isDeleted: false,
    });
    new AuditService(this.store).write({
      actorUserId: user.id,
      action: 'AUTH.PASSWORD_RESET_REQUESTED',
      entityType: 'User',
      entityId: user.id,
    });
    await this.mailer.sendPasswordResetEmail(email, token);
    return { sent: true, resetToken: token };
  }

  async resetPassword(token: string, password: string) {
    assertPasswordPolicy(password);
    const record = await this.findValidToken(this.store.state.passwordResetTokens, token, new Date());
    const identity = this.store.state.authIdentities.find((item) => item.userId === record.userId && item.provider === 'LOCAL');
    if (!identity) throw notFound('Local identity');
    identity.passwordHash = await hashSecret(password);
    record.consumedAt = new Date();
    for (const session of this.store.state.refreshSessions.filter((item) => item.userId === record.userId && !item.revokedAt)) {
      session.revokedAt = new Date();
    }
    new AuditService(this.store).write({
      actorUserId: record.userId,
      action: 'AUTH.PASSWORD_RESET_COMPLETED',
      entityType: 'User',
      entityId: record.userId,
    });
    return { reset: true };
  }

  async googleAuth(credential: string): Promise<AuthResult> {
    const profile = await this.google.verifyCredential(credential);
    if (!profile.emailVerified) throw forbidden('Google email must be verified.');
    const email = normalizeEmail(profile.email);
    let user = this.store.state.users.find((item) => item.email === email);
    if (!user) {
      user = {
        id: this.store.id(),
        firstName: profile.firstName,
        lastName: profile.lastName,
        email,
        settings: {},
        meta: null,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        isDeleted: false,
      };
      this.store.state.users.push(user);
      this.store.state.authIdentities.push({
        id: this.store.id(),
        userId: user.id,
        provider: 'GOOGLE',
        providerUserId: profile.providerUserId,
        passwordHash: null,
        isDeleted: false,
      });
      await new WorkspaceService(this.store).bootstrapFirstWorkspace(user);
    } else {
      this.assertCanAuthenticate(user);
      const existing = this.store.state.authIdentities.find((item) => item.userId === user!.id && item.provider === 'GOOGLE');
      if (!existing) {
        this.store.state.authIdentities.push({
          id: this.store.id(),
          userId: user.id,
          provider: 'GOOGLE',
          providerUserId: profile.providerUserId,
          passwordHash: null,
          isDeleted: false,
        });
        new AuditService(this.store).write({
          actorUserId: user.id,
          action: 'AUTH.GOOGLE_IDENTITY_LINKED',
          entityType: 'AuthIdentity',
          metadata: { providerUserId: profile.providerUserId },
        });
      }
    }
    return this.issueSession(user, undefined, 'AUTH.SIGN_IN_SUCCEEDED');
  }

  me(userId: string) {
    const user = this.store.state.users.find((item) => item.id === userId && !item.isDeleted);
    if (!user) throw unauthorized();
    return new WorkspaceService(this.store).resolveSession(user);
  }

  private assertCanAuthenticate(user: User) {
    if (user.status !== 'ACTIVE' || user.isDeleted) {
      throw forbidden('User is not eligible to authenticate.');
    }
  }

  private async issueSession(user: User, workspaceId: string | undefined, action: string): Promise<AuthResult> {
    const refreshToken = newSecretToken();
    const accessToken = await signAccessToken(user.id);
    this.store.state.refreshSessions.push({
      id: this.store.id(),
      userId: user.id,
      tokenHash: await hashSecret(refreshToken),
      expiresAt: addDays(new Date(), 30),
      revokedAt: null,
      isDeleted: false,
    });
    if (workspaceId) user.settings = { ...user.settings, lastActiveWorkspaceId: workspaceId };
    const context = new WorkspaceService(this.store).resolveSession(user);
    new AuditService(this.store).write({
      workspaceId: context.workspace?.id ?? null,
      actorUserId: user.id,
      action,
      entityType: 'User',
      entityId: user.id,
    });
    return { ...context, accessToken, refreshToken };
  }

  private async findValidToken(records: { userId: string; tokenHash: string; expiresAt: Date; consumedAt?: Date | null; isDeleted: boolean }[], token: string, now: Date) {
    for (const record of records) {
      if (!record.isDeleted && !record.consumedAt && record.expiresAt > now && (await verifyHash(record.tokenHash, token))) {
        return record;
      }
    }
    throw badRequest('TOKEN_INVALID', 'Token is invalid or expired.');
  }

  private async findValidSession(refreshToken: string, now: Date) {
    for (const session of this.store.state.refreshSessions) {
      if (!session.isDeleted && !session.revokedAt && session.expiresAt > now && (await verifyHash(session.tokenHash, refreshToken))) {
        return session;
      }
    }
    throw unauthorized('Invalid refresh token.');
  }
}
