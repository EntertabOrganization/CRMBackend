import type {
  AuditLog,
  AuthIdentity,
  Department,
  DepartmentMember,
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
