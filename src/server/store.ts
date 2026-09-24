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
import type {
  CustomField,
  CustomFieldMigration,
  CustomFieldOption,
  CustomFieldValueRow,
  FieldRequirement,
  FieldSchemaVersion,
  FieldVisibilityRule,
} from './fields/types';
import type {
  Activity,
  ActivityBinding,
  ActivityCommunication,
  ActivityOverdueOccurrence,
  ActivityParticipant,
  ActivityReminder,
  ActivityReminderRecipient,
  ActivityType,
  TimelineComment,
  TimelineCommentMention,
  TimelineEntry,
} from './activities/types';

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
  crmCustomFields: CustomField[];
  crmCustomFieldOptions: CustomFieldOption[];
  crmCustomFieldValues: CustomFieldValueRow[];
  crmFieldVisibilityRules: FieldVisibilityRule[];
  crmFieldRequirements: FieldRequirement[];
  crmCustomFieldMigrations: CustomFieldMigration[];
  crmFieldSchemaVersions: FieldSchemaVersion[];
  crmActivityTypes: ActivityType[];
  crmActivities: Activity[];
  crmActivityBindings: ActivityBinding[];
  crmActivityParticipants: ActivityParticipant[];
  crmActivityCommunications: ActivityCommunication[];
  crmActivityReminders: ActivityReminder[];
  crmActivityReminderRecipients: ActivityReminderRecipient[];
  crmActivityOverdueOccurrences: ActivityOverdueOccurrence[];
  crmTimelineEntries: TimelineEntry[];
  crmTimelineComments: TimelineComment[];
  crmTimelineCommentMentions: TimelineCommentMention[];
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
      crmCustomFields: [],
      crmCustomFieldOptions: [],
      crmCustomFieldValues: [],
      crmFieldVisibilityRules: [],
      crmFieldRequirements: [],
      crmCustomFieldMigrations: [],
      crmFieldSchemaVersions: [],
      crmActivityTypes: [],
      crmActivities: [],
      crmActivityBindings: [],
      crmActivityParticipants: [],
      crmActivityCommunications: [],
      crmActivityReminders: [],
      crmActivityReminderRecipients: [],
      crmActivityOverdueOccurrences: [],
      crmTimelineEntries: [],
      crmTimelineComments: [],
      crmTimelineCommentMentions: [],
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

  /**
   * Runs a multi-record mutation and, if it throws, rolls every touched row back IN PLACE, so a failed business
   * operation never leaves half-applied changes for the request wrapper to persist. Rows keep their object identity
   * (callers and tests that still hold a reference to a record see the restored values).
   * Rows are restored shallowly: mutation code must replace nested values instead of mutating them in place.
   */
  atomicSync<T>(operation: () => T): T {
    const snapshot = this.captureShallow();
    try {
      return operation();
    } catch (error) {
      this.restoreShallow(snapshot);
      throw error;
    }
  }

  async atomic<T>(operation: () => Promise<T>): Promise<T> {
    const snapshot = this.captureShallow();
    try {
      return await operation();
    } catch (error) {
      this.restoreShallow(snapshot);
      throw error;
    }
  }

  private captureShallow() {
    const entries: Array<{ key: keyof DbState; rows: object[]; copies: object[] }> = [];
    for (const key of Object.keys(this.state) as Array<keyof DbState>) {
      const rows = this.state[key] as unknown as object[];
      entries.push({ key, rows: [...rows], copies: rows.map((row) => ({ ...row })) });
    }
    return entries;
  }

  private restoreShallow(snapshot: ReturnType<InMemoryStore['captureShallow']>) {
    const state = this.state as unknown as Record<string, object[]>;
    for (const { key, rows, copies } of snapshot) {
      rows.forEach((row, index) => {
        const original = copies[index] as Record<string, unknown>;
        const target = row as Record<string, unknown>;
        for (const field of Object.keys(target)) if (!(field in original)) delete target[field];
        Object.assign(target, original);
      });
      state[key as string] = rows;
    }
  }

  cloneState(): DbState {
    return structuredClone(this.state);
  }

  id() {
    return crypto.randomUUID();
  }
}
