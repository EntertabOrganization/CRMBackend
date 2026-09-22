export type UserStatus = 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED';
export type AuthProvider = 'LOCAL' | 'GOOGLE';
export type MembershipStatus = 'ACTIVE' | 'SUSPENDED';
export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'REVOKED' | 'EXPIRED';
export type PermissionScope = 'OWN' | 'DEPARTMENT' | 'DEPARTMENT_TREE' | 'WORKSPACE';
export type PartnerApplicationStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type PartnerStatus = 'ACTIVE' | 'SUSPENDED';

export type User = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  settings: Record<string, unknown>;
  meta?: Record<string, unknown> | null;
  status: UserStatus;
  emailVerifiedAt?: Date | null;
  isDeleted: boolean;
};

export type AuthIdentity = {
  id: string;
  userId: string;
  provider: AuthProvider;
  providerUserId?: string | null;
  passwordHash?: string | null;
  isDeleted: boolean;
};

export type RefreshSession = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt?: Date | null;
  isDeleted: boolean;
};

export type OneTimeToken = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt?: Date | null;
  isDeleted: boolean;
};

export type Workspace = {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  settings: Record<string, unknown>;
  meta?: Record<string, unknown> | null;
  ownerUserId: string;
  isDeleted: boolean;
};

export type WorkspaceMembership = {
  id: string;
  workspaceId: string;
  userId: string;
  roleId: string;
  status: MembershipStatus;
  isDeleted: boolean;
};

export type WorkspaceInvitation = {
  id: string;
  workspaceId: string;
  email: string;
  roleId: string;
  tokenHash: string;
  status: InvitationStatus;
  expiresAt: Date;
  acceptedAt?: Date | null;
  invitedById?: string | null;
  isDeleted: boolean;
};

export type Permission = {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  module: string;
  resource: string;
  action: string;
  isDeleted: boolean;
};

export type Role = {
  id: string;
  workspaceId: string;
  name: string;
  description?: string | null;
  isSystem: boolean;
  isOwnerRole: boolean;
  isDeleted: boolean;
};

export type RolePermission = {
  id: string;
  roleId: string;
  permissionId: string;
  scope: PermissionScope;
  isDeleted: boolean;
};

export type Department = {
  id: string;
  workspaceId: string;
  parentDepartmentId?: string | null;
  name: string;
  description?: string | null;
  managerId?: string | null;
  isDeleted: boolean;
};

export type DepartmentMember = {
  id: string;
  workspaceId: string;
  departmentId: string;
  userId: string;
  isDeleted: boolean;
};

export type PartnerApplication = {
  id: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  partnerName: string;
  country: string;
  website?: string | null;
  businessDescription: string;
  status: PartnerApplicationStatus;
  isDeleted: boolean;
};

export type Partner = {
  id: string;
  name: string;
  country: string;
  website?: string | null;
  businessDescription?: string | null;
  status: PartnerStatus;
  defaultDiscount: number;
  settings: Record<string, unknown>;
  meta?: Record<string, unknown> | null;
  isDeleted: boolean;
};

export type PartnerRole = {
  id: string;
  name: string;
  isOwnerRole: boolean;
  isDeleted: boolean;
};

export type PartnerMembership = {
  id: string;
  partnerId: string;
  userId: string;
  partnerRoleId: string;
  status: MembershipStatus;
  isDeleted: boolean;
};

export type PartnerWorkspaceRelation = {
  id: string;
  partnerId: string;
  workspaceId: string;
  isDeleted: boolean;
};

export type AuditLog = {
  id: string;
  workspaceId?: string | null;
  partnerId?: string | null;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  beforeData?: unknown;
  afterData?: unknown;
  metadata?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  occurredAt: Date;
};

export type SessionContext = {
  user: SafeUser;
  workspace: Workspace | null;
  membership: WorkspaceMembership | null;
  role: Role | null;
  permissions: EffectivePermission[];
};

export type EffectivePermission = {
  key: string;
  scope: PermissionScope;
};

export type SafeUser = Omit<User, 'isDeleted'> & { isDeleted?: boolean };

export type PageMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export type ApiSuccess<T> = {
  success: true;
  data: T;
  meta: PageMeta | null;
};

export type ApiFailure = {
  success: false;
  error: {
    code: string;
    message: string;
    details: unknown;
  };
  requestId: string;
};
