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
  AutomationAction,
  AutomationActionExecution,
  AutomationCredential,
  AutomationExecution,
  AutomationExtension,
  AutomationJob,
  AutomationLog,
  AutomationRevision,
  AutomationRule,
} from './automation/types';
import type {
  Catalog,
  CatalogCategory,
  CatalogSettings,
  CatalogUnit,
  CommercialProductRow,
  CommercialRowSet,
  PriceType,
  Product,
  ProductCategoryMembership,
  ProductMedia,
  ProductPrice,
  ProductUnitRatio,
  PropertyProfile,
} from './catalog/types';
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
import type {
  BackgroundJob, BankAccount, Channel, ChannelConnection, ChannelProviderEvent, CommercialSnapshot, ContactQueue,
  Conversation, ConversationAssignment, ConversationMessage, ConversationTransfer, CrmForm, CustomerIdentity, Estimate, EstimateStage,
  FormEntityBinding, FormSubmission, FormUpload, FormVersion, Invoice, InvoiceSequence, Payment, PaymentAllocation,
  PaymentAttempt, ProviderEvent, QueueMember, RecurringOccurrence, RecurringRule, Refund, Requisite, RequisiteAddress,
  RequisitePreset, SellerCompanyBinding, SlaPolicy, SlaTimer,
} from './commercial/types';
import type {
  AdCampaign, AnalyticsFact, AnalyticsFreshness, AnalyticsReport, ApiApplication, ApiCredential, AttributionModelVersion,
  AttributionResult, AttributionSettings, AttributionTouch, BiCredential, Dashboard, DuplicateCandidate, DuplicateExclusion,
  DuplicateKey, DuplicateRule, EntitlementGrant, ExportJob, ExternalEntityLink, ImportJob, ImportRow, IntelligenceJob,
  IntegrationConnection, IntegrationProviderEvent, KpiTarget, MarketingCost, MergeOperation, MergeRedirect, MetricVersion,
  PrivateArtifact, QualityFinding, QualityRule, QualityScore, ReportSchedule, ReportScheduleRun, RetentionRecord,
  SemanticDataset, SourceOverride, SourceRule, SyncConflict, SyncRun, TrackingAsset, TrafficSource, Visitor,
  VisitorIdentityLink, VisitorSession, WebhookDelivery, WebhookSubscription,
} from './intelligence/types';
import type {
  Project, ProjectMember, ProjectStage, ProjectStageHistory, ProjectTool, Task, TaskChecklist, TaskChecklistItem,
  TaskCompletionReview, TaskCrmBinding, TaskDeadlineHistory, TaskDependency, TaskHistory, TaskMember, TaskPlannerPosition,
  TaskRecurrenceInstance, TaskRecurrenceRule, TaskResult, TaskTemplate, TaskTemplateChecklistItem, TaskTemplateMember,
  TaskTemplateSubtask, TaskTimeEntry,
} from './collab/tasks/types';
import type { Calendar, CalendarPermission, UserCalendarPreference } from './collab/calendar/types';
import { emptyCalendarEventsState } from './collab/calendar/event-types';
import type { CalendarEventsState } from './collab/calendar/event-types';
import { emptyCalendarRecurrenceState } from './collab/calendar/recurrence-types';
import type { CalendarRecurrenceState } from './collab/calendar/recurrence-types';
import type { CalendarResource, CalendarResourceBooking } from './collab/calendar/resource-types';
import type { CalendarBookingPage, CalendarBookingPageRules, CalendarBooking, CalendarAvailabilityEpoch } from './collab/calendar/booking-types';
import type { WorkingSchedule, UserWorkingSchedule, CalendarAvailabilityRebuild } from './collab/calendar/availability-types';
import type { Chat, ChatMember, ChatMembershipSource } from './collab/communication/types';

/** Tasks & Projects collections (one Prisma table each). */
export type TasksProjectsState = {
  projects: Project[];
  projectMembers: ProjectMember[];
  projectTools: ProjectTool[];
  projectStages: ProjectStage[];
  projectStageHistory: ProjectStageHistory[];
  tasks: Task[];
  taskMembers: TaskMember[];
  taskCompletionReviews: TaskCompletionReview[];
  taskResults: TaskResult[];
  taskDeadlineHistory: TaskDeadlineHistory[];
  taskHistory: TaskHistory[];
  taskCrmBindings: TaskCrmBinding[];
  taskPlannerPositions: TaskPlannerPosition[];
  taskChecklists: TaskChecklist[];
  taskChecklistItems: TaskChecklistItem[];
  taskDependencies: TaskDependency[];
  taskTimeEntries: TaskTimeEntry[];
  taskTemplates: TaskTemplate[];
  taskTemplateMembers: TaskTemplateMember[];
  taskTemplateChecklistItems: TaskTemplateChecklistItem[];
  taskTemplateSubtasks: TaskTemplateSubtask[];
  taskRecurrenceRules: TaskRecurrenceRule[];
  taskRecurrenceInstances: TaskRecurrenceInstance[];
};

export function emptyTasksProjectsState(): TasksProjectsState {
  return {
    projects: [], projectMembers: [], projectTools: [], projectStages: [], projectStageHistory: [], tasks: [], taskMembers: [],
    taskCompletionReviews: [], taskResults: [], taskDeadlineHistory: [], taskHistory: [], taskCrmBindings: [], taskPlannerPositions: [],
    taskChecklists: [], taskChecklistItems: [], taskDependencies: [], taskTimeEntries: [], taskTemplates: [], taskTemplateMembers: [],
    taskTemplateChecklistItems: [], taskTemplateSubtasks: [], taskRecurrenceRules: [], taskRecurrenceInstances: [],
  };
}

export type DbState = TasksProjectsState & CalendarEventsState & CalendarRecurrenceState & {
  fileStorages: import('./collab/files/types').ProjectFileStorage[];
  fileFolders: import('./collab/files/types').ProjectRootFolder[];
  storageAccessSources: import('./collab/files/types').StorageAccessSource[];
  chats: Chat[];
  directChatPairs: import('./collab/communication/types').DirectChatPair[];
  collabSpaces: import('./collab/communication/types').CollabSpace[];
  collabSpaceMembers: import('./collab/communication/types').CollabSpaceMember[];
  filePermissionAssignments: import('./collab/files/types').FilePermissionAssignment[];
  filePublicLinks: import('./collab/files/types').FilePublicLink[];
  fileDeliveryGrants: import('./collab/files/delivery-service').FileDeliveryGrant[];
  fileAttachments: import('./collab/files/attachment-service').FileAttachment[];
  fileLocks: import('./collab/files/editing-types').FileLock[];
  documentEditSessions: import('./collab/files/editing-types').DocumentEditSession[];
  documentTemplates: import('./collab/files/document-types').DocumentTemplate[];
  documentTemplateRevisions: import('./collab/files/document-types').DocumentTemplateRevision[];
  generatedDocuments: import('./collab/files/document-types').GeneratedDocument[];
  driveFiles: import('./collab/files/types').DriveFile[];
  driveFileVersions: import('./collab/files/types').DriveFileVersion[];
  uploadSessions: import('./collab/files/types').UploadSession[];
  fileObjectGarbage: import('./collab/files/types').FileObjectGarbage[];
  chatMembers: ChatMember[];
  chatMembershipSources: ChatMembershipSource[];
  chatMessages: import('./collab/communication/message-types').ChatMessage[];
  chatMessageVersions: import('./collab/communication/message-types').ChatMessageVersion[];
  chatMessageReactions: import('./collab/communication/message-types').ChatMessageReaction[];
  chatMessagePins: import('./collab/communication/message-types').ChatMessagePin[];
  chatMessageFavorites: import('./collab/communication/message-types').ChatMessageFavorite[];
  chatMessageReads: import('./collab/communication/message-types').ChatMessageRead[];
  chatReadStates: import('./collab/communication/message-types').ChatReadState[];
  chatDrafts: import('./collab/communication/message-types').ChatDraft[];
  communicationBindings: import('./collab/communication/message-types').CommunicationBinding[];
  channels: import('./collab/communication/channel-types').Channel[];
  channelMembers: import('./collab/communication/channel-types').ChannelMember[];
  channelMembershipSources: import('./collab/communication/channel-types').ChannelMembershipSource[];
  channelPosts: import('./collab/communication/channel-types').ChannelPost[];
  channelComments: import('./collab/communication/channel-types').ChannelComment[];
  collabInvitations: import('./collab/communication/types').CollabInvitation[];
  calls: import('./collab/communication/call-types').CommunicationCall[];
  callParticipants: import('./collab/communication/call-types').CommunicationCallParticipant[];
  callInvitations: import('./collab/communication/call-types').CommunicationCallInvitation[];
  feedPosts: import('./collab/communication/feed-types').FeedPost[];
  feedPostRecipients: import('./collab/communication/feed-types').FeedPostRecipient[];
  feedAudienceSnapshots: import('./collab/communication/feed-types').FeedAudienceSnapshot[];
  feedComments: import('./collab/communication/feed-types').FeedComment[];
  feedReactions: import('./collab/communication/feed-types').FeedReaction[];
  feedFavorites: import('./collab/communication/feed-types').FeedFavorite[];
  feedReads: import('./collab/communication/feed-types').FeedRead[];
  feedAcknowledgements: import('./collab/communication/feed-types').FeedAcknowledgement[];
  feedPolls: import('./collab/communication/feed-types').FeedPoll[];
  feedPollOptions: import('./collab/communication/feed-types').FeedPollOption[];
  feedPollVotes: import('./collab/communication/feed-types').FeedPollVote[];
  calendarSyncConnections: import('./collab/calendar/sync-types').CalendarSyncConnection[];
  calendarSyncCredentials: import('./collab/calendar/sync-types').CalendarSyncCredential[];
  calendarSyncMappings: import('./collab/calendar/sync-types').CalendarSyncMapping[];
  calendarSyncConflicts: import('./collab/calendar/sync-types').CalendarSyncConflict[];
  calendarResources: CalendarResource[];
  calendarBookingPages: CalendarBookingPage[];
  calendarBookingPageRules: CalendarBookingPageRules[];
  calendarBookings: CalendarBooking[];
  calendarAvailabilityEpochs: CalendarAvailabilityEpoch[];
  calendarResourceBookings: CalendarResourceBooking[];
  businessCalendars: WorkingSchedule[];
  userWorkingSchedules: UserWorkingSchedule[];
  calendarAvailabilityRebuilds: CalendarAvailabilityRebuild[];
  calendars: Calendar[];
  calendarPermissions: CalendarPermission[];
  userCalendarPreferences: UserCalendarPreference[];
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
  catalogSettings: CatalogSettings[];
  catalogs: Catalog[];
  catalogUnits: CatalogUnit[];
  catalogPriceTypes: PriceType[];
  catalogCategories: CatalogCategory[];
  catalogProducts: Product[];
  catalogProductCategories: ProductCategoryMembership[];
  catalogUnitRatios: ProductUnitRatio[];
  catalogPrices: ProductPrice[];
  catalogPropertyProfiles: PropertyProfile[];
  catalogProductMedia: ProductMedia[];
  commercialRowSets: CommercialRowSet[];
  commercialProductRows: CommercialProductRow[];
  automationRules: AutomationRule[];
  automationRevisions: AutomationRevision[];
  automationActions: AutomationAction[];
  automationJobs: AutomationJob[];
  automationExecutions: AutomationExecution[];
  automationActionExecutions: AutomationActionExecution[];
  automationLogs: AutomationLog[];
  automationExtensions: AutomationExtension[];
  automationCredentials: AutomationCredential[];
  requisitePresets: RequisitePreset[];
  requisites: Requisite[];
  requisiteAddresses: RequisiteAddress[];
  bankAccounts: BankAccount[];
  sellerCompanyBindings: SellerCompanyBinding[];
  commercialSnapshots: CommercialSnapshot[];
  estimateStages: EstimateStage[];
  estimates: Estimate[];
  invoices: Invoice[];
  invoiceSequences: InvoiceSequence[];
  payments: Payment[];
  paymentAllocations: PaymentAllocation[];
  paymentAttempts: PaymentAttempt[];
  paymentProviderEvents: ProviderEvent[];
  refunds: Refund[];
  recurringRules: RecurringRule[];
  recurringOccurrences: RecurringOccurrence[];
  crmForms: CrmForm[];
  crmFormVersions: FormVersion[];
  crmFormSubmissions: FormSubmission[];
  crmFormEntityBindings: FormEntityBinding[];
  crmFormUploads: FormUpload[];
  communicationChannels: Channel[];
  channelConnections: ChannelConnection[];
  contactCenterQueues: ContactQueue[];
  contactCenterQueueMembers: QueueMember[];
  customerChannelIdentities: CustomerIdentity[];
  customerConversations: Conversation[];
  conversationMessages: ConversationMessage[];
  conversationAssignments: ConversationAssignment[];
  conversationTransfers: ConversationTransfer[];
  channelProviderEvents: ChannelProviderEvent[];
  slaPolicies: SlaPolicy[];
  slaTimers: SlaTimer[];
  backgroundJobs: BackgroundJob[];
  entitlementGrants: EntitlementGrant[];
  retentionRecords: RetentionRecord[];
  intelligenceJobs: IntelligenceJob[];
  duplicateRules: DuplicateRule[];
  duplicateKeys: DuplicateKey[];
  duplicateCandidates: DuplicateCandidate[];
  duplicateExclusions: DuplicateExclusion[];
  mergeOperations: MergeOperation[];
  mergeRedirects: MergeRedirect[];
  qualityRules: QualityRule[];
  qualityFindings: QualityFinding[];
  qualityScores: QualityScore[];
  importJobs: ImportJob[];
  importRows: ImportRow[];
  exportJobs: ExportJob[];
  privateArtifacts: PrivateArtifact[];
  apiApplications: ApiApplication[];
  apiCredentials: ApiCredential[];
  integrationConnections: IntegrationConnection[];
  externalEntityLinks: ExternalEntityLink[];
  syncRuns: SyncRun[];
  syncConflicts: SyncConflict[];
  webhookSubscriptions: WebhookSubscription[];
  webhookDeliveries: WebhookDelivery[];
  integrationProviderEvents: IntegrationProviderEvent[];
  trafficSources: TrafficSource[];
  sourceRules: SourceRule[];
  visitors: Visitor[];
  visitorSessions: VisitorSession[];
  attributionTouches: AttributionTouch[];
  visitorIdentityLinks: VisitorIdentityLink[];
  trackingAssets: TrackingAsset[];
  sourceOverrides: SourceOverride[];
  adCampaigns: AdCampaign[];
  marketingCosts: MarketingCost[];
  attributionModelVersions: AttributionModelVersion[];
  attributionSettings: AttributionSettings[];
  attributionResults: AttributionResult[];
  analyticsFacts: AnalyticsFact[];
  analyticsFreshness: AnalyticsFreshness[];
  metricVersions: MetricVersion[];
  semanticDatasets: SemanticDataset[];
  analyticsReports: AnalyticsReport[];
  dashboards: Dashboard[];
  kpiTargets: KpiTarget[];
  reportSchedules: ReportSchedule[];
  reportScheduleRuns: ReportScheduleRun[];
  biCredentials: BiCredential[];
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
      catalogSettings: [],
      catalogs: [],
      catalogUnits: [],
      catalogPriceTypes: [],
      catalogCategories: [],
      catalogProducts: [],
      catalogProductCategories: [],
      catalogUnitRatios: [],
      catalogPrices: [],
      catalogPropertyProfiles: [],
      catalogProductMedia: [],
      commercialRowSets: [],
      commercialProductRows: [],
      automationRules: [],
      automationRevisions: [],
      automationActions: [],
      automationJobs: [],
      automationExecutions: [],
      automationActionExecutions: [],
      automationLogs: [],
      automationExtensions: [],
      automationCredentials: [],
      requisitePresets: [],
      requisites: [],
      requisiteAddresses: [],
      bankAccounts: [],
      sellerCompanyBindings: [],
      commercialSnapshots: [],
      estimateStages: [],
      estimates: [],
      invoices: [],
      invoiceSequences: [],
      payments: [],
      paymentAllocations: [],
      paymentAttempts: [],
      paymentProviderEvents: [],
      refunds: [],
      recurringRules: [],
      recurringOccurrences: [],
      crmForms: [],
      crmFormVersions: [],
      crmFormSubmissions: [],
      crmFormEntityBindings: [],
      crmFormUploads: [],
      communicationChannels: [],
      channelConnections: [],
      contactCenterQueues: [],
      contactCenterQueueMembers: [],
      customerChannelIdentities: [],
      customerConversations: [],
      conversationMessages: [],
      conversationAssignments: [],
      conversationTransfers: [],
      channelProviderEvents: [],
      slaPolicies: [],
      slaTimers: [],
      backgroundJobs: [],
      entitlementGrants: [],
      retentionRecords: [],
      intelligenceJobs: [],
      duplicateRules: [],
      duplicateKeys: [],
      duplicateCandidates: [],
      duplicateExclusions: [],
      mergeOperations: [],
      mergeRedirects: [],
      qualityRules: [],
      qualityFindings: [],
      qualityScores: [],
      importJobs: [],
      importRows: [],
      exportJobs: [],
      privateArtifacts: [],
      apiApplications: [],
      apiCredentials: [],
      integrationConnections: [],
      externalEntityLinks: [],
      syncRuns: [],
      syncConflicts: [],
      webhookSubscriptions: [],
      webhookDeliveries: [],
      integrationProviderEvents: [],
      trafficSources: [],
      sourceRules: [],
      visitors: [],
      visitorSessions: [],
      attributionTouches: [],
      visitorIdentityLinks: [],
      trackingAssets: [],
      sourceOverrides: [],
      adCampaigns: [],
      marketingCosts: [],
      attributionModelVersions: [],
      attributionSettings: [],
      attributionResults: [],
      analyticsFacts: [],
      analyticsFreshness: [],
      metricVersions: [],
      semanticDatasets: [],
      analyticsReports: [],
      dashboards: [],
      kpiTargets: [],
      reportSchedules: [],
      reportScheduleRuns: [],
      biCredentials: [],
      ...emptyTasksProjectsState(),
      fileStorages: [], fileFolders: [], storageAccessSources: [], filePermissionAssignments: [], filePublicLinks: [], driveFiles: [], driveFileVersions: [], uploadSessions: [], fileObjectGarbage: [], fileDeliveryGrants: [], fileAttachments: [], fileLocks: [], documentEditSessions: [], documentTemplates: [], documentTemplateRevisions: [], generatedDocuments: [],
      directChatPairs: [], collabSpaces: [], collabSpaceMembers: [],
      chats: [], chatMembers: [], chatMembershipSources: [], chatMessages: [], chatMessageVersions: [], chatMessageReactions: [], chatMessagePins: [],
      chatMessageFavorites: [], chatMessageReads: [], chatReadStates: [], chatDrafts: [], communicationBindings: [],
      channels: [], channelMembers: [], channelMembershipSources: [], channelPosts: [], channelComments: [], collabInvitations: [], calls: [], callParticipants: [], callInvitations: [],
      feedPosts: [], feedPostRecipients: [], feedAudienceSnapshots: [], feedComments: [], feedReactions: [], feedFavorites: [], feedReads: [], feedAcknowledgements: [], feedPolls: [], feedPollOptions: [], feedPollVotes: [], calendarSyncConnections: [], calendarSyncCredentials: [], calendarSyncMappings: [], calendarSyncConflicts: [],
      calendars: [], calendarPermissions: [], userCalendarPreferences: [],
      ...emptyCalendarEventsState(),
      ...emptyCalendarRecurrenceState(),
      calendarResources: [], calendarResourceBookings: [],
      calendarBookingPages: [], calendarBookingPageRules: [],
      calendarBookings: [], calendarAvailabilityEpochs: [],
      businessCalendars: [], userWorkingSchedules: [],
      calendarAvailabilityRebuilds: [],
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
