export type UserStatus = 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED';
export type AuthProvider = 'LOCAL' | 'GOOGLE';
export type MembershipStatus = 'ACTIVE' | 'SUSPENDED';
export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'REVOKED' | 'EXPIRED';
export type PermissionScope = 'OWN' | 'DEPARTMENT' | 'DEPARTMENT_TREE' | 'WORKSPACE';
export type PartnerApplicationStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type PartnerStatus = 'ACTIVE' | 'SUSPENDED';
export type CrmPipelineEntityType = 'LEAD' | 'DEAL';
export type CrmRecordEntityType = 'LEAD' | 'DEAL' | 'CONTACT' | 'COMPANY';
export type CrmStageSemanticType = 'PROGRESS' | 'SUCCESS' | 'FAILURE';
export type CrmLeadStatus = 'ACTIVE' | 'QUALIFIED' | 'DISQUALIFIED';
export type CrmLeadConversionStatus = 'NOT_CONVERTED' | 'CONVERTED';
export type CrmDealStatus = 'OPEN' | 'WON' | 'LOST';
export type CrmCommunicationType = 'PHONE' | 'EMAIL' | 'WEB' | 'IM';
export type CrmConversionAction = 'CREATE' | 'LINK_EXISTING' | 'NONE';

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

export type CrmPipeline = {
  id: string;
  workspaceId: string;
  entityType: CrmPipelineEntityType;
  name: string;
  normalizedName: string;
  isDefault: boolean;
  isActive: boolean;
  transitionRulesEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export type CrmStage = {
  id: string;
  workspaceId: string;
  pipelineId: string;
  name: string;
  position: number;
  semanticType: CrmStageSemanticType;
  isDefault: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export type CrmStageTransition = {
  id: string;
  workspaceId: string;
  pipelineId: string;
  fromStageId: string;
  toStageId: string;
  isActive: boolean;
};

export type CrmRoleStagePermission = {
  id: string;
  workspaceId: string;
  roleId: string;
  stageId: string;
  canView: boolean;
  canEnter: boolean;
  canLeave: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type CrmLostReason = {
  id: string;
  workspaceId: string;
  name: string;
  isActive: boolean;
  isSystem: boolean;
};

export type CrmLead = {
  id: string;
  workspaceId: string;
  title: string;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  responsibleUserId: string;
  companyId?: string | null;
  pipelineId: string;
  stageId: string;
  status: CrmLeadStatus;
  conversionStatus: CrmLeadConversionStatus;
  convertedAt?: Date | null;
  convertedByUserId?: string | null;
  sourceId?: string | null;
  sourceDescription?: string | null;
  estimatedAmount?: number | null;
  currencyCode?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  stateOrProvince?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  originSystem?: string | null;
  originExternalId?: string | null;
  originVersion?: string | null;
  lostReasonId?: string | null;
  lostReasonComment?: string | null;
  isArchived: boolean;
  archivedAt?: Date | null;
  archivedByUserId?: string | null;
  deletedAt?: Date | null;
  deletedByUserId?: string | null;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export type CrmDeal = {
  id: string;
  workspaceId: string;
  title: string;
  responsibleUserId: string;
  companyId?: string | null;
  pipelineId: string;
  stageId: string;
  status: CrmDealStatus;
  amount?: number | null;
  currencyCode?: string | null;
  sourceId?: string | null;
  sourceDescription?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  originSystem?: string | null;
  originExternalId?: string | null;
  originVersion?: string | null;
  lostReasonId?: string | null;
  lostReasonComment?: string | null;
  isArchived: boolean;
  archivedAt?: Date | null;
  archivedByUserId?: string | null;
  isDeleted: boolean;
  deletedAt?: Date | null;
  deletedByUserId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export type CrmContact = {
  id: string;
  workspaceId: string;
  firstName: string;
  lastName: string;
  displayName: string;
  responsibleUserId: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  stateOrProvince?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  isArchived: boolean;
  archivedAt?: Date | null;
  archivedByUserId?: string | null;
  isDeleted: boolean;
  deletedAt?: Date | null;
  deletedByUserId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export type CrmCompany = {
  id: string;
  workspaceId: string;
  name: string;
  responsibleUserId: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  stateOrProvince?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  isArchived: boolean;
  archivedAt?: Date | null;
  archivedByUserId?: string | null;
  isDeleted: boolean;
  deletedAt?: Date | null;
  deletedByUserId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export type CrmCommunication = {
  id: string;
  workspaceId: string;
  type: CrmCommunicationType;
  value: string;
  normalizedValue: string;
  label?: string | null;
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type CrmContactCommunication = CrmCommunication & {
  contactId: string;
};

export type CrmLeadCommunication = CrmCommunication & {
  leadId: string;
};

export type CrmCompanyCommunication = CrmCommunication & {
  companyId: string;
};

export type CrmContactCompany = {
  id: string;
  workspaceId: string;
  contactId: string;
  companyId: string;
  jobTitle?: string | null;
  department?: string | null;
  isPrimary: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

export type CrmDealContact = {
  id: string;
  workspaceId: string;
  dealId: string;
  contactId: string;
  role?: string | null;
  isPrimary: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

export type CrmLeadContact = {
  id: string;
  workspaceId: string;
  leadId: string;
  contactId: string;
  isPrimary: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

export type CrmSource = {
  id: string;
  workspaceId: string;
  name: string;
  code: string;
  sortOrder: number;
  isActive: boolean;
  isSystem: boolean;
};

export type CrmLeadConversion = {
  id: string;
  workspaceId: string;
  leadId: string;
  contactId?: string | null;
  companyId?: string | null;
  dealId?: string | null;
  convertedByUserId: string;
  convertedAt: Date;
};

export type CrmRecordObserver = {
  id: string;
  workspaceId: string;
  entityType: CrmRecordEntityType;
  recordId: string;
  userId: string;
  createdByUserId: string;
  createdAt: Date;
};

export type IdempotencyRecord = {
  id: string;
  workspaceId: string;
  actorUserId: string;
  operation: string;
  idempotencyKey: string;
  requestHash: string;
  response: Record<string, unknown>;
  expiresAt: Date;
  createdAt: Date;
};

export type CrmStageHistory = {
  id: string;
  workspaceId: string;
  entityType: CrmPipelineEntityType;
  recordId: string;
  fromPipelineId?: string | null;
  fromStageId?: string | null;
  toPipelineId: string;
  toStageId: string;
  movedByUserId: string;
  movedAt: Date;
  correlationId?: string | null;
};

export type OutboxEvent = {
  id: string;
  workspaceId: string;
  eventType: string;
  entityType: string;
  entityId: string;
  actorUserId?: string | null;
  occurredAt: Date;
  payload: Record<string, unknown>;
  eventVersion?: number;
  correlationId?: string | null;
  causationId?: string | null;
  idempotencyKey?: string | null;
  /** Set once the Timeline projector has consumed the event. */
  projectedAt?: Date | null;
  /** Set once the Automation consumer has matched the event against active Rules (independent of Timeline projection). */
  automationProcessedAt?: Date | null;
  /** Depth of the Automation chain that produced the event (0 / absent = originated outside Automation). */
  automationDepth?: number;
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
