export type OwnerType = 'CONTACT' | 'COMPANY';
export type CommercialRole = 'BUYER' | 'SELLER';

export type RequisitePreset = {
  id: string; workspaceId: string | null; countryCode: string; entityTypeCode: string; name: string;
  active: boolean; version: number; fields: Array<{ code: string; label: string; type: string; required: boolean; protected?: boolean }>;
};
export type Requisite = {
  id: string; workspaceId: string; ownerType: OwnerType; ownerId: string; presetId: string; name: string;
  countryCode: string; entityTypeCode: string; values: Record<string, unknown>; isDefault: boolean; active: boolean;
  referenced: boolean; createdAt: Date; updatedAt: Date; version: number;
};
export type RequisiteAddress = {
  id: string; workspaceId: string; requisiteId: string; type: 'LEGAL'|'REGISTERED'|'BILLING'|'SHIPPING'|'MAILING'|'OTHER';
  countryCode: string; region?: string|null; city?: string|null; postalCode?: string|null; line1: string; line2?: string|null;
  isDefaultForType: boolean; active: boolean; createdAt: Date; updatedAt: Date;
};
export type BankAccount = {
  id: string; workspaceId: string; requisiteId: string; name: string; countryCode: string; currencyCode?: string|null;
  bankName?: string|null; accountHolderName?: string|null; accountNumber: string; swiftBic?: string|null;
  routingData: Record<string, string>; isDefault: boolean; active: boolean; createdAt: Date; updatedAt: Date;
};
export type SellerCompanyBinding = {
  id: string; workspaceId: string; companyId: string; active: boolean; isWorkspaceDefault: boolean;
  contextKey?: string|null; priority: number; preferredRequisiteId?: string|null; preferredBankAccountId?: string|null;
};
export type CommercialSnapshot = {
  id: string; workspaceId: string; role: CommercialRole; sourceOwnerType: OwnerType; sourceOwnerId: string;
  sourceRequisiteId: string; sourceBankAccountId?: string|null; countryCode: string; entityTypeCode: string;
  legalName: string; legalValues: Record<string, unknown>; address: Record<string, unknown>|null;
  bank: Record<string, unknown>|null; createdAt: Date; snapshotVersion: number;
};

export type MoneyLine = {
  id: string; productId?: string|null; description: string; quantity: string; unitCode?: string|null; unitPrice: string;
  discountType: 'NONE'|'PERCENT'|'FIXED'; discountValue: string; taxCode?: string|null; taxRate: string;
  netAmount: string; discountAmount: string; taxAmount: string; totalAmount: string; sortOrder: number;
};
export type EstimateStatus = 'DRAFT'|'ACTIVE'|'ACCEPTED'|'DECLINED'|'EXPIRED'|'CONVERTED';
export type EstimateStage = { id:string; workspaceId:string; name:string; semanticStatus:EstimateStatus; position:number; active:boolean; isDefault:boolean; version:number };
export type EstimateRevision = {
  id: string; workspaceId: string; estimateId: string; revisionNumber: number; status: 'DRAFT'|'SENT'|'SUPERSEDED'|'ACCEPTED'|'DECLINED'|'EXPIRED';
  buyerSnapshotId?: string|null; sellerSnapshotId?: string|null; currencyCode: string; subtotal: string; discountTotal: string;
  taxTotal: string; grandTotal: string; lines: MoneyLine[]; sentAt?: Date|null; acceptedAt?: Date|null; declinedAt?: Date|null;
};
export type Estimate = {
  id: string; workspaceId: string; number?: string|null; subject: string; semanticStatus: EstimateStatus; stageId: string;
  customerContactId?: string|null; customerCompanyId?: string|null; dealId?: string|null; sellerCompanyId: string; currencyCode: string;
  currentRevisionNumber: number; acceptedRevisionNumber?: number|null; validUntil?: string|null; responsibleUserId?: string|null;
  sourceFormSubmissionId?: string|null; archived: boolean; version: number; revisions: EstimateRevision[];
};
export type InvoiceStatus = 'DRAFT'|'ISSUED'|'PARTIALLY_PAID'|'PAID'|'VOID'|'CANCELLED';
export type Invoice = {
  id: string; workspaceId: string; invoiceNumber?: string|null; semanticStatus: InvoiceStatus; sourceEstimateId?: string|null;
  sourceEstimateRevisionId?: string|null; dealId?: string|null; customerContactId?: string|null; customerCompanyId?: string|null;
  sellerCompanyId: string; buyerSnapshotId?: string|null; sellerSnapshotId?: string|null; currencyCode: string; issueDate?: string|null;
  dueDate?: string|null; subtotal: string; discountTotal: string; taxTotal: string; grandTotal: string; paidAmount: string;
  outstandingBalance: string; lines: MoneyLine[]; responsibleUserId?: string|null; voidReason?: string|null; issuedAt?: Date|null;
  voidedAt?: Date|null; archived: boolean; version: number;
};
export type Payment = {
  id: string; workspaceId: string; customerContactId?: string|null; customerCompanyId?: string|null; currencyCode: string;
  amount: string; settlementStatus: 'PENDING'|'SUCCEEDED'|'FAILED'|'CANCELLED'; methodType: 'MANUAL'|'PROVIDER';
  providerKey?: string|null; externalReference?: string|null; receivedAt?: Date|null; memo?: string|null; responsibleUserId?: string|null;
};
export type PaymentAllocation = { id:string; workspaceId:string; paymentId:string; invoiceId:string; amount:string; status:'ACTIVE'|'REVERSED'; createdByUserId?:string|null; reversedAt?:Date|null; reversalReason?:string|null };
export type PaymentAttempt = { id:string; workspaceId:string; paymentId:string; providerKey:string; providerTransactionId?:string|null; idempotencyKey?:string|null; status:'CREATED'|'PENDING'|'SUCCEEDED'|'FAILED'|'CANCELLED'; requestedAmount:string; currencyCode:string; merchantId?:string|null; failureCode?:string|null; invoiceIds:string[] };
export type ProviderEvent = { id:string; workspaceId:string; providerKey:string; connectionKey:string; externalEventId:string; eventType:string; receivedAt:Date; processedAt?:Date|null };
export type Refund = { id:string; workspaceId:string; paymentId:string; providerAttemptId?:string|null; amount:string; currencyCode:string; status:'PENDING'|'SUCCEEDED'|'FAILED'|'CANCELLED'; providerRefundId?:string|null; reasonText?:string|null; requestedByUserId?:string|null; requestedAt:Date; settledAt?:Date|null; idempotencyKey?:string|null };
export type InvoiceSequence = { id:string; workspaceId:string; sellerCompanyId?:string|null; prefix:string; nextValue:number; padding?:number };
export type RecurringRule = { id:string; workspaceId:string; name:string; active:boolean; customerContactId?:string|null; customerCompanyId?:string|null; sellerCompanyId:string; currencyCode:string; ianaTimezone:string; startOn:string; endOn?:string|null; nextRunAt:Date; issueMode:'DRAFT_ONLY'|'AUTO_ISSUE_SEND'; recurrence?:{frequency:'DAILY'|'WEEKLY'|'MONTHLY';interval:number}; responsibleUserId?:string|null; template: Record<string,unknown>; version:number };
export type RecurringOccurrence = { id:string; workspaceId:string; ruleId:string; occurrenceKey:string; scheduledFor:Date; invoiceId?:string|null; status:'PENDING'|'CREATED'|'FAILED'|'SKIPPED'; failureCode?:string|null };

export type FormMode = 'SUBMISSION_ONLY'|'CRM_CAPTURE';
export type FormAccessMode = 'PUBLIC'|'AUTHENTICATED'|'RESTRICTED_TOKEN';
export type FormField = { key:string; label:string; type:string; page:number; order:number; required:boolean; multiple?:boolean; hidden?:boolean; validation?:Record<string,unknown>; agreement?:{id:string;version:string}; mapping?:{entityType:string;field:string} };
export type CaptureStep = { key:string; entityType:'LEAD'|'CONTACT'|'COMPANY'|'DEAL'|'ESTIMATE'; duplicateStrategy:'ALWAYS_CREATE_NEW'|'MATCH_OR_CREATE'|'USE_EXISTING'|'UPDATE_MATCHED'; mappings:Record<string,string>; assignment?:Record<string,unknown>; config?:Record<string,unknown>; pipelineId?:string; stageId?:string; failOnce?:boolean };
export type FormVersion = { id:string; workspaceId:string; formId:string; versionNumber:number; status:'DRAFT'|'PUBLISHED'|'SUPERSEDED'; fields:FormField[]; rules:Array<Record<string,unknown>>; captureRecipe:CaptureStep[]; createdAt:Date; publishedAt?:Date|null };
export type CrmForm = { id:string; workspaceId:string; name:string; publicKey:string; mode:FormMode; accessMode:FormAccessMode; status:'DRAFT'|'PUBLISHED'|'UNPUBLISHED'|'ARCHIVED'; currentDraftVersionId?:string|null; publishedVersionId?:string|null; successAction:'MESSAGE'|'REDIRECT'; successMessage?:string|null; redirectUrl?:string|null; restrictedTokenHash?:string|null; restrictedTokenExpiresAt?:Date|null; spamPolicy?:{adapterKey:string;config:Record<string,unknown>}|null; responsibleUserId?:string|null };
export type FormSubmission = { id:string; workspaceId:string; formId:string; formVersionId:string; submissionState:'DRAFT'|'SUBMITTED'; processingStatus:'NOT_REQUIRED'|'PENDING'|'PROCESSING'|'SUCCEEDED'|'PARTIALLY_FAILED'|'FAILED'; values:Record<string,unknown>; consentEvidence:Array<Record<string,unknown>>; attribution?:Record<string,string>; fileIds:string[]; idempotencyKey?:string|null; requestHash?:string|null; submittedAt?:Date|null; resumeTokenHash?:string|null; resumeExpiresAt?:Date|null; stepOutcomes:Record<string,{status:string;error?:string}> };
export type FormEntityBinding = { id:string; workspaceId:string; submissionId:string; recipeStepKey:string; entityType:string; entityId:string; action:'CREATED'|'MATCHED'|'UPDATED'|'MERGED'; createdAt:Date };
export type FormUpload = { id:string; workspaceId:string; formId:string; fieldKey?:string|null; status:'UPLOADING'|'QUARANTINED'|'CLEAN'|'INFECTED'|'FAILED'; mimeType:string; size:number; ownerTokenHash:string; expiresAt:Date; storageReference?:string|null };

export type Channel = { id:string; workspaceId:string; name:string; type:string; active:boolean; serviceUserId?:string|null; unknownCustomerPolicy:'CREATE_CONTACT'|'CREATE_LEAD'|'KEEP_UNLINKED'|'REQUIRE_AGENT_CONFIRMATION' };
export type ChannelConnection = { id:string; workspaceId:string; channelId:string; providerKey:string; channelType:string; status:'DISCONNECTED'|'CONNECTING'|'ACTIVE'|'DEGRADED'|'DISABLED'|'ERROR'; externalAccountId?:string|null; capabilities:string[]; secretReference?:string|null };
export type QueueRoutingRule = { id:string; priority:number; field:'priority'|'channelId'|'contactId'|'companyId'; operator:'EQ'|'IN'; value:string|string[]; targetUserId?:string|null };
export type ContactQueue = { id:string; workspaceId:string; name:string; channelId?:string|null; routingMode:'FIXED'|'ROUND_ROBIN'|'LEAST_LOADED'|'BROADCAST'|'CUSTOMER_OWNER'|'RULE_BASED'; fixedUserId?:string|null; maxConcurrentPerAgent?:number|null; reopenWindowMinutes:number; active:boolean; roundRobinCursor:number; workCalendar?:WorkCalendar; slaPolicyId?:string|null; departmentIds?:string[]; routingRules?:QueueRoutingRule[] };
export type QueueMember = { id:string; workspaceId:string; queueId:string; userId:string; order:number; capacityOverride?:number|null; active:boolean; available:boolean; absent:boolean };
export type WorkCalendar = { timezone:string; workingDays:number[]; startHour:number; endHour:number; holidays:string[] };
export type SlaPolicy = { id:string; workspaceId:string; name:string; version:number; active:boolean; firstResponseMinutes:number; nextResponseMinutes:number; resolutionMinutes:number; pauseOnWaitingCustomer:boolean; transferBehavior:'CONTINUE'|'RESET' };
export type CustomerIdentity = { id:string; workspaceId:string; connectionId:string; kind:string; normalizedValue:string; contactId?:string|null; companyId?:string|null; ambiguous:boolean };
export type Conversation = { id:string; workspaceId:string; channelId:string; queueId?:string|null; status:'OPEN'|'WAITING_AGENT'|'WAITING_CUSTOMER'|'CLOSED'; customerIdentityId:string; primaryContactId?:string|null; primaryCompanyId?:string|null; primaryDealId?:string|null; currentAssigneeUserId?:string|null; openedAt:Date; closedAt?:Date|null; lastCustomerMessageAt?:Date|null; lastAgentMessageAt?:Date|null; reopenUntil?:Date|null; priority:'NORMAL'|'HIGH'|'URGENT'; version:number };
export type ConversationMessage = { id:string; workspaceId:string; conversationId:string; connectionId?:string|null; direction:'INBOUND'|'OUTBOUND'|'SYSTEM'; senderType:'CUSTOMER'|'USER'|'SYSTEM'|'PROVIDER'; senderUserId?:string|null; externalMessageId?:string|null; clientMessageId?:string|null; messageType:string; body:string; occurredAt:Date; deliveryStatus?:'QUEUED'|'SENT'|'DELIVERED'|'READ'|'FAILED'|null };
export type ConversationAssignment = { id:string; workspaceId:string; conversationId:string; userId?:string|null; queueId?:string|null; assignedAt:Date; endedAt?:Date|null; actorUserId?:string|null };
export type ConversationTransfer = { id:string; workspaceId:string; conversationId:string; fromUserId?:string|null; toUserId?:string|null; fromQueueId?:string|null; toQueueId?:string|null; actorUserId:string; reason?:string|null; createdAt:Date };
export type ChannelProviderEvent = { id:string; workspaceId:string; connectionId:string; externalEventId:string; externalMessageId?:string|null; createdAt:Date };
export type SlaTimer = { id:string; workspaceId:string; conversationId:string; type:'FIRST_RESPONSE'|'NEXT_RESPONSE'|'RESOLUTION'; policyVersion:number; startedAt:Date; dueAt:Date; pausedAt?:Date|null; pausedMs:number; remainingBusinessMinutes?:number|null; satisfiedAt?:Date|null; breachedAt?:Date|null; escalationEmitted:boolean; history:Array<Record<string,unknown>> };
export type BackgroundJob = { id:string; workspaceId:string; type:string; key:string; status:'PENDING'|'RUNNING'|'SUCCEEDED'|'FAILED'|'DEAD_LETTER'; attempts:number; maxAttempts:number; runAt:Date; payload:Record<string,unknown>; lastError?:string|null; failureClass?:'TRANSIENT'|'PERMANENT'|null; failedAt?:Date|null };
