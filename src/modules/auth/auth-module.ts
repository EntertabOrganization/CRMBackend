import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';

export type UserStatus = 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED';
export type MembershipStatus = 'ACTIVE' | 'SUSPENDED';
export type PermissionScope = 'OWN' | 'DEPARTMENT' | 'DEPARTMENT_TREE' | 'WORKSPACE';
export type PartnerApplicationStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: unknown = null,
  ) {
    super(message);
  }
}

export interface User {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  settings: Record<string, unknown>;
  meta: Record<string, unknown> | null;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  isDeleted: boolean;
  isPlatformAdmin: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  settings: Record<string, unknown> | null;
  meta: Record<string, unknown> | null;
  ownerUserId: string;
  isDeleted: boolean;
}

export interface Role {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  isOwnerRole: boolean;
  isDeleted: boolean;
}

export interface WorkspaceMembership {
  id: string;
  workspaceId: string;
  userId: string;
  roleId: string;
  status: MembershipStatus;
  isDeleted: boolean;
}

interface AuthIdentity {
  id: string;
  userId: string;
  provider: 'LOCAL' | 'GOOGLE';
  providerUserId: string | null;
  passwordHash: string | null;
  isDeleted: boolean;
}

interface OneTimeToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  isDeleted: boolean;
}

interface RefreshSession {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  isDeleted: boolean;
}

export interface Permission {
  id: string;
  key: string;
  name: string;
  description: string;
  module: string;
  resource: string;
  action: string;
}

interface RolePermission {
  id: string;
  roleId: string;
  permissionId: string;
  scope: PermissionScope;
  isDeleted: boolean;
}

export interface Department {
  id: string;
  workspaceId: string;
  parentDepartmentId: string | null;
  name: string;
  description: string | null;
  managerId: string | null;
  isDeleted: boolean;
}

export interface DepartmentMember {
  id: string;
  workspaceId: string;
  departmentId: string;
  userId: string;
  isDeleted: boolean;
}

interface Invitation {
  id: string;
  workspaceId: string;
  email: string;
  roleId: string;
  tokenHash: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'REVOKED' | 'EXPIRED';
  expiresAt: Date;
  isDeleted: boolean;
}

export interface AuditLog {
  id: string;
  workspaceId: string | null;
  partnerId: string | null;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  beforeData: unknown;
  afterData: unknown;
  metadata: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  occurredAt: Date;
}

export interface PartnerApplication {
  id: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  partnerName: string;
  country: string;
  website: string | null;
  businessDescription: string;
  status: PartnerApplicationStatus;
}

export interface Partner {
  id: string;
  name: string;
  country: string;
  website: string | null;
  businessDescription: string | null;
  status: 'ACTIVE' | 'SUSPENDED';
  defaultDiscount: number;
  discountOverrides: Record<string, number>;
  isDeleted: boolean;
}

interface PartnerMembership {
  id: string;
  partnerId: string;
  userId: string;
  partnerRoleId: string;
  status: MembershipStatus;
  isDeleted: boolean;
}

interface PartnerRole {
  id: string;
  partnerId: string;
  name: string;
  isOwnerRole: boolean;
}

interface PartnerWorkspaceRelation {
  id: string;
  partnerId: string;
  workspaceId: string;
  status: 'ACTIVE' | 'ENDED';
}

interface PartnerWorkspaceAccess {
  id: string;
  partnerId: string;
  workspaceId: string;
  status: 'ACTIVE' | 'REVOKED';
  grantedBy: string;
  expiresAt: Date | null;
}

interface Database {
  users: User[];
  identities: AuthIdentity[];
  verificationTokens: OneTimeToken[];
  resetTokens: OneTimeToken[];
  refreshSessions: RefreshSession[];
  workspaces: Workspace[];
  memberships: WorkspaceMembership[];
  roles: Role[];
  permissions: Permission[];
  rolePermissions: RolePermission[];
  departments: Department[];
  departmentMembers: DepartmentMember[];
  invitations: Invitation[];
  auditLogs: AuditLog[];
  partnerApplications: PartnerApplication[];
  partners: Partner[];
  partnerRoles: PartnerRole[];
  partnerMemberships: PartnerMembership[];
  partnerWorkspaceRelations: PartnerWorkspaceRelation[];
  partnerWorkspaceAccess: PartnerWorkspaceAccess[];
}

export interface QueryOptions {
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  filter?: Record<string, Partial<Record<'eq' | 'neq' | 'in' | 'notIn' | 'contains' | 'startsWith' | 'endsWith' | 'gt' | 'gte' | 'lt' | 'lte' | 'isNull', unknown>>>;
}

const TOKEN_SECRET = 'test-local-secret';
const REFRESH_DAYS = 30;
const ACCESS_MINUTES = 15;

const PERMISSION_KEYS = [
  'workspace.read',
  'workspace.create',
  'workspace.update',
  'workspace.delete',
  'user.read',
  'user.create',
  'user.update',
  'user.delete',
  'department.read',
  'department.create',
  'department.update',
  'department.delete',
  'role.read',
  'role.create',
  'role.update',
  'role.delete',
  'audit.read',
  'partner.company.create',
  'partner.billing.manage',
] as const;

export class AuthModule {
  private db: Database;
  private rateLimits = new Map<string, { count: number; resetAt: number }>();
  public sentMail: Array<{ to: string; template: string; token: string }> = [];
  public googleVerifier: (credential: string) => Promise<{ email: string; emailVerified: boolean; providerUserId: string; firstName: string; lastName: string }> =
    async () => {
      throw new DomainError('GOOGLE_PROVIDER_NOT_CONFIGURED', 'Google provider is not configured.');
    };
  public failNextAuditInsert = false;
  public failNextBootstrap = false;

  constructor() {
    this.db = this.blankDb();
    this.syncPermissions();
  }

  reset(): void {
    this.db = this.blankDb();
    this.rateLimits.clear();
    this.sentMail = [];
    this.syncPermissions();
  }

  get state(): Readonly<Database> {
    return this.db;
  }

  signup(input: { firstName: string; lastName: string; email: string; password: string }): { user: User; verificationToken: string } {
    this.enforceRateLimit('signup', normalizeEmail(input.email));
    this.assertPassword(input.password);
    const email = normalizeEmail(input.email);
    if (this.db.users.some((u) => u.email === email)) {
      throw new DomainError('EMAIL_ALREADY_EXISTS', 'A user with this email already exists.');
    }
    const user: User = {
      id: randomUUID(),
      firstName: input.firstName,
      lastName: input.lastName,
      email,
      settings: {},
      meta: null,
      status: 'PENDING_VERIFICATION',
      emailVerifiedAt: null,
      isDeleted: false,
      isPlatformAdmin: false,
    };
    const rawToken = randomToken();
    this.transaction((tx) => {
      tx.users.push(user);
      tx.identities.push({
        id: randomUUID(),
        userId: user.id,
        provider: 'LOCAL',
        providerUserId: null,
        passwordHash: passwordHash(input.password),
        isDeleted: false,
      });
      tx.verificationTokens.push(this.oneTimeToken(user.id, rawToken, 24));
      this.audit(tx, 'AUTH.USER_SIGNED_UP', 'USER', user.id, { actorUserId: user.id, afterData: user });
    });
    this.sentMail.push({ to: email, template: 'verify-email', token: rawToken });
    return { user: safeUser(user), verificationToken: rawToken };
  }

  verifyEmail(token: string): AuthSession {
    this.enforceRateLimit('verify-email', tokenHash(token));
    const tokenHashValue = tokenHash(token);
    const found = this.db.verificationTokens.find((t) => t.tokenHash === tokenHashValue && !t.isDeleted);
    if (!found || found.consumedAt || found.expiresAt <= new Date()) {
      throw new DomainError('INVALID_OR_EXPIRED_TOKEN', 'Verification token is invalid or expired.');
    }
    let session!: AuthSession;
    this.transaction((tx) => {
      const txToken = required(tx.verificationTokens.find((t) => t.id === found.id), 'INVALID_OR_EXPIRED_TOKEN', 'Verification token is invalid or expired.');
      const user = required(tx.users.find((u) => u.id === found.userId && !u.isDeleted), 'USER_NOT_FOUND', 'User was not found.');
      if (this.failNextBootstrap) {
        this.failNextBootstrap = false;
        throw new DomainError('BOOTSTRAP_FAILED', 'Workspace bootstrap failed.');
      }
      user.status = 'ACTIVE';
      user.emailVerifiedAt = new Date();
      txToken.consumedAt = new Date();
      const workspace = this.createWorkspaceInternal(tx, user, `${user.firstName}'s Workspace`, null);
      this.audit(tx, 'AUTH.EMAIL_VERIFIED', 'USER', user.id, { actorUserId: user.id, workspaceId: workspace.id });
      session = this.issueSessionInternal(tx, user, workspace.id);
    });
    return session;
  }

  resendVerification(emailInput: string): { sent: boolean; verificationToken?: string } {
    const email = normalizeEmail(emailInput);
    this.enforceRateLimit('resend-verification', email);
    const user = this.db.users.find((u) => u.email === email && u.status === 'PENDING_VERIFICATION' && !u.isDeleted);
    if (!user) return { sent: false };
    const rawToken = randomToken();
    this.transaction((tx) => {
      tx.verificationTokens.filter((t) => t.userId === user.id && !t.consumedAt).forEach((t) => (t.consumedAt = new Date()));
      tx.verificationTokens.push(this.oneTimeToken(user.id, rawToken, 24));
    });
    this.sentMail.push({ to: email, template: 'verify-email', token: rawToken });
    return { sent: true, verificationToken: rawToken };
  }

  signin(input: { email: string; password: string }): AuthSession {
    const email = normalizeEmail(input.email);
    this.enforceRateLimit('signin', email);
    const user = this.db.users.find((u) => u.email === email);
    const identity = user && this.db.identities.find((i) => i.userId === user.id && i.provider === 'LOCAL' && !i.isDeleted);
    if (!user || !identity?.passwordHash || !verifyPassword(input.password, identity.passwordHash)) {
      this.safeAudit('AUTH.SIGN_IN_FAILED', 'USER', user?.id ?? null, { metadata: { email } });
      throw new DomainError('INVALID_CREDENTIALS', 'Invalid email or password.');
    }
    this.assertAuthenticatable(user);
    return this.transaction((tx) => {
      const workspaceId = this.resolveActiveWorkspaceId(tx, user);
      const session = this.issueSessionInternal(tx, user, workspaceId);
      this.audit(tx, 'AUTH.SIGN_IN_SUCCEEDED', 'USER', user.id, { actorUserId: user.id, workspaceId });
      return session;
    });
  }

  async googleAuth(credential: string): Promise<AuthSession> {
    const profile = await this.googleVerifier(credential);
    if (!profile.emailVerified) throw new DomainError('GOOGLE_EMAIL_UNVERIFIED', 'Google email must be verified.');
    const email = normalizeEmail(profile.email);
    let session!: AuthSession;
    this.transaction((tx) => {
      let user = tx.users.find((u) => u.email === email);
      if (!user) {
        user = {
          id: randomUUID(),
          firstName: profile.firstName,
          lastName: profile.lastName,
          email,
          settings: {},
          meta: null,
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
          isDeleted: false,
          isPlatformAdmin: false,
        };
        tx.users.push(user);
        tx.identities.push({
          id: randomUUID(),
          userId: user.id,
          provider: 'GOOGLE',
          providerUserId: profile.providerUserId,
          passwordHash: null,
          isDeleted: false,
        });
        const workspace = this.createWorkspaceInternal(tx, user, `${user.firstName}'s Workspace`, null);
        session = this.issueSessionInternal(tx, user, workspace.id);
      } else {
        this.assertAuthenticatable(user);
        const existing = tx.identities.find((i) => i.provider === 'GOOGLE' && i.providerUserId === profile.providerUserId && !i.isDeleted);
        if (!existing) {
          tx.identities.push({ id: randomUUID(), userId: user.id, provider: 'GOOGLE', providerUserId: profile.providerUserId, passwordHash: null, isDeleted: false });
          this.audit(tx, 'AUTH.GOOGLE_IDENTITY_LINKED', 'USER', user.id, { actorUserId: user.id });
        }
        session = this.issueSessionInternal(tx, user, this.resolveActiveWorkspaceId(tx, user));
      }
    });
    return session;
  }

  refresh(refreshToken: string): { accessToken: string; refreshToken: string } {
    this.enforceRateLimit('refresh', tokenHash(refreshToken));
    const session = this.db.refreshSessions.find((s) => s.tokenHash === tokenHash(refreshToken));
    if (!session || session.revokedAt || session.expiresAt <= new Date() || session.isDeleted) {
      throw new DomainError('INVALID_REFRESH_TOKEN', 'Refresh token is expired, revoked or invalid.');
    }
    const user = required(this.db.users.find((u) => u.id === session.userId), 'USER_NOT_FOUND', 'User was not found.');
    this.assertAuthenticatable(user);
    return this.transaction((tx) => {
      const txSession = required(tx.refreshSessions.find((s) => s.id === session.id), 'INVALID_REFRESH_TOKEN', 'Invalid refresh token.');
      txSession.revokedAt = new Date();
      const raw = randomToken();
      tx.refreshSessions.push({
        id: randomUUID(),
        userId: user.id,
        tokenHash: tokenHash(raw),
        expiresAt: addDays(REFRESH_DAYS),
        revokedAt: null,
        isDeleted: false,
      });
      this.audit(tx, 'AUTH.REFRESH_ROTATED', 'REFRESH_SESSION', txSession.id, { actorUserId: user.id });
      return { accessToken: this.signAccessToken(user.id), refreshToken: raw };
    });
  }

  logout(refreshToken: string): void {
    this.transaction((tx) => {
      const session = required(tx.refreshSessions.find((s) => s.tokenHash === tokenHash(refreshToken)), 'INVALID_REFRESH_TOKEN', 'Invalid refresh token.');
      session.revokedAt = new Date();
      this.audit(tx, 'AUTH.LOGGED_OUT', 'REFRESH_SESSION', session.id, { actorUserId: session.userId });
    });
  }

  logoutAll(userId: string): void {
    this.transaction((tx) => {
      tx.refreshSessions.filter((s) => s.userId === userId && !s.revokedAt).forEach((s) => (s.revokedAt = new Date()));
      this.audit(tx, 'AUTH.LOGGED_OUT_ALL', 'USER', userId, { actorUserId: userId });
    });
  }

  forgotPassword(emailInput: string): { sent: boolean; resetToken?: string } {
    const email = normalizeEmail(emailInput);
    this.enforceRateLimit('forgot-password', email);
    const user = this.db.users.find((u) => u.email === email && !u.isDeleted);
    if (!user) return { sent: false };
    const rawToken = randomToken();
    this.transaction((tx) => {
      tx.resetTokens.filter((t) => t.userId === user.id && !t.consumedAt).forEach((t) => (t.consumedAt = new Date()));
      tx.resetTokens.push(this.oneTimeToken(user.id, rawToken, 1));
      this.audit(tx, 'AUTH.PASSWORD_RESET_REQUESTED', 'USER', user.id, { actorUserId: user.id });
    });
    this.sentMail.push({ to: email, template: 'reset-password', token: rawToken });
    return { sent: true, resetToken: rawToken };
  }

  resetPassword(token: string, newPassword: string): void {
    this.enforceRateLimit('reset-password', tokenHash(token));
    this.assertPassword(newPassword);
    const reset = required(this.db.resetTokens.find((t) => t.tokenHash === tokenHash(token) && !t.isDeleted), 'INVALID_OR_EXPIRED_TOKEN', 'Reset token is invalid.');
    if (reset.consumedAt || reset.expiresAt <= new Date()) throw new DomainError('INVALID_OR_EXPIRED_TOKEN', 'Reset token is invalid.');
    this.transaction((tx) => {
      const txReset = required(tx.resetTokens.find((t) => t.id === reset.id), 'INVALID_OR_EXPIRED_TOKEN', 'Reset token is invalid.');
      txReset.consumedAt = new Date();
      const identity = required(tx.identities.find((i) => i.userId === reset.userId && i.provider === 'LOCAL'), 'LOCAL_IDENTITY_NOT_FOUND', 'Local identity was not found.');
      identity.passwordHash = passwordHash(newPassword);
      tx.refreshSessions.filter((s) => s.userId === reset.userId && !s.revokedAt).forEach((s) => (s.revokedAt = new Date()));
      this.audit(tx, 'AUTH.PASSWORD_RESET_COMPLETED', 'USER', reset.userId, { actorUserId: reset.userId });
    });
  }

  me(userId: string): AuthSessionContext {
    const user = required(this.db.users.find((u) => u.id === userId), 'USER_NOT_FOUND', 'User was not found.');
    this.assertAuthenticatable(user);
    const workspaceId = this.resolveActiveWorkspaceId(this.db, user);
    return this.buildSessionContext(this.db, user, workspaceId);
  }

  verifyAccessToken(accessToken: string): string {
    try {
      const payload = jwt.verify(accessToken, TOKEN_SECRET) as { sub?: string };
      if (!payload.sub) throw new Error('Missing subject.');
      return payload.sub;
    } catch {
      throw new DomainError('UNAUTHENTICATED', 'A valid access token is required.');
    }
  }

  createWorkspace(actorUserId: string, input: { name: string; description?: string | null }): Workspace {
    const user = required(this.db.users.find((u) => u.id === actorUserId), 'USER_NOT_FOUND', 'User was not found.');
    this.assertAuthenticatable(user);
    return this.transaction((tx) => this.createWorkspaceInternal(tx, user, input.name, input.description ?? null));
  }

  listWorkspaces(userId: string, query: QueryOptions = {}): Paged<Workspace> {
    const ids = new Set(this.db.memberships.filter((m) => m.userId === userId && m.status === 'ACTIVE' && !m.isDeleted).map((m) => m.workspaceId));
    return queryRows(this.db.workspaces.filter((w) => ids.has(w.id) && !w.isDeleted), query, ['name', 'description', 'slug'], ['isDeleted', 'slug', 'name'], ['name', 'slug']);
  }

  getWorkspace(userId: string, workspaceId: string): Workspace {
    this.requireMembership(userId, workspaceId);
    return required(this.db.workspaces.find((w) => w.id === workspaceId && !w.isDeleted), 'WORKSPACE_NOT_FOUND', 'Workspace was not found.');
  }

  switchWorkspace(userId: string, workspaceId: string): AuthSessionContext {
    this.requireMembership(userId, workspaceId);
    const user = required(this.db.users.find((u) => u.id === userId), 'USER_NOT_FOUND', 'User was not found.');
    user.settings.lastActiveWorkspaceId = workspaceId;
    this.safeAudit('WORKSPACE.SWITCHED', 'WORKSPACE', workspaceId, { actorUserId: userId, workspaceId });
    return this.buildSessionContext(this.db, user, workspaceId);
  }

  updateWorkspace(userId: string, workspaceId: string, input: { name: string; description: string | null }, replace = false): Workspace {
    this.requirePermission(userId, workspaceId, 'workspace.update');
    const workspace = required(this.db.workspaces.find((w) => w.id === workspaceId && !w.isDeleted), 'WORKSPACE_NOT_FOUND', 'Workspace was not found.');
    return this.transaction((tx) => {
      const target = required(tx.workspaces.find((w) => w.id === workspace.id), 'WORKSPACE_NOT_FOUND', 'Workspace was not found.');
      target.name = input.name ?? (replace ? '' : target.name);
      target.description = input.description ?? (replace ? null : target.description);
      this.audit(tx, 'WORKSPACE.UPDATED', 'WORKSPACE', workspaceId, { actorUserId: userId, workspaceId, afterData: target });
      return target;
    });
  }

  softDeleteWorkspace(userId: string, workspaceId: string): void {
    this.requirePermission(userId, workspaceId, 'workspace.delete');
    this.transaction((tx) => {
      const workspace = required(tx.workspaces.find((w) => w.id === workspaceId), 'WORKSPACE_NOT_FOUND', 'Workspace was not found.');
      workspace.isDeleted = true;
      this.audit(tx, 'WORKSPACE.SOFT_DELETED', 'WORKSPACE', workspaceId, { actorUserId: userId, workspaceId });
    });
  }

  restoreWorkspace(userId: string, workspaceId: string): void {
    this.transaction((tx) => {
      const workspace = required(tx.workspaces.find((w) => w.id === workspaceId), 'WORKSPACE_NOT_FOUND', 'Workspace was not found.');
      if (workspace.ownerUserId !== userId && !this.isPlatformAdmin(userId)) throw new DomainError('PERMISSION_DENIED', 'Only the owner or platform admin may restore this workspace.');
      workspace.isDeleted = false;
      this.audit(tx, 'WORKSPACE.RESTORED', 'WORKSPACE', workspaceId, { actorUserId: userId, workspaceId });
    });
  }

  hardDeleteWorkspace(userId: string, workspaceId: string): void {
    const workspace = required(this.db.workspaces.find((w) => w.id === workspaceId), 'WORKSPACE_NOT_FOUND', 'Workspace was not found.');
    if (!workspace.isDeleted) throw new DomainError('SOFT_DELETE_REQUIRED', 'Workspace must be soft-deleted before hard deletion.');
    if (workspace.ownerUserId !== userId && !this.isPlatformAdmin(userId)) throw new DomainError('PERMISSION_DENIED', 'Only the owner or platform admin may hard-delete this workspace.');
    this.transaction((tx) => {
      tx.workspaces = tx.workspaces.filter((w) => w.id !== workspaceId);
      tx.memberships = tx.memberships.filter((m) => m.workspaceId !== workspaceId);
      tx.roles = tx.roles.filter((r) => r.workspaceId !== workspaceId);
      tx.departments = tx.departments.filter((d) => d.workspaceId !== workspaceId);
      this.audit(tx, 'WORKSPACE.HARD_DELETED', 'WORKSPACE', workspaceId, { actorUserId: userId, workspaceId });
    });
  }

  transferWorkspaceOwner(actorUserId: string, workspaceId: string, targetUserId: string): void {
    this.transaction((tx) => {
      const workspace = required(tx.workspaces.find((w) => w.id === workspaceId && !w.isDeleted), 'WORKSPACE_NOT_FOUND', 'Workspace was not found.');
      if (workspace.ownerUserId !== actorUserId) throw new DomainError('PERMISSION_DENIED', 'Only the current owner may transfer ownership.');
      const ownerRole = required(tx.roles.find((r) => r.workspaceId === workspaceId && r.isOwnerRole && !r.isDeleted), 'OWNER_ROLE_NOT_FOUND', 'Owner role was not found.');
      const targetMembership = required(tx.memberships.find((m) => m.workspaceId === workspaceId && m.userId === targetUserId && m.status === 'ACTIVE' && !m.isDeleted), 'MEMBERSHIP_NOT_FOUND', 'Target user must be an active workspace member.');
      const formerOwnerMembership = required(tx.memberships.find((m) => m.workspaceId === workspaceId && m.userId === actorUserId && m.status === 'ACTIVE' && !m.isDeleted), 'MEMBERSHIP_NOT_FOUND', 'Current owner membership was not found.');
      const formerOwnerRole = this.ensureTransferFallbackRole(tx, workspaceId);
      targetMembership.roleId = ownerRole.id;
      formerOwnerMembership.roleId = formerOwnerRole.id;
      workspace.ownerUserId = targetUserId;
      this.audit(tx, 'WORKSPACE.OWNER_TRANSFERRED', 'WORKSPACE', workspaceId, { actorUserId, workspaceId, metadata: { targetUserId } });
      this.audit(tx, 'USER.ROLE_CHANGED', 'WORKSPACE_MEMBERSHIP', targetMembership.id, { actorUserId, workspaceId, metadata: { userId: targetUserId, roleId: ownerRole.id } });
      this.audit(tx, 'USER.ROLE_CHANGED', 'WORKSPACE_MEMBERSHIP', formerOwnerMembership.id, { actorUserId, workspaceId, metadata: { userId: actorUserId, roleId: formerOwnerRole.id } });
    });
  }

  listPermissions(query: QueryOptions = {}): Paged<Permission> {
    return queryRows(this.db.permissions, query, ['key', 'name', 'description'], ['module', 'resource', 'action'], ['key', 'name']);
  }

  createRole(actorUserId: string, workspaceId: string, input: { name: string; description?: string | null; permissions?: Array<{ permissionId: string; scope: PermissionScope }> }): Role {
    this.requirePermission(actorUserId, workspaceId, 'role.create');
    return this.transaction((tx) => {
      const role: Role = { id: randomUUID(), workspaceId, name: input.name, description: input.description ?? null, isSystem: false, isOwnerRole: false, isDeleted: false };
      tx.roles.push(role);
      this.replaceRolePermissionsInternal(tx, actorUserId, workspaceId, role.id, input.permissions ?? []);
      this.audit(tx, 'ROLE.CREATED', 'ROLE', role.id, { actorUserId, workspaceId, afterData: role });
      return role;
    });
  }

  listRoles(actorUserId: string, workspaceId: string, query: QueryOptions = {}): Paged<Role> {
    this.requirePermission(actorUserId, workspaceId, 'role.read');
    return queryRows(this.db.roles.filter((r) => r.workspaceId === workspaceId && !r.isDeleted), query, ['name', 'description'], ['isSystem', 'isOwnerRole', 'isDeleted'], ['name']);
  }

  getRole(actorUserId: string, workspaceId: string, roleId: string): Role {
    this.requirePermission(actorUserId, workspaceId, 'role.read');
    return required(this.db.roles.find((r) => r.id === roleId && r.workspaceId === workspaceId && !r.isDeleted), 'ROLE_NOT_FOUND', 'Role was not found.');
  }

  updateRole(actorUserId: string, workspaceId: string, roleId: string, input: { name?: string; description?: string | null }, replace = false): Role {
    this.requirePermission(actorUserId, workspaceId, 'role.update');
    return this.transaction((tx) => {
      const role = required(tx.roles.find((r) => r.id === roleId && r.workspaceId === workspaceId && !r.isDeleted), 'ROLE_NOT_FOUND', 'Role was not found.');
      if (role.isOwnerRole || role.isSystem) throw new DomainError('PROTECTED_ROLE', 'Owner/Admin role is protected.');
      role.name = input.name ?? (replace ? '' : role.name);
      role.description = input.description ?? (replace ? null : role.description);
      this.audit(tx, 'ROLE.UPDATED', 'ROLE', roleId, { actorUserId, workspaceId, afterData: role });
      return role;
    });
  }

  replaceRolePermissions(actorUserId: string, workspaceId: string, roleId: string, permissions: Array<{ permissionId: string; scope: PermissionScope }>): void {
    this.requirePermission(actorUserId, workspaceId, 'role.update');
    this.transaction((tx) => this.replaceRolePermissionsInternal(tx, actorUserId, workspaceId, roleId, permissions));
  }

  deleteRole(actorUserId: string, workspaceId: string, roleId: string): void {
    this.requirePermission(actorUserId, workspaceId, 'role.delete');
    this.transaction((tx) => {
      const role = required(tx.roles.find((r) => r.id === roleId && r.workspaceId === workspaceId), 'ROLE_NOT_FOUND', 'Role was not found.');
      if (role.isOwnerRole || role.isSystem) throw new DomainError('PROTECTED_ROLE', 'Owner/Admin role is protected.');
      if (tx.memberships.some((m) => m.roleId === roleId && !m.isDeleted && m.status === 'ACTIVE')) throw new DomainError('ROLE_IN_USE', 'Role is still assigned to active members.');
      role.isDeleted = true;
      this.audit(tx, 'ROLE.SOFT_DELETED', 'ROLE', roleId, { actorUserId, workspaceId });
    });
  }

  restoreRole(actorUserId: string, workspaceId: string, roleId: string): void {
    this.requirePermission(actorUserId, workspaceId, 'role.delete');
    this.transaction((tx) => {
      const role = required(tx.roles.find((r) => r.id === roleId && r.workspaceId === workspaceId), 'ROLE_NOT_FOUND', 'Role was not found.');
      if (role.isOwnerRole || role.isSystem) throw new DomainError('PROTECTED_ROLE', 'Owner/Admin role is protected.');
      role.isDeleted = false;
      this.audit(tx, 'ROLE.RESTORED', 'ROLE', roleId, { actorUserId, workspaceId });
    });
  }

  hardDeleteRole(actorUserId: string, workspaceId: string, roleId: string): void {
    this.requirePermission(actorUserId, workspaceId, 'role.delete');
    const role = required(this.db.roles.find((r) => r.id === roleId && r.workspaceId === workspaceId), 'ROLE_NOT_FOUND', 'Role was not found.');
    if (role.isOwnerRole || role.isSystem) throw new DomainError('PROTECTED_ROLE', 'Owner/Admin role is protected.');
    if (!role.isDeleted) throw new DomainError('SOFT_DELETE_REQUIRED', 'Role must be soft-deleted before hard deletion.');
    this.transaction((tx) => {
      tx.rolePermissions = tx.rolePermissions.filter((rp) => rp.roleId !== roleId);
      tx.roles = tx.roles.filter((r) => r.id !== roleId);
      this.audit(tx, 'ROLE.HARD_DELETED', 'ROLE', roleId, { actorUserId, workspaceId });
    });
  }

  inviteUser(actorUserId: string, workspaceId: string, input: { email: string; roleId?: string }): { invitation: Invitation; invitationToken: string } {
    this.requirePermission(actorUserId, workspaceId, 'user.create');
    if (!input.roleId) throw new DomainError('ROLE_REQUIRED', 'roleId is required.');
    const role = required(this.db.roles.find((r) => r.id === input.roleId && r.workspaceId === workspaceId && !r.isDeleted), 'ROLE_NOT_FOUND', 'Role was not found.');
    if (role.isOwnerRole || role.isSystem) throw new DomainError('PROTECTED_ROLE', 'Owner/Admin role can only move through ownership transfer.');
    const raw = randomToken();
    return this.transaction((tx) => {
      tx.invitations.filter((i) => i.email === normalizeEmail(input.email) && i.workspaceId === workspaceId && i.status === 'PENDING').forEach((i) => (i.status = 'REVOKED'));
      const invitation: Invitation = { id: randomUUID(), workspaceId, email: normalizeEmail(input.email), roleId: role.id, tokenHash: tokenHash(raw), status: 'PENDING', expiresAt: addDays(7), isDeleted: false };
      tx.invitations.push(invitation);
      this.audit(tx, 'USER.INVITED', 'INVITATION', invitation.id, { actorUserId, workspaceId, metadata: { email: invitation.email } });
      return { invitation, invitationToken: raw };
    });
  }

  resendInvitation(actorUserId: string, workspaceId: string, invitationId: string): { invitation: Invitation; invitationToken: string } {
    this.requirePermission(actorUserId, workspaceId, 'user.create');
    const raw = randomToken();
    return this.transaction((tx) => {
      const invitation = required(tx.invitations.find((i) => i.id === invitationId && i.workspaceId === workspaceId && i.status === 'PENDING' && !i.isDeleted), 'INVITATION_NOT_FOUND', 'Invitation was not found.');
      invitation.tokenHash = tokenHash(raw);
      invitation.expiresAt = addDays(7);
      this.audit(tx, 'USER.INVITATION_RESENT', 'INVITATION', invitation.id, { actorUserId, workspaceId, metadata: { email: invitation.email } });
      return { invitation, invitationToken: raw };
    });
  }

  revokeInvitation(actorUserId: string, workspaceId: string, invitationId: string): void {
    this.requirePermission(actorUserId, workspaceId, 'user.create');
    this.transaction((tx) => {
      const invitation = required(tx.invitations.find((i) => i.id === invitationId && i.workspaceId === workspaceId && i.status === 'PENDING' && !i.isDeleted), 'INVITATION_NOT_FOUND', 'Invitation was not found.');
      invitation.status = 'REVOKED';
      this.audit(tx, 'USER.INVITATION_REVOKED', 'INVITATION', invitation.id, { actorUserId, workspaceId, metadata: { email: invitation.email } });
    });
  }

  rejectInvitation(token: string, emailInput: string): void {
    const email = normalizeEmail(emailInput);
    this.transaction((tx) => {
      const invitation = required(tx.invitations.find((i) => i.tokenHash === tokenHash(token) && i.status === 'PENDING' && !i.isDeleted), 'INVITATION_NOT_FOUND', 'Invitation was not found.');
      if (invitation.email !== email) throw new DomainError('INVITATION_EMAIL_MISMATCH', 'Invitation email does not match.');
      invitation.status = 'REJECTED';
      this.audit(tx, 'USER.INVITATION_REJECTED', 'INVITATION', invitation.id, { workspaceId: invitation.workspaceId, metadata: { email } });
    });
  }

  acceptInvitation(token: string, input: { email: string; firstName?: string; lastName?: string; password?: string }): AuthSessionContext {
    const invitation = required(this.db.invitations.find((i) => i.tokenHash === tokenHash(token) && i.status === 'PENDING' && !i.isDeleted), 'INVITATION_NOT_FOUND', 'Invitation was not found.');
    const email = normalizeEmail(input.email);
    if (email !== invitation.email) throw new DomainError('INVITATION_EMAIL_MISMATCH', 'Invitation email does not match.');
    if (invitation.expiresAt <= new Date()) throw new DomainError('INVITATION_EXPIRED', 'Invitation is expired.');
    return this.transaction((tx) => {
      const txInvitation = required(tx.invitations.find((i) => i.id === invitation.id), 'INVITATION_NOT_FOUND', 'Invitation was not found.');
      let user = tx.users.find((u) => u.email === email);
      if (!user) {
        if (!input.password) throw new DomainError('PASSWORD_REQUIRED', 'Password is required for new invitees.');
        this.assertPassword(input.password);
        user = { id: randomUUID(), firstName: input.firstName ?? '', lastName: input.lastName ?? '', email, settings: {}, meta: null, status: 'ACTIVE', emailVerifiedAt: new Date(), isDeleted: false, isPlatformAdmin: false };
        tx.users.push(user);
        tx.identities.push({ id: randomUUID(), userId: user.id, provider: 'LOCAL', providerUserId: null, passwordHash: passwordHash(input.password), isDeleted: false });
      }
      if (!tx.memberships.some((m) => m.workspaceId === invitation.workspaceId && m.userId === user.id && !m.isDeleted)) {
        tx.memberships.push({ id: randomUUID(), workspaceId: invitation.workspaceId, userId: user.id, roleId: invitation.roleId, status: 'ACTIVE', isDeleted: false });
      }
      txInvitation.status = 'ACCEPTED';
      this.audit(tx, 'USER.INVITATION_ACCEPTED', 'INVITATION', txInvitation.id, { actorUserId: user.id, workspaceId: invitation.workspaceId });
      return this.buildSessionContext(tx, user, invitation.workspaceId);
    });
  }

  listUsers(actorUserId: string, workspaceId: string, query: QueryOptions = {}): Paged<User> {
    this.requirePermission(actorUserId, workspaceId, 'user.read');
    const userIds = new Set(this.db.memberships.filter((m) => m.workspaceId === workspaceId && !m.isDeleted).map((m) => m.userId));
    return queryRows(this.db.users.filter((u) => userIds.has(u.id) && !u.isDeleted).map(safeUser), query, ['firstName', 'lastName', 'email'], ['status', 'isDeleted'], ['firstName', 'lastName', 'email']);
  }

  updateUser(actorUserId: string, userId: string, input: Partial<Pick<User, 'firstName' | 'lastName' | 'settings'>>, replace = false): User {
    if (actorUserId !== userId) throw new DomainError('PERMISSION_DENIED', 'Users may update only their own profile in this module.');
    return this.transaction((tx) => {
      const user = required(tx.users.find((u) => u.id === userId), 'USER_NOT_FOUND', 'User was not found.');
      user.firstName = input.firstName ?? (replace ? '' : user.firstName);
      user.lastName = input.lastName ?? (replace ? '' : user.lastName);
      user.settings = input.settings ?? (replace ? {} : user.settings);
      this.audit(tx, 'USER.PROFILE_UPDATED', 'USER', user.id, { actorUserId });
      return safeUser(user);
    });
  }

  removeWorkspaceMember(actorUserId: string, workspaceId: string, targetUserId: string): void {
    this.requirePermission(actorUserId, workspaceId, 'user.delete');
    this.transaction((tx) => {
      const workspace = required(tx.workspaces.find((w) => w.id === workspaceId && !w.isDeleted), 'WORKSPACE_NOT_FOUND', 'Workspace was not found.');
      if (workspace.ownerUserId === targetUserId) throw new DomainError('OWNER_MEMBERSHIP_PROTECTED', 'Workspace owner membership cannot be removed.');
      const membership = required(tx.memberships.find((m) => m.workspaceId === workspaceId && m.userId === targetUserId && !m.isDeleted), 'MEMBERSHIP_NOT_FOUND', 'Membership was not found.');
      membership.isDeleted = true;
      this.audit(tx, 'USER.REMOVED_FROM_WORKSPACE', 'WORKSPACE_MEMBERSHIP', membership.id, { actorUserId, workspaceId });
    });
  }

  suspendWorkspaceMember(actorUserId: string, workspaceId: string, targetUserId: string): void {
    this.requirePermission(actorUserId, workspaceId, 'user.update');
    this.transaction((tx) => {
      const workspace = required(tx.workspaces.find((w) => w.id === workspaceId && !w.isDeleted), 'WORKSPACE_NOT_FOUND', 'Workspace was not found.');
      if (workspace.ownerUserId === targetUserId) throw new DomainError('OWNER_MEMBERSHIP_PROTECTED', 'Workspace owner membership cannot be suspended.');
      const membership = required(tx.memberships.find((m) => m.workspaceId === workspaceId && m.userId === targetUserId && !m.isDeleted), 'MEMBERSHIP_NOT_FOUND', 'Membership was not found.');
      membership.status = 'SUSPENDED';
      this.audit(tx, 'WORKSPACE.MEMBER_SUSPENDED', 'WORKSPACE_MEMBERSHIP', membership.id, { actorUserId, workspaceId, metadata: { targetUserId } });
    });
  }

  reactivateWorkspaceMember(actorUserId: string, workspaceId: string, targetUserId: string): void {
    this.requirePermission(actorUserId, workspaceId, 'user.update');
    this.transaction((tx) => {
      const membership = required(tx.memberships.find((m) => m.workspaceId === workspaceId && m.userId === targetUserId && !m.isDeleted), 'MEMBERSHIP_NOT_FOUND', 'Membership was not found.');
      membership.status = 'ACTIVE';
      this.audit(tx, 'WORKSPACE.MEMBER_REACTIVATED', 'WORKSPACE_MEMBERSHIP', membership.id, { actorUserId, workspaceId, metadata: { targetUserId } });
    });
  }

  softDeleteUser(actorUserId: string, targetUserId: string): void {
    if (actorUserId !== targetUserId && !this.isPlatformAdmin(actorUserId)) throw new DomainError('PERMISSION_DENIED', 'Global user deletion requires platform authority.');
    this.transaction((tx) => {
      const user = required(tx.users.find((u) => u.id === targetUserId), 'USER_NOT_FOUND', 'User was not found.');
      user.isDeleted = true;
      this.audit(tx, 'USER.SOFT_DELETED', 'USER', targetUserId, { actorUserId });
    });
  }

  restoreUser(actorUserId: string, targetUserId: string): void {
    if (!this.isPlatformAdmin(actorUserId)) throw new DomainError('PERMISSION_DENIED', 'Global user restore requires platform authority.');
    this.transaction((tx) => {
      const user = required(tx.users.find((u) => u.id === targetUserId), 'USER_NOT_FOUND', 'User was not found.');
      user.isDeleted = false;
      this.audit(tx, 'USER.RESTORED', 'USER', targetUserId, { actorUserId });
    });
  }

  suspendUser(actorUserId: string, targetUserId: string): void {
    if (!this.isPlatformAdmin(actorUserId)) throw new DomainError('PERMISSION_DENIED', 'User suspension requires platform authority.');
    this.transaction((tx) => {
      const user = required(tx.users.find((u) => u.id === targetUserId && !u.isDeleted), 'USER_NOT_FOUND', 'User was not found.');
      user.status = 'SUSPENDED';
      tx.refreshSessions.filter((s) => s.userId === targetUserId && !s.revokedAt).forEach((s) => (s.revokedAt = new Date()));
      this.audit(tx, 'USER.SUSPENDED', 'USER', targetUserId, { actorUserId });
    });
  }

  reactivateUser(actorUserId: string, targetUserId: string): void {
    if (!this.isPlatformAdmin(actorUserId)) throw new DomainError('PERMISSION_DENIED', 'User reactivation requires platform authority.');
    this.transaction((tx) => {
      const user = required(tx.users.find((u) => u.id === targetUserId && !u.isDeleted), 'USER_NOT_FOUND', 'User was not found.');
      user.status = 'ACTIVE';
      this.audit(tx, 'USER.REACTIVATED', 'USER', targetUserId, { actorUserId });
    });
  }

  hardDeleteUser(actorUserId: string, targetUserId: string): void {
    if (!this.isPlatformAdmin(actorUserId)) throw new DomainError('PERMISSION_DENIED', 'Global hard deletion requires platform authority.');
    const user = required(this.db.users.find((u) => u.id === targetUserId), 'USER_NOT_FOUND', 'User was not found.');
    if (!user.isDeleted) throw new DomainError('SOFT_DELETE_REQUIRED', 'User must be soft-deleted before hard deletion.');
    this.transaction((tx) => {
      tx.users = tx.users.filter((u) => u.id !== targetUserId);
      tx.identities = tx.identities.filter((i) => i.userId !== targetUserId);
      tx.memberships = tx.memberships.filter((m) => m.userId !== targetUserId);
      this.audit(tx, 'USER.HARD_DELETED', 'USER', targetUserId, { actorUserId });
    });
  }

  createDepartment(actorUserId: string, workspaceId: string, input: { name: string; parentDepartmentId?: string | null; description?: string | null; managerId?: string | null }): Department {
    this.requirePermission(actorUserId, workspaceId, 'department.create');
    return this.transaction((tx) => {
      this.validateDepartmentParent(tx, workspaceId, input.parentDepartmentId ?? null, null, input.name);
      const department: Department = { id: randomUUID(), workspaceId, parentDepartmentId: input.parentDepartmentId ?? null, name: input.name, description: input.description ?? null, managerId: null, isDeleted: false };
      tx.departments.push(department);
      if (input.managerId) this.assignDepartmentManagerInternal(tx, workspaceId, department.id, input.managerId);
      this.audit(tx, 'DEPARTMENT.CREATED', 'DEPARTMENT', department.id, { actorUserId, workspaceId, afterData: department });
      return department;
    });
  }

  updateDepartment(actorUserId: string, workspaceId: string, departmentId: string, input: { name?: string; description?: string | null; parentDepartmentId?: string | null; managerId?: string | null }, replace = false): Department {
    this.requirePermission(actorUserId, workspaceId, 'department.update');
    return this.transaction((tx) => {
      const department = required(tx.departments.find((d) => d.id === departmentId && d.workspaceId === workspaceId && !d.isDeleted), 'DEPARTMENT_NOT_FOUND', 'Department was not found.');
      const nextParent = Object.prototype.hasOwnProperty.call(input, 'parentDepartmentId') ? input.parentDepartmentId ?? null : department.parentDepartmentId;
      const nextName = input.name ?? (replace ? '' : department.name);
      this.validateDepartmentParent(tx, workspaceId, nextParent, departmentId, nextName);
      department.parentDepartmentId = nextParent;
      department.name = nextName;
      department.description = input.description ?? (replace ? null : department.description);
      if (Object.prototype.hasOwnProperty.call(input, 'managerId')) {
        if (input.managerId) {
          this.assignDepartmentManagerInternal(tx, workspaceId, departmentId, input.managerId);
          this.audit(tx, 'DEPARTMENT.MANAGER_ASSIGNED', 'DEPARTMENT', departmentId, { actorUserId, workspaceId, metadata: { managerId: input.managerId } });
        } else {
          department.managerId = null;
          this.audit(tx, 'DEPARTMENT.MANAGER_CLEARED', 'DEPARTMENT', departmentId, { actorUserId, workspaceId });
        }
      }
      this.audit(tx, 'DEPARTMENT.UPDATED', 'DEPARTMENT', departmentId, { actorUserId, workspaceId, afterData: department });
      return department;
    });
  }

  moveDepartment(actorUserId: string, workspaceId: string, departmentId: string, parentDepartmentId: string | null): Department {
    this.requirePermission(actorUserId, workspaceId, 'department.update');
    return this.transaction((tx) => {
      const department = required(tx.departments.find((d) => d.id === departmentId && d.workspaceId === workspaceId && !d.isDeleted), 'DEPARTMENT_NOT_FOUND', 'Department was not found.');
      this.validateDepartmentParent(tx, workspaceId, parentDepartmentId, departmentId, department.name);
      department.parentDepartmentId = parentDepartmentId;
      this.audit(tx, 'DEPARTMENT.MOVED', 'DEPARTMENT', departmentId, { actorUserId, workspaceId, metadata: { parentDepartmentId } });
      return department;
    });
  }

  listDepartments(actorUserId: string, workspaceId: string, query: QueryOptions = {}): Paged<Department> {
    this.requirePermission(actorUserId, workspaceId, 'department.read');
    return queryRows(this.db.departments.filter((d) => d.workspaceId === workspaceId && !d.isDeleted), query, ['name', 'description'], ['parentDepartmentId', 'managerId', 'isDeleted'], ['name']);
  }

  children(workspaceId: string, departmentId: string): Department[] {
    return this.db.departments.filter((d) => d.workspaceId === workspaceId && d.parentDepartmentId === departmentId && !d.isDeleted);
  }

  descendants(workspaceId: string, departmentId: string): Department[] {
    const direct = this.children(workspaceId, departmentId);
    return direct.flatMap((d) => [d, ...this.descendants(workspaceId, d.id)]);
  }

  ancestors(workspaceId: string, departmentId: string): Department[] {
    const result: Department[] = [];
    let current = this.db.departments.find((d) => d.id === departmentId && d.workspaceId === workspaceId);
    while (current?.parentDepartmentId) {
      current = this.db.departments.find((d) => d.id === current?.parentDepartmentId && d.workspaceId === workspaceId);
      if (current) result.unshift(current);
    }
    return result;
  }

  softDeleteDepartment(actorUserId: string, workspaceId: string, departmentId: string): void {
    this.requirePermission(actorUserId, workspaceId, 'department.delete');
    this.transaction((tx) => {
      if (tx.departments.some((d) => d.parentDepartmentId === departmentId && !d.isDeleted)) throw new DomainError('DEPARTMENT_HAS_CHILDREN', 'Department has active children.');
      const department = required(tx.departments.find((d) => d.id === departmentId && d.workspaceId === workspaceId), 'DEPARTMENT_NOT_FOUND', 'Department was not found.');
      department.isDeleted = true;
      this.audit(tx, 'DEPARTMENT.SOFT_DELETED', 'DEPARTMENT', departmentId, { actorUserId, workspaceId });
    });
  }

  restoreDepartment(actorUserId: string, workspaceId: string, departmentId: string): void {
    this.requirePermission(actorUserId, workspaceId, 'department.delete');
    this.transaction((tx) => {
      const department = required(tx.departments.find((d) => d.id === departmentId && d.workspaceId === workspaceId), 'DEPARTMENT_NOT_FOUND', 'Department was not found.');
      this.validateDepartmentParent(tx, workspaceId, department.parentDepartmentId, department.id, department.name);
      department.isDeleted = false;
      this.audit(tx, 'DEPARTMENT.RESTORED', 'DEPARTMENT', departmentId, { actorUserId, workspaceId });
    });
  }

  hardDeleteDepartment(actorUserId: string, workspaceId: string, departmentId: string): void {
    this.requirePermission(actorUserId, workspaceId, 'department.delete');
    const department = required(this.db.departments.find((d) => d.id === departmentId && d.workspaceId === workspaceId), 'DEPARTMENT_NOT_FOUND', 'Department was not found.');
    if (!department.isDeleted) throw new DomainError('SOFT_DELETE_REQUIRED', 'Department must be soft-deleted before hard deletion.');
    this.transaction((tx) => {
      tx.departmentMembers = tx.departmentMembers.filter((m) => m.departmentId !== departmentId);
      tx.departments = tx.departments.filter((d) => d.id !== departmentId);
      this.audit(tx, 'DEPARTMENT.HARD_DELETED', 'DEPARTMENT', departmentId, { actorUserId, workspaceId });
    });
  }

  bulkAddDepartmentMembers(actorUserId: string, workspaceId: string, departmentId: string, userIds: string[]): DepartmentMember[] {
    this.requirePermission(actorUserId, workspaceId, 'department.update');
    return this.transaction((tx) => {
      required(tx.departments.find((d) => d.id === departmentId && d.workspaceId === workspaceId && !d.isDeleted), 'DEPARTMENT_NOT_FOUND', 'Department was not found.');
      for (const userId of userIds) this.requireMembershipInTx(tx, userId, workspaceId);
      const created: DepartmentMember[] = [];
      for (const userId of userIds) {
        const existing = tx.departmentMembers.find((m) => m.departmentId === departmentId && m.userId === userId && !m.isDeleted);
        if (existing) continue;
        const member: DepartmentMember = { id: randomUUID(), workspaceId, departmentId, userId, isDeleted: false };
        tx.departmentMembers.push(member);
        created.push(member);
      }
      this.audit(tx, 'DEPARTMENT.MEMBER_ADDED', 'DEPARTMENT', departmentId, { actorUserId, workspaceId, metadata: { userIds, count: created.length } });
      return created;
    });
  }

  listDepartmentMembers(actorUserId: string, workspaceId: string, query: QueryOptions = {}): Paged<DepartmentMember> {
    this.requirePermission(actorUserId, workspaceId, 'department.read');
    return queryRows(this.db.departmentMembers.filter((m) => m.workspaceId === workspaceId && !m.isDeleted), query, ['departmentId', 'userId'], ['departmentId', 'userId', 'isDeleted'], ['userId', 'departmentId']);
  }

  removeDepartmentMember(actorUserId: string, workspaceId: string, departmentId: string, userId: string): void {
    this.requirePermission(actorUserId, workspaceId, 'department.update');
    this.transaction((tx) => {
      const department = required(tx.departments.find((d) => d.id === departmentId && d.workspaceId === workspaceId), 'DEPARTMENT_NOT_FOUND', 'Department was not found.');
      if (department.managerId === userId) throw new DomainError('MANAGER_REMOVAL_BLOCKED', 'Current manager cannot be removed from the department.');
      const member = required(tx.departmentMembers.find((m) => m.departmentId === departmentId && m.userId === userId && !m.isDeleted), 'DEPARTMENT_MEMBER_NOT_FOUND', 'Department member was not found.');
      member.isDeleted = true;
      this.audit(tx, 'DEPARTMENT.MEMBER_REMOVED', 'DEPARTMENT_MEMBER', member.id, { actorUserId, workspaceId });
    });
  }

  restoreDepartmentMember(actorUserId: string, workspaceId: string, memberId: string): void {
    this.requirePermission(actorUserId, workspaceId, 'department.update');
    this.transaction((tx) => {
      const member = required(tx.departmentMembers.find((m) => m.id === memberId && m.workspaceId === workspaceId), 'DEPARTMENT_MEMBER_NOT_FOUND', 'Department member was not found.');
      this.requireMembershipInTx(tx, member.userId, workspaceId);
      required(tx.departments.find((d) => d.id === member.departmentId && d.workspaceId === workspaceId && !d.isDeleted), 'DEPARTMENT_NOT_FOUND', 'Department was not found.');
      if (tx.departmentMembers.some((m) => m.id !== member.id && m.departmentId === member.departmentId && m.userId === member.userId && !m.isDeleted)) {
        throw new DomainError('DEPARTMENT_MEMBER_DUPLICATE', 'An active department membership already exists.');
      }
      member.isDeleted = false;
      this.audit(tx, 'DEPARTMENT.MEMBER_RESTORED', 'DEPARTMENT_MEMBER', member.id, { actorUserId, workspaceId });
    });
  }

  hardDeleteDepartmentMember(actorUserId: string, workspaceId: string, memberId: string): void {
    this.requirePermission(actorUserId, workspaceId, 'department.update');
    const member = required(this.db.departmentMembers.find((m) => m.id === memberId && m.workspaceId === workspaceId), 'DEPARTMENT_MEMBER_NOT_FOUND', 'Department member was not found.');
    if (!member.isDeleted) throw new DomainError('SOFT_DELETE_REQUIRED', 'Department member must be soft-deleted before hard deletion.');
    this.transaction((tx) => {
      tx.departmentMembers = tx.departmentMembers.filter((m) => m.id !== memberId);
      this.audit(tx, 'DEPARTMENT.MEMBER_HARD_DELETED', 'DEPARTMENT_MEMBER', memberId, { actorUserId, workspaceId });
    });
  }

  submitPartnerApplication(input: { firstName: string; lastName: string; email: string; phone: string; partnerName: string; country: string; website?: string | null; businessDescription: string; acceptedTerms: boolean }): PartnerApplication {
    if (!input.acceptedTerms) throw new DomainError('TERMS_REQUIRED', 'Terms acceptance is required.');
    const email = normalizeEmail(input.email);
    return this.transaction((tx) => {
      let user = tx.users.find((u) => u.email === email);
      if (!user) {
        user = { id: randomUUID(), firstName: input.firstName, lastName: input.lastName, email, settings: {}, meta: null, status: 'PENDING_VERIFICATION', emailVerifiedAt: null, isDeleted: false, isPlatformAdmin: false };
        tx.users.push(user);
      }
      const application: PartnerApplication = { id: randomUUID(), userId: user.id, firstName: input.firstName, lastName: input.lastName, email, phone: input.phone, partnerName: input.partnerName, country: input.country, website: input.website ?? null, businessDescription: input.businessDescription, status: 'PENDING' };
      tx.partnerApplications.push(application);
      this.audit(tx, 'PARTNER.APPLICATION_SUBMITTED', 'PARTNER_APPLICATION', application.id, { actorUserId: user.id });
      return application;
    });
  }

  listPartnerApplications(actorUserId: string, query: QueryOptions = {}): Paged<PartnerApplication> {
    if (!this.isPlatformAdmin(actorUserId)) throw new DomainError('PERMISSION_DENIED', 'Only Platform Admin may list partner applications.');
    return queryRows(this.db.partnerApplications, query, ['firstName', 'lastName', 'email', 'partnerName'], ['status', 'country'], ['partnerName', 'email', 'country']);
  }

  listPartners(actorUserId: string, query: QueryOptions = {}): Paged<Partner> {
    if (!this.isPlatformAdmin(actorUserId) && !this.db.partnerMemberships.some((m) => m.userId === actorUserId && m.status === 'ACTIVE' && !m.isDeleted)) {
      throw new DomainError('PERMISSION_DENIED', 'Partner listing requires platform or partner membership.');
    }
    const allowedPartnerIds = this.isPlatformAdmin(actorUserId)
      ? null
      : new Set(this.db.partnerMemberships.filter((m) => m.userId === actorUserId && m.status === 'ACTIVE' && !m.isDeleted).map((m) => m.partnerId));
    return queryRows(this.db.partners.filter((p) => !p.isDeleted && (!allowedPartnerIds || allowedPartnerIds.has(p.id))), query, ['name', 'country', 'website'], ['status', 'country', 'isDeleted'], ['name', 'country']);
  }

  getPartner(actorUserId: string, partnerId: string): Partner {
    if (!this.isPlatformAdmin(actorUserId) && !this.db.partnerMemberships.some((m) => m.partnerId === partnerId && m.userId === actorUserId && m.status === 'ACTIVE' && !m.isDeleted)) {
      throw new DomainError('PERMISSION_DENIED', 'Partner access requires platform or partner membership.');
    }
    return required(this.db.partners.find((p) => p.id === partnerId && !p.isDeleted), 'PARTNER_NOT_FOUND', 'Partner was not found.');
  }

  approvePartnerApplication(platformAdminUserId: string, applicationId: string): Partner {
    if (!this.isPlatformAdmin(platformAdminUserId)) throw new DomainError('PERMISSION_DENIED', 'Only Platform Admin may approve partner applications.');
    return this.transaction((tx) => {
      const application = required(tx.partnerApplications.find((a) => a.id === applicationId && a.status === 'PENDING'), 'APPLICATION_NOT_FOUND', 'Partner application was not found.');
      const partner: Partner = { id: randomUUID(), name: application.partnerName, country: application.country, website: application.website, businessDescription: application.businessDescription, status: 'ACTIVE', defaultDiscount: 10, discountOverrides: {}, isDeleted: false };
      const role: PartnerRole = { id: randomUUID(), partnerId: partner.id, name: 'Partner Owner', isOwnerRole: true };
      tx.partners.push(partner);
      tx.partnerRoles.push(role);
      tx.partnerMemberships.push({ id: randomUUID(), partnerId: partner.id, userId: application.userId, partnerRoleId: role.id, status: 'ACTIVE', isDeleted: false });
      application.status = 'APPROVED';
      this.audit(tx, 'PARTNER.APPLICATION_APPROVED', 'PARTNER_APPLICATION', application.id, { actorUserId: platformAdminUserId, partnerId: partner.id });
      this.audit(tx, 'PARTNER.CREATED', 'PARTNER', partner.id, { actorUserId: platformAdminUserId, partnerId: partner.id });
      return partner;
    });
  }

  rejectPartnerApplication(platformAdminUserId: string, applicationId: string): void {
    if (!this.isPlatformAdmin(platformAdminUserId)) throw new DomainError('PERMISSION_DENIED', 'Only Platform Admin may reject partner applications.');
    this.transaction((tx) => {
      const application = required(tx.partnerApplications.find((a) => a.id === applicationId && a.status === 'PENDING'), 'APPLICATION_NOT_FOUND', 'Partner application was not found.');
      application.status = 'REJECTED';
      this.audit(tx, 'PARTNER.APPLICATION_REJECTED', 'PARTNER_APPLICATION', application.id, { actorUserId: platformAdminUserId });
    });
  }

  updatePartnerDiscount(platformAdminUserId: string, partnerId: string, defaultDiscount: number, overrides: Record<string, number>): Partner {
    if (!this.isPlatformAdmin(platformAdminUserId)) throw new DomainError('PERMISSION_DENIED', 'Only Platform Admin may manage discounts.');
    return this.transaction((tx) => {
      const partner = required(tx.partners.find((p) => p.id === partnerId), 'PARTNER_NOT_FOUND', 'Partner was not found.');
      partner.defaultDiscount = defaultDiscount;
      partner.discountOverrides = { ...overrides };
      this.audit(tx, 'PARTNER.DISCOUNT_UPDATED', 'PARTNER', partnerId, { actorUserId: platformAdminUserId, partnerId });
      return partner;
    });
  }

  updatePartner(platformAdminUserId: string, partnerId: string, input: { name?: string; country?: string; website?: string | null; businessDescription?: string | null }, replace = false): Partner {
    if (!this.isPlatformAdmin(platformAdminUserId)) throw new DomainError('PERMISSION_DENIED', 'Only Platform Admin may update partners.');
    return this.transaction((tx) => {
      const partner = required(tx.partners.find((p) => p.id === partnerId && !p.isDeleted), 'PARTNER_NOT_FOUND', 'Partner was not found.');
      partner.name = input.name ?? (replace ? '' : partner.name);
      partner.country = input.country ?? (replace ? '' : partner.country);
      partner.website = input.website ?? (replace ? null : partner.website);
      partner.businessDescription = input.businessDescription ?? (replace ? null : partner.businessDescription);
      this.audit(tx, 'PARTNER.UPDATED', 'PARTNER', partnerId, { actorUserId: platformAdminUserId, partnerId, afterData: partner });
      return partner;
    });
  }

  suspendPartner(platformAdminUserId: string, partnerId: string): void {
    if (!this.isPlatformAdmin(platformAdminUserId)) throw new DomainError('PERMISSION_DENIED', 'Only Platform Admin may suspend partners.');
    this.transaction((tx) => {
      const partner = required(tx.partners.find((p) => p.id === partnerId && !p.isDeleted), 'PARTNER_NOT_FOUND', 'Partner was not found.');
      partner.status = 'SUSPENDED';
      this.audit(tx, 'PARTNER.SUSPENDED', 'PARTNER', partnerId, { actorUserId: platformAdminUserId, partnerId });
    });
  }

  reactivatePartner(platformAdminUserId: string, partnerId: string): void {
    if (!this.isPlatformAdmin(platformAdminUserId)) throw new DomainError('PERMISSION_DENIED', 'Only Platform Admin may reactivate partners.');
    this.transaction((tx) => {
      const partner = required(tx.partners.find((p) => p.id === partnerId && !p.isDeleted), 'PARTNER_NOT_FOUND', 'Partner was not found.');
      partner.status = 'ACTIVE';
      this.audit(tx, 'PARTNER.REACTIVATED', 'PARTNER', partnerId, { actorUserId: platformAdminUserId, partnerId });
    });
  }

  softDeletePartner(platformAdminUserId: string, partnerId: string): void {
    if (!this.isPlatformAdmin(platformAdminUserId)) throw new DomainError('PERMISSION_DENIED', 'Only Platform Admin may delete partners.');
    this.transaction((tx) => {
      const partner = required(tx.partners.find((p) => p.id === partnerId), 'PARTNER_NOT_FOUND', 'Partner was not found.');
      partner.isDeleted = true;
      this.audit(tx, 'PARTNER.SOFT_DELETED', 'PARTNER', partnerId, { actorUserId: platformAdminUserId, partnerId });
    });
  }

  restorePartner(platformAdminUserId: string, partnerId: string): void {
    if (!this.isPlatformAdmin(platformAdminUserId)) throw new DomainError('PERMISSION_DENIED', 'Only Platform Admin may restore partners.');
    this.transaction((tx) => {
      const partner = required(tx.partners.find((p) => p.id === partnerId), 'PARTNER_NOT_FOUND', 'Partner was not found.');
      partner.isDeleted = false;
      this.audit(tx, 'PARTNER.RESTORED', 'PARTNER', partnerId, { actorUserId: platformAdminUserId, partnerId });
    });
  }

  hardDeletePartner(platformAdminUserId: string, partnerId: string): void {
    if (!this.isPlatformAdmin(platformAdminUserId)) throw new DomainError('PERMISSION_DENIED', 'Only Platform Admin may hard-delete partners.');
    const partner = required(this.db.partners.find((p) => p.id === partnerId), 'PARTNER_NOT_FOUND', 'Partner was not found.');
    if (!partner.isDeleted) throw new DomainError('SOFT_DELETE_REQUIRED', 'Partner must be soft-deleted before hard deletion.');
    this.transaction((tx) => {
      tx.partnerWorkspaceAccess = tx.partnerWorkspaceAccess.filter((a) => a.partnerId !== partnerId);
      tx.partnerWorkspaceRelations = tx.partnerWorkspaceRelations.filter((r) => r.partnerId !== partnerId);
      tx.partnerMemberships = tx.partnerMemberships.filter((m) => m.partnerId !== partnerId);
      tx.partnerRoles = tx.partnerRoles.filter((r) => r.partnerId !== partnerId);
      tx.partners = tx.partners.filter((p) => p.id !== partnerId);
      this.audit(tx, 'PARTNER.HARD_DELETED', 'PARTNER', partnerId, { actorUserId: platformAdminUserId, partnerId });
    });
  }

  provisionCustomerWorkspace(partnerUserId: string, partnerId: string, customerUserId: string, name: string): Workspace {
    if (!this.db.partnerMemberships.some((m) => m.partnerId === partnerId && m.userId === partnerUserId && m.status === 'ACTIVE' && !m.isDeleted)) {
      throw new DomainError('PERMISSION_DENIED', 'Active partner membership is required.');
    }
    const customer = required(this.db.users.find((u) => u.id === customerUserId), 'USER_NOT_FOUND', 'Customer user was not found.');
    return this.transaction((tx) => {
      const workspace = this.createWorkspaceInternal(tx, customer, name, null);
      this.assertNoActivePartnerRelation(tx, workspace.id);
      tx.partnerWorkspaceRelations.push({ id: randomUUID(), partnerId, workspaceId: workspace.id, status: 'ACTIVE' });
      this.audit(tx, 'PARTNER.WORKSPACE_RELATION_CREATED', 'WORKSPACE', workspace.id, { actorUserId: partnerUserId, partnerId, workspaceId: workspace.id });
      return workspace;
    });
  }

  createPartnerWorkspaceRelation(actorUserId: string, partnerId: string, workspaceId: string): PartnerWorkspaceRelation {
    if (!this.isPlatformAdmin(actorUserId)) throw new DomainError('PERMISSION_DENIED', 'Only Platform Admin may create partner workspace relations.');
    return this.transaction((tx) => {
      required(tx.partners.find((p) => p.id === partnerId && !p.isDeleted), 'PARTNER_NOT_FOUND', 'Partner was not found.');
      required(tx.workspaces.find((w) => w.id === workspaceId && !w.isDeleted), 'WORKSPACE_NOT_FOUND', 'Workspace was not found.');
      this.assertNoActivePartnerRelation(tx, workspaceId);
      const relation: PartnerWorkspaceRelation = { id: randomUUID(), partnerId, workspaceId, status: 'ACTIVE' };
      tx.partnerWorkspaceRelations.push(relation);
      this.audit(tx, 'PARTNER.WORKSPACE_RELATION_CREATED', 'WORKSPACE', workspaceId, { actorUserId, partnerId, workspaceId });
      return relation;
    });
  }

  endPartnerWorkspaceRelation(actorUserId: string, relationId: string): void {
    if (!this.isPlatformAdmin(actorUserId)) throw new DomainError('PERMISSION_DENIED', 'Only Platform Admin may end partner workspace relations.');
    this.transaction((tx) => {
      const relation = required(tx.partnerWorkspaceRelations.find((r) => r.id === relationId && r.status === 'ACTIVE'), 'PARTNER_RELATION_NOT_FOUND', 'Active partner relationship was not found.');
      relation.status = 'ENDED';
      this.audit(tx, 'PARTNER.WORKSPACE_RELATION_ENDED', 'WORKSPACE', relation.workspaceId, { actorUserId, partnerId: relation.partnerId, workspaceId: relation.workspaceId });
    });
  }

  grantPartnerWorkspaceAccess(actorUserId: string, partnerId: string, workspaceId: string): PartnerWorkspaceAccess {
    this.requirePermission(actorUserId, workspaceId, 'workspace.update');
    return this.transaction((tx) => {
      if (!tx.partnerWorkspaceRelations.some((r) => r.partnerId === partnerId && r.workspaceId === workspaceId && r.status === 'ACTIVE')) throw new DomainError('PARTNER_RELATION_NOT_FOUND', 'Active partner relationship was not found.');
      const access: PartnerWorkspaceAccess = { id: randomUUID(), partnerId, workspaceId, status: 'ACTIVE', grantedBy: actorUserId, expiresAt: null };
      tx.partnerWorkspaceAccess.push(access);
      this.audit(tx, 'PARTNER.WORKSPACE_ACCESS_GRANTED', 'WORKSPACE', workspaceId, { actorUserId, partnerId, workspaceId });
      return access;
    });
  }

  revokePartnerWorkspaceAccess(actorUserId: string, accessId: string): void {
    this.transaction((tx) => {
      const access = required(tx.partnerWorkspaceAccess.find((a) => a.id === accessId), 'PARTNER_ACCESS_NOT_FOUND', 'Partner access was not found.');
      access.status = 'REVOKED';
      this.audit(tx, 'PARTNER.WORKSPACE_ACCESS_REVOKED', 'WORKSPACE', access.workspaceId, { actorUserId, partnerId: access.partnerId, workspaceId: access.workspaceId });
    });
  }

  canPartnerAccessWorkspace(partnerUserId: string, partnerId: string, workspaceId: string): boolean {
    const membership = this.db.partnerMemberships.find((m) => m.partnerId === partnerId && m.userId === partnerUserId && m.status === 'ACTIVE' && !m.isDeleted);
    const relation = this.db.partnerWorkspaceRelations.find((r) => r.partnerId === partnerId && r.workspaceId === workspaceId && r.status === 'ACTIVE');
    const access = this.db.partnerWorkspaceAccess.find((a) => a.partnerId === partnerId && a.workspaceId === workspaceId && a.status === 'ACTIVE' && (!a.expiresAt || a.expiresAt > new Date()));
    return !!membership && !!relation && !!access;
  }

  listAuditLogs(actorUserId: string, workspaceId: string, query: QueryOptions = {}): Paged<AuditLog> {
    this.requirePermission(actorUserId, workspaceId, 'audit.read');
    return queryRows(this.db.auditLogs.filter((l) => l.workspaceId === workspaceId), query, ['action', 'entityType'], ['workspaceId', 'partnerId', 'actorUserId', 'action', 'entityType', 'entityId', 'occurredAt'], ['occurredAt', 'action', 'entityType']);
  }

  private syncPermissions(): void {
    this.db.permissions = PERMISSION_KEYS.map((key) => {
      const [resource, action] = key.split('.');
      return { id: stableId(key), key, name: key, description: `${key} permission`, module: resource, resource, action };
    });
    this.safeAudit('PERMISSION.REGISTRY_SYNCED', 'PERMISSION', null, { metadata: { count: this.db.permissions.length } });
  }

  private createWorkspaceInternal(tx: Database, user: User, name: string, description: string | null): Workspace {
    const workspace: Workspace = { id: randomUUID(), name, slug: uniqueSlug(tx, name), description, settings: null, meta: null, ownerUserId: user.id, isDeleted: false };
    const role: Role = { id: randomUUID(), workspaceId: workspace.id, name: 'Owner/Admin', description: 'Protected workspace owner role', isSystem: true, isOwnerRole: true, isDeleted: false };
    tx.workspaces.push(workspace);
    tx.roles.push(role);
    tx.memberships.push({ id: randomUUID(), workspaceId: workspace.id, userId: user.id, roleId: role.id, status: 'ACTIVE', isDeleted: false });
    user.settings.lastActiveWorkspaceId = workspace.id;
    this.audit(tx, 'WORKSPACE.CREATED', 'WORKSPACE', workspace.id, { actorUserId: user.id, workspaceId: workspace.id, afterData: workspace });
    return workspace;
  }

  private replaceRolePermissionsInternal(tx: Database, actorUserId: string, workspaceId: string, roleId: string, permissions: Array<{ permissionId: string; scope: PermissionScope }>): void {
    const role = required(tx.roles.find((r) => r.id === roleId && r.workspaceId === workspaceId && !r.isDeleted), 'ROLE_NOT_FOUND', 'Role was not found.');
    if (role.isOwnerRole || role.isSystem) throw new DomainError('PROTECTED_ROLE', 'Owner/Admin role is protected.');
    const seen = new Set<string>();
    for (const assignment of permissions) {
      if (seen.has(assignment.permissionId)) throw new DomainError('DUPLICATE_PERMISSION', 'Only one effective scope per permission is allowed.');
      seen.add(assignment.permissionId);
      required(tx.permissions.find((p) => p.id === assignment.permissionId), 'PERMISSION_NOT_FOUND', 'Permission was not found.');
    }
    tx.rolePermissions = tx.rolePermissions.filter((rp) => rp.roleId !== roleId);
    permissions.forEach((p) => tx.rolePermissions.push({ id: randomUUID(), roleId, permissionId: p.permissionId, scope: p.scope, isDeleted: false }));
    this.audit(tx, 'ROLE.PERMISSIONS_UPDATED', 'ROLE', roleId, { actorUserId, workspaceId, metadata: { count: permissions.length } });
  }

  private ensureTransferFallbackRole(tx: Database, workspaceId: string): Role {
    const existing = tx.roles.find((r) => r.workspaceId === workspaceId && r.name === 'Workspace Admin' && !r.isDeleted && !r.isOwnerRole);
    if (existing) return existing;
    const role: Role = {
      id: randomUUID(),
      workspaceId,
      name: 'Workspace Admin',
      description: 'Administrative role assigned during ownership transfer',
      isSystem: false,
      isOwnerRole: false,
      isDeleted: false,
    };
    tx.roles.push(role);
    for (const permission of tx.permissions) {
      tx.rolePermissions.push({ id: randomUUID(), roleId: role.id, permissionId: permission.id, scope: 'WORKSPACE', isDeleted: false });
    }
    this.audit(tx, 'ROLE.CREATED', 'ROLE', role.id, { workspaceId, afterData: role });
    return role;
  }

  private issueSessionInternal(tx: Database, user: User, workspaceId: string): AuthSession {
    const rawRefresh = randomToken();
    tx.refreshSessions.push({ id: randomUUID(), userId: user.id, tokenHash: tokenHash(rawRefresh), expiresAt: addDays(REFRESH_DAYS), revokedAt: null, isDeleted: false });
    return { accessToken: this.signAccessToken(user.id), refreshToken: rawRefresh, context: this.buildSessionContext(tx, user, workspaceId) };
  }

  private buildSessionContext(tx: Database, user: User, workspaceId: string): AuthSessionContext {
    const membership = required(tx.memberships.find((m) => m.userId === user.id && m.workspaceId === workspaceId && !m.isDeleted && m.status === 'ACTIVE'), 'MEMBERSHIP_NOT_FOUND', 'Membership was not found.');
    const role = required(tx.roles.find((r) => r.id === membership.roleId && !r.isDeleted), 'ROLE_NOT_FOUND', 'Role was not found.');
    const permissions = role.isOwnerRole ? tx.permissions.map((p) => ({ key: p.key, scope: 'WORKSPACE' as PermissionScope })) : tx.rolePermissions.filter((rp) => rp.roleId === role.id && !rp.isDeleted).map((rp) => ({ key: required(tx.permissions.find((p) => p.id === rp.permissionId), 'PERMISSION_NOT_FOUND', 'Permission was not found.').key, scope: rp.scope }));
    return { user: safeUser(user), workspace: required(tx.workspaces.find((w) => w.id === workspaceId), 'WORKSPACE_NOT_FOUND', 'Workspace was not found.'), membership, role, permissions };
  }

  private resolveActiveWorkspaceId(tx: Database, user: User): string {
    const preferred = typeof user.settings.lastActiveWorkspaceId === 'string' ? user.settings.lastActiveWorkspaceId : null;
    if (preferred && tx.memberships.some((m) => m.userId === user.id && m.workspaceId === preferred && m.status === 'ACTIVE' && !m.isDeleted) && tx.workspaces.some((w) => w.id === preferred && !w.isDeleted)) return preferred;
    const membership = tx.memberships.find((m) => m.userId === user.id && m.status === 'ACTIVE' && !m.isDeleted && tx.workspaces.some((w) => w.id === m.workspaceId && !w.isDeleted));
    if (!membership) throw new DomainError('NO_ACTIVE_WORKSPACE', 'No active workspace membership was found.');
    user.settings.lastActiveWorkspaceId = membership.workspaceId;
    return membership.workspaceId;
  }

  private requireMembership(userId: string, workspaceId: string): WorkspaceMembership {
    return this.requireMembershipInTx(this.db, userId, workspaceId);
  }

  private requireMembershipInTx(tx: Database, userId: string, workspaceId: string): WorkspaceMembership {
    return required(tx.memberships.find((m) => m.userId === userId && m.workspaceId === workspaceId && m.status === 'ACTIVE' && !m.isDeleted && tx.workspaces.some((w) => w.id === workspaceId && !w.isDeleted)), 'MEMBERSHIP_NOT_FOUND', 'Active workspace membership is required.');
  }

  private requirePermission(userId: string, workspaceId: string, permissionKey: string): PermissionScope {
    const membership = this.requireMembership(userId, workspaceId);
    const role = required(this.db.roles.find((r) => r.id === membership.roleId && !r.isDeleted), 'ROLE_NOT_FOUND', 'Role was not found.');
    if (role.isOwnerRole) return 'WORKSPACE';
    const permission = required(this.db.permissions.find((p) => p.key === permissionKey), 'PERMISSION_NOT_FOUND', 'Permission was not found.');
    const assignment = this.db.rolePermissions.find((rp) => rp.roleId === role.id && rp.permissionId === permission.id && !rp.isDeleted);
    if (!assignment) throw new DomainError('PERMISSION_DENIED', 'Permission denied.');
    return assignment.scope;
  }

  authorizeResource(userId: string, workspaceId: string, permissionKey: string, resource: { workspaceId: string; ownerUserId?: string | null; departmentId?: string | null }): boolean {
    if (resource.workspaceId !== workspaceId) throw new DomainError('PERMISSION_DENIED', 'Cross-workspace access is denied.');
    const scope = this.requirePermission(userId, workspaceId, permissionKey);
    if (scope === 'WORKSPACE') return true;
    if (scope === 'OWN') return resource.ownerUserId === userId;
    const directDepartmentIds = this.db.departmentMembers.filter((m) => m.workspaceId === workspaceId && m.userId === userId && !m.isDeleted).map((m) => m.departmentId);
    if (scope === 'DEPARTMENT') return !!resource.departmentId && directDepartmentIds.includes(resource.departmentId);
    const tree = new Set(directDepartmentIds.flatMap((id) => [id, ...this.descendants(workspaceId, id).map((d) => d.id)]));
    return !!resource.departmentId && tree.has(resource.departmentId);
  }

  private validateDepartmentParent(tx: Database, workspaceId: string, parentDepartmentId: string | null, movingDepartmentId: string | null, name: string): void {
    if (parentDepartmentId === movingDepartmentId && parentDepartmentId) throw new DomainError('DEPARTMENT_SELF_PARENT', 'Department cannot parent itself.');
    if (parentDepartmentId) {
      const parent = required(tx.departments.find((d) => d.id === parentDepartmentId && !d.isDeleted), 'PARENT_DEPARTMENT_NOT_FOUND', 'Parent department was not found.');
      if (parent.workspaceId !== workspaceId) throw new DomainError('CROSS_WORKSPACE_PARENT', 'Parent must belong to the same workspace.');
      if (movingDepartmentId && this.descendantsInTx(tx, workspaceId, movingDepartmentId).some((d) => d.id === parentDepartmentId)) throw new DomainError('DEPARTMENT_CYCLE', 'Department cannot be moved under its descendant.');
    }
    if (tx.departments.some((d) => d.workspaceId === workspaceId && d.parentDepartmentId === parentDepartmentId && d.name.toLowerCase() === name.toLowerCase() && !d.isDeleted && d.id !== movingDepartmentId)) {
      throw new DomainError('DEPARTMENT_SIBLING_NAME_EXISTS', 'Department name must be unique among active siblings.');
    }
  }

  private assertNoActivePartnerRelation(tx: Database, workspaceId: string): void {
    if (tx.partnerWorkspaceRelations.some((r) => r.workspaceId === workspaceId && r.status === 'ACTIVE')) {
      throw new DomainError('PARTNER_RELATION_EXISTS', 'Workspace already has an active Partner relationship.');
    }
  }

  private descendantsInTx(tx: Database, workspaceId: string, departmentId: string): Department[] {
    const direct = tx.departments.filter((d) => d.workspaceId === workspaceId && d.parentDepartmentId === departmentId && !d.isDeleted);
    return direct.flatMap((d) => [d, ...this.descendantsInTx(tx, workspaceId, d.id)]);
  }

  private assignDepartmentManagerInternal(tx: Database, workspaceId: string, departmentId: string, userId: string): void {
    this.requireMembershipInTx(tx, userId, workspaceId);
    if (!tx.departmentMembers.some((m) => m.departmentId === departmentId && m.userId === userId && !m.isDeleted)) throw new DomainError('MANAGER_MUST_BE_DEPARTMENT_MEMBER', 'Manager must be an active department member.');
    const department = required(tx.departments.find((d) => d.id === departmentId), 'DEPARTMENT_NOT_FOUND', 'Department was not found.');
    department.managerId = userId;
  }

  private assertAuthenticatable(user: User): void {
    if (user.status !== 'ACTIVE' || user.isDeleted) throw new DomainError('USER_NOT_ACTIVE', 'User is not active.');
  }

  private assertPassword(password: string): void {
    if (password.length < 8 || password.length > 128 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      throw new DomainError('WEAK_PASSWORD', 'Password does not meet policy.');
    }
  }

  private enforceRateLimit(action: string, identifier: string, limit = 10, windowMs = 60_000): void {
    const key = `${action}:${identifier}`;
    const now = Date.now();
    const current = this.rateLimits.get(key);
    if (!current || current.resetAt <= now) {
      this.rateLimits.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    current.count += 1;
    if (current.count > limit) throw new DomainError('RATE_LIMITED', 'Too many attempts. Please try again later.');
  }

  private signAccessToken(userId: string): string {
    return jwt.sign({ sub: userId }, TOKEN_SECRET, { expiresIn: `${ACCESS_MINUTES}m` });
  }

  private oneTimeToken(userId: string, rawToken: string, hours: number): OneTimeToken {
    return { id: randomUUID(), userId, tokenHash: tokenHash(rawToken), expiresAt: addHours(hours), consumedAt: null, isDeleted: false };
  }

  private transaction<T>(fn: (tx: Database) => T): T {
    const snapshot = cloneDb(this.db);
    try {
      const result = fn(snapshot);
      this.db = snapshot;
      return result;
    } catch (error) {
      throw error;
    }
  }

  private audit(tx: Database, action: string, entityType: string, entityId: string | null, input: Partial<AuditLog>): void {
    if (this.failNextAuditInsert) {
      this.failNextAuditInsert = false;
      throw new DomainError('AUDIT_INSERT_FAILED', 'Audit insert failed.');
    }
    tx.auditLogs.push({
      id: randomUUID(),
      workspaceId: input.workspaceId ?? null,
      partnerId: input.partnerId ?? null,
      actorUserId: input.actorUserId ?? null,
      action,
      entityType,
      entityId,
      beforeData: sanitize(input.beforeData ?? null),
      afterData: sanitize(input.afterData ?? null),
      metadata: sanitize(input.metadata ?? null),
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
      occurredAt: new Date(),
    });
  }

  private safeAudit(action: string, entityType: string, entityId: string | null, input: Partial<AuditLog>): void {
    this.db.auditLogs.push({
      id: randomUUID(),
      workspaceId: input.workspaceId ?? null,
      partnerId: input.partnerId ?? null,
      actorUserId: input.actorUserId ?? null,
      action,
      entityType,
      entityId,
      beforeData: sanitize(input.beforeData ?? null),
      afterData: sanitize(input.afterData ?? null),
      metadata: sanitize(input.metadata ?? null),
      ipAddress: null,
      userAgent: null,
      requestId: null,
      occurredAt: new Date(),
    });
  }

  makePlatformAdmin(userId: string): void {
    const user = required(this.db.users.find((u) => u.id === userId), 'USER_NOT_FOUND', 'User was not found.');
    user.isPlatformAdmin = true;
  }

  private isPlatformAdmin(userId: string): boolean {
    return !!this.db.users.find((u) => u.id === userId && u.isPlatformAdmin && !u.isDeleted);
  }

  private blankDb(): Database {
    return {
      users: [],
      identities: [],
      verificationTokens: [],
      resetTokens: [],
      refreshSessions: [],
      workspaces: [],
      memberships: [],
      roles: [],
      permissions: [],
      rolePermissions: [],
      departments: [],
      departmentMembers: [],
      invitations: [],
      auditLogs: [],
      partnerApplications: [],
      partners: [],
      partnerRoles: [],
      partnerMemberships: [],
      partnerWorkspaceRelations: [],
      partnerWorkspaceAccess: [],
    };
  }
}

export interface AuthSessionContext {
  user: User;
  workspace: Workspace;
  membership: WorkspaceMembership;
  role: Role;
  permissions: Array<{ key: string; scope: PermissionScope }>;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  context: AuthSessionContext;
}

interface Paged<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function passwordHash(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [, salt, hash] = stored.split(':');
  const candidate = scryptSync(password, salt, 64);
  const original = Buffer.from(hash, 'hex');
  return original.length === candidate.length && timingSafeEqual(original, candidate);
}

function addHours(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function addDays(days: number): Date {
  return addHours(days * 24);
}

function safeUser(user: User): User {
  return { ...user, settings: { ...user.settings }, meta: user.meta ? { ...user.meta } : null };
}

function required<T>(value: T | undefined | null, code: string, message: string): T {
  if (!value) throw new DomainError(code, message);
  return value;
}

function uniqueSlug(tx: Database, name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace';
  let slug = base;
  let counter = 2;
  while (tx.workspaces.some((w) => w.slug === slug)) slug = `${base}-${counter++}`;
  return slug;
}

function stableId(input: string): string {
  const hash = createHash('sha1').update(input).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function cloneDb(db: Database): Database {
  return {
    users: db.users.map((x) => ({ ...x, settings: { ...x.settings }, meta: x.meta ? { ...x.meta } : null, emailVerifiedAt: x.emailVerifiedAt ? new Date(x.emailVerifiedAt) : null })),
    identities: db.identities.map((x) => ({ ...x })),
    verificationTokens: db.verificationTokens.map((x) => ({ ...x, expiresAt: new Date(x.expiresAt), consumedAt: x.consumedAt ? new Date(x.consumedAt) : null })),
    resetTokens: db.resetTokens.map((x) => ({ ...x, expiresAt: new Date(x.expiresAt), consumedAt: x.consumedAt ? new Date(x.consumedAt) : null })),
    refreshSessions: db.refreshSessions.map((x) => ({ ...x, expiresAt: new Date(x.expiresAt), revokedAt: x.revokedAt ? new Date(x.revokedAt) : null })),
    workspaces: db.workspaces.map((x) => ({ ...x, settings: x.settings ? { ...x.settings } : null, meta: x.meta ? { ...x.meta } : null })),
    memberships: db.memberships.map((x) => ({ ...x })),
    roles: db.roles.map((x) => ({ ...x })),
    permissions: db.permissions.map((x) => ({ ...x })),
    rolePermissions: db.rolePermissions.map((x) => ({ ...x })),
    departments: db.departments.map((x) => ({ ...x })),
    departmentMembers: db.departmentMembers.map((x) => ({ ...x })),
    invitations: db.invitations.map((x) => ({ ...x, expiresAt: new Date(x.expiresAt) })),
    auditLogs: db.auditLogs.map((x) => ({ ...x, occurredAt: new Date(x.occurredAt) })),
    partnerApplications: db.partnerApplications.map((x) => ({ ...x })),
    partners: db.partners.map((x) => ({ ...x, discountOverrides: { ...x.discountOverrides } })),
    partnerRoles: db.partnerRoles.map((x) => ({ ...x })),
    partnerMemberships: db.partnerMemberships.map((x) => ({ ...x })),
    partnerWorkspaceRelations: db.partnerWorkspaceRelations.map((x) => ({ ...x })),
    partnerWorkspaceAccess: db.partnerWorkspaceAccess.map((x) => ({ ...x, expiresAt: x.expiresAt ? new Date(x.expiresAt) : null })),
  };
}

function sanitize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitize);
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (/password|token|secret|hash|credential|apiKey/i.test(key)) {
      output[key] = '[REDACTED]';
    } else {
      output[key] = sanitize(raw);
    }
  }
  return output;
}

function queryRows<T extends Record<string, any>>(rows: T[], query: QueryOptions, searchable: string[], filterable: string[], sortable: string[]): Paged<T> {
  let output = [...rows];
  if (query.search) {
    const needle = query.search.toLowerCase();
    output = output.filter((row) => searchable.some((field) => String(row[field] ?? '').toLowerCase().includes(needle)));
  }
  for (const [field, operators] of Object.entries(query.filter ?? {})) {
    if (!filterable.includes(field)) throw new DomainError('INVALID_FILTER_FIELD', `Filtering by ${field} is not allowed.`);
    output = output.filter((row) => Object.entries(operators).every(([op, value]) => compare(row[field], op, value)));
  }
  const sortBy = query.sortBy ?? sortable[0];
  if (sortBy && !sortable.includes(sortBy)) throw new DomainError('INVALID_SORT_FIELD', `Sorting by ${sortBy} is not allowed.`);
  const direction = query.sortOrder === 'desc' ? -1 : 1;
  if (sortBy) output.sort((a, b) => String(a[sortBy] ?? '').localeCompare(String(b[sortBy] ?? '')) * direction);
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(100, Math.max(1, query.limit ?? 20));
  const total = output.length;
  return { data: output.slice((page - 1) * limit, page * limit), meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

function compare(actual: unknown, op: string, expected: unknown): boolean {
  if (op === 'eq') return actual === expected;
  if (op === 'neq') return actual !== expected;
  if (op === 'in') return Array.isArray(expected) && expected.includes(actual);
  if (op === 'notIn') return Array.isArray(expected) && !expected.includes(actual);
  if (op === 'contains') return String(actual ?? '').includes(String(expected));
  if (op === 'startsWith') return String(actual ?? '').startsWith(String(expected));
  if (op === 'endsWith') return String(actual ?? '').endsWith(String(expected));
  if (op === 'gt') return Number(actual) > Number(expected);
  if (op === 'gte') return Number(actual) >= Number(expected);
  if (op === 'lt') return Number(actual) < Number(expected);
  if (op === 'lte') return Number(actual) <= Number(expected);
  if (op === 'isNull') return (actual === null || actual === undefined) === Boolean(expected);
  throw new DomainError('INVALID_FILTER_OPERATOR', `Filter operator ${op} is not supported.`);
}
