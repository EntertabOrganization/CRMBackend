import type { User } from './domain';
import { AuditService } from './audit-service';
import { badRequest, conflict, forbidden, notFound } from './errors';
import type { MailService } from './providers';
import { addDays, hashSecret, newSecretToken, normalizeEmail } from './security';
import { safeUser } from './sanitize';
import type { InMemoryStore } from './store';
import { WorkspaceService } from './workspace-service';

export class UserService {
  constructor(private readonly store: InMemoryStore, private readonly mailer: MailService) {}

  list() {
    return this.store.state.users.filter((user) => !user.isDeleted).map(safeUser);
  }

  get(requester: User, id: string, workspaceId?: string) {
    if (requester.id !== id) {
      if (!workspaceId) throw forbidden();
      new WorkspaceService(this.store).assertMembership(requester.id, workspaceId);
    }
    const user = this.store.state.users.find((item) => item.id === id && !item.isDeleted);
    if (!user) throw notFound('User');
    return safeUser(user);
  }

  async invite(requester: User, input: { workspaceId: string; email: string; roleId: string; firstName?: string; lastName?: string }) {
    const { role } = new WorkspaceService(this.store).assertMembership(requester.id, input.workspaceId);
    if (!role.isOwnerRole) throw forbidden();
    const targetRole = this.store.state.roles.find((item) => item.id === input.roleId && item.workspaceId === input.workspaceId && !item.isDeleted);
    if (!targetRole) throw badRequest('ROLE_REQUIRED', 'A valid role is required before inviting a user.');
    if (targetRole.isOwnerRole) throw forbidden('Owner/Admin role cannot be manually assigned.');

    const email = normalizeEmail(input.email);
    const token = newSecretToken();
    const invitation = {
      id: this.store.id(),
      workspaceId: input.workspaceId,
      email,
      roleId: input.roleId,
      tokenHash: await hashSecret(token),
      status: 'PENDING' as const,
      expiresAt: addDays(new Date(), 7),
      acceptedAt: null,
      invitedById: requester.id,
      isDeleted: false,
    };
    this.store.state.workspaceInvitations.push(invitation);
    new AuditService(this.store).write({
      workspaceId: input.workspaceId,
      actorUserId: requester.id,
      action: 'USER.INVITED',
      entityType: 'WorkspaceInvitation',
      entityId: invitation.id,
      metadata: { email, roleId: input.roleId },
    });
    await this.mailer.sendInvitationEmail(email, token);
    const { tokenHash: _tokenHash, ...safeInvitation } = invitation;
    return { invitation: safeInvitation, invitationToken: token };
  }

  acceptInvitation(user: User, token: string) {
    const now = new Date();
    const invitation = this.store.state.workspaceInvitations.find(
      (item) => item.status === 'PENDING' && !item.isDeleted && item.expiresAt > now,
    );
    if (!invitation || user.email !== invitation.email) throw badRequest('INVITATION_INVALID', 'Invitation is invalid.');
    if (this.store.state.workspaceMemberships.some((item) => item.workspaceId === invitation.workspaceId && item.userId === user.id && !item.isDeleted)) {
      throw conflict('MEMBERSHIP_EXISTS', 'User is already a workspace member.');
    }
    invitation.status = 'ACCEPTED';
    invitation.acceptedAt = now;
    const membership = {
      id: this.store.id(),
      workspaceId: invitation.workspaceId,
      userId: user.id,
      roleId: invitation.roleId,
      status: 'ACTIVE' as const,
      isDeleted: false,
    };
    this.store.state.workspaceMemberships.push(membership);
    new AuditService(this.store).write({
      workspaceId: invitation.workspaceId,
      actorUserId: user.id,
      action: 'USER.INVITATION_ACCEPTED',
      entityType: 'WorkspaceMembership',
      entityId: membership.id,
    });
    return membership;
  }

  updateProfile(requester: User, id: string, input: Partial<Pick<User, 'firstName' | 'lastName' | 'settings' | 'meta'>>) {
    if (requester.id !== id) throw forbidden();
    const user = this.store.state.users.find((item) => item.id === id && !item.isDeleted);
    if (!user) throw notFound('User');
    const before = { ...user };
    Object.assign(user, input);
    new AuditService(this.store).write({
      actorUserId: requester.id,
      action: 'USER.PROFILE_UPDATED',
      entityType: 'User',
      entityId: id,
      beforeData: safeUser(before),
      afterData: safeUser(user),
    });
    return safeUser(user);
  }

  softDelete(requester: User, id: string) {
    if (requester.id !== id) throw forbidden('Workspace owners cannot globally delete another user.');
    requester.isDeleted = true;
    new AuditService(this.store).write({ actorUserId: requester.id, action: 'USER.SOFT_DELETED', entityType: 'User', entityId: id });
    return safeUser(requester);
  }
}
