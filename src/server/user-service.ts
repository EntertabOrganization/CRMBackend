import type { User } from './domain';
import { AuditService } from './audit-service';
import { badRequest, conflict, forbidden, notFound } from './errors';
import type { MailService } from './providers';
import { addDays, hashSecret, newSecretToken, normalizeEmail, verifyHash } from './security';
import { safeUser } from './sanitize';
import type { InMemoryStore } from './store';
import { WorkspaceService } from './workspace-service';

export class UserService {
  constructor(private readonly store: InMemoryStore, private readonly mailer: MailService) {}

  // Only the caller and users who share an active workspace with them are visible.
  list(requester: User) {
    const workspaceIds = new Set(
      this.store.state.workspaceMemberships
        .filter((membership) => membership.userId === requester.id && !membership.isDeleted)
        .map((membership) => membership.workspaceId),
    );
    const visibleUserIds = new Set([
      requester.id,
      ...this.store.state.workspaceMemberships
        .filter((membership) => workspaceIds.has(membership.workspaceId) && !membership.isDeleted)
        .map((membership) => membership.userId),
    ]);
    // The Automation service identity is an internal principal, never a person to list, assign or invite.
    return this.store.state.users.filter((user) => !user.isDeleted && user.meta?.service !== 'AUTOMATION' && visibleUserIds.has(user.id)).map(safeUser);
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

  async acceptInvitation(user: User, token: string) {
    const candidates = this.store.state.workspaceInvitations.filter(
      (item) => item.email === normalizeEmail(user.email) && item.status === 'PENDING' && !item.isDeleted && item.expiresAt > new Date(),
    );
    let invitation: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      if (await verifyHash(candidate.tokenHash, token)) { invitation = candidate; break; }
    }
    const now = new Date();
    if (!invitation || invitation.status !== 'PENDING' || invitation.isDeleted || invitation.expiresAt <= now) throw badRequest('INVITATION_INVALID', 'Invitation is invalid.');
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

  softDelete(requester: User, id: string, input: { replacementResponsibleUserId?: string } = {}) {
    if (requester.id !== id) throw forbidden('Workspace owners cannot globally delete another user.');
    this.reassignOrBlockCrmResponsibility(requester, input.replacementResponsibleUserId);
    requester.isDeleted = true;
    new AuditService(this.store).write({ actorUserId: requester.id, action: 'USER.SOFT_DELETED', entityType: 'User', entityId: id });
    return safeUser(requester);
  }

  private reassignOrBlockCrmResponsibility(user: User, replacementResponsibleUserId?: string) {
    const ownedRecords = [
      ...this.store.state.crmLeads.filter((record) => record.responsibleUserId === user.id && !record.isDeleted).map((record) => ({ entityType: 'LEAD', record })),
      ...this.store.state.crmDeals.filter((record) => record.responsibleUserId === user.id && !record.isDeleted).map((record) => ({ entityType: 'DEAL', record })),
      ...this.store.state.crmContacts.filter((record) => record.responsibleUserId === user.id && !record.isDeleted).map((record) => ({ entityType: 'CONTACT', record })),
      ...this.store.state.crmCompanies.filter((record) => record.responsibleUserId === user.id && !record.isDeleted).map((record) => ({ entityType: 'COMPANY', record })),
    ];
    if (ownedRecords.length === 0) return;
    if (!replacementResponsibleUserId) {
      throw conflict('CRM_REASSIGNMENT_REQUIRED', 'CRM records must be reassigned before deleting this user.');
    }
    const affectedWorkspaceIds = Array.from(new Set(ownedRecords.map(({ record }) => record.workspaceId)));
    for (const workspaceId of affectedWorkspaceIds) {
      const replacementMembership = this.store.state.workspaceMemberships.find(
        (membership) =>
          membership.workspaceId === workspaceId &&
          membership.userId === replacementResponsibleUserId &&
          membership.status === 'ACTIVE' &&
          !membership.isDeleted,
      );
      if (!replacementMembership) {
        throw badRequest('CRM_REPLACEMENT_REQUIRED', 'Replacement responsible user must be an active member of every affected workspace.');
      }
    }

    for (const { entityType, record } of ownedRecords) {
      const before = { responsibleUserId: record.responsibleUserId, version: record.version };
      record.responsibleUserId = replacementResponsibleUserId;
      record.version += 1;
      record.updatedAt = new Date();
      new AuditService(this.store).write({
        workspaceId: record.workspaceId,
        actorUserId: user.id,
        action: `CRM.${entityType}.ASSIGNED`,
        entityType: `Crm${entityType === 'COMPANY' ? 'Company' : entityType.charAt(0) + entityType.slice(1).toLowerCase()}`,
        entityId: record.id,
        beforeData: before,
        afterData: { responsibleUserId: replacementResponsibleUserId, version: record.version },
      });
    }
  }
}
