import type {
  AuditLog,
  AuthIdentity,
  CrmDeal,
  CrmCompany,
  CrmCompanyCommunication,
  CrmContact,
  CrmContactCommunication,
  CrmContactCompany,
  CrmDealContact,
  CrmLead,
  CrmLeadCommunication,
  CrmLeadContact,
  CrmLeadConversion,
  CrmLostReason,
  CrmPipeline,
  CrmRecordObserver,
  CrmRoleStagePermission,
  CrmStage,
  CrmStageHistory,
  CrmStageTransition,
  CrmSource,
  Department,
  DepartmentMember,
  IdempotencyRecord,
  OneTimeToken,
  Partner,
  PartnerApplication,
  PartnerMembership,
  PartnerRole,
  PartnerWorkspaceRelation,
  Permission,
  RefreshSession,
  Role,
  RolePermission,
  OutboxEvent,
  User,
  Workspace,
  WorkspaceInvitation,
  WorkspaceMembership,
} from './domain';
import { catalogPermissions } from './permissions';

export type DbState = {
  users: User[];
  authIdentities: AuthIdentity[];
  refreshSessions: RefreshSession[];
  emailVerificationTokens: OneTimeToken[];
  passwordResetTokens: OneTimeToken[];
  workspaces: Workspace[];
  workspaceMemberships: WorkspaceMembership[];
  workspaceInvitations: WorkspaceInvitation[];
  permissions: Permission[];
  roles: Role[];
  rolePermissions: RolePermission[];
  departments: Department[];
  departmentMembers: DepartmentMember[];
  partnerApplications: PartnerApplication[];
  partners: Partner[];
  partnerRoles: PartnerRole[];
  partnerMemberships: PartnerMembership[];
  partnerWorkspaceRelations: PartnerWorkspaceRelation[];
  auditLogs: AuditLog[];
  crmPipelines: CrmPipeline[];
  crmStages: CrmStage[];
  crmStageTransitions: CrmStageTransition[];
  crmRoleStagePermissions: CrmRoleStagePermission[];
  crmLostReasons: CrmLostReason[];
  crmContacts: CrmContact[];
  crmCompanies: CrmCompany[];
  crmSources: CrmSource[];
  crmLeadCommunications: CrmLeadCommunication[];
  crmContactCommunications: CrmContactCommunication[];
  crmCompanyCommunications: CrmCompanyCommunication[];
  crmLeadContacts: CrmLeadContact[];
  crmContactCompanies: CrmContactCompany[];
  crmLeads: CrmLead[];
  crmDeals: CrmDeal[];
  crmDealContacts: CrmDealContact[];
  crmLeadConversions: CrmLeadConversion[];
  crmRecordObservers: CrmRecordObserver[];
  crmStageHistory: CrmStageHistory[];
  outboxEvents: OutboxEvent[];
  idempotencyRecords: IdempotencyRecord[];
};

export class InMemoryStore {
  state: DbState;

  constructor(seed?: Partial<DbState>) {
    this.state = {
      users: [],
      authIdentities: [],
      refreshSessions: [],
      emailVerificationTokens: [],
      passwordResetTokens: [],
      workspaces: [],
      workspaceMemberships: [],
      workspaceInvitations: [],
      permissions: catalogPermissions(),
      roles: [],
      rolePermissions: [],
      departments: [],
      departmentMembers: [],
      partnerApplications: [],
      partners: [],
      partnerRoles: [],
      partnerMemberships: [],
      partnerWorkspaceRelations: [],
      auditLogs: [],
      crmPipelines: [],
      crmStages: [],
      crmStageTransitions: [],
      crmRoleStagePermissions: [],
      crmLostReasons: [],
      crmContacts: [],
      crmCompanies: [],
      crmSources: [],
      crmLeadCommunications: [],
      crmContactCommunications: [],
      crmCompanyCommunications: [],
      crmLeadContacts: [],
      crmContactCompanies: [],
      crmLeads: [],
      crmDeals: [],
      crmDealContacts: [],
      crmLeadConversions: [],
      crmRecordObservers: [],
      crmStageHistory: [],
      outboxEvents: [],
      idempotencyRecords: [],
      ...seed,
    };
  }

  async transaction<T>(handler: (tx: InMemoryStore) => Promise<T>): Promise<T> {
    const snapshot = this.cloneState();
    const tx = new InMemoryStore(snapshot);
    try {
      const result = await handler(tx);
      this.state = tx.state;
      return result;
    } catch (error) {
      throw error;
    }
  }

  cloneState(): DbState {
    return structuredClone(this.state);
  }

  id() {
    return crypto.randomUUID();
  }
}
