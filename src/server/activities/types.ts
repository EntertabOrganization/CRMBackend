export const ACTIVITY_STATUSES = ['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];
export const ACTIVITY_PRIORITIES = ['LOW', 'NORMAL', 'HIGH'] as const;
export type ActivityPriority = (typeof ACTIVITY_PRIORITIES)[number];
export const ACTIVITY_DIRECTIONS = ['INCOMING', 'OUTGOING', 'NOT_APPLICABLE'] as const;
export type ActivityDirection = (typeof ACTIVITY_DIRECTIONS)[number];

/** Entities an Activity can be bound to. Extend by registering more entity types in the field/entity registry. */
export type ActivityBindingEntityType = 'LEAD' | 'CONTACT' | 'COMPANY' | 'DEAL';

export type ActivityType = {
  id: string;
  workspaceId: string;
  code: string;
  name: string;
  icon?: string | null;
  colorToken?: string | null;
  defaultDurationMinutes?: number | null;
  defaultPriority: ActivityPriority;
  defaultDirection: ActivityDirection;
  enabled: boolean;
  /** Set for provider/app-defined types so one integration cannot impersonate another. */
  ownerApp?: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type Activity = {
  id: string;
  workspaceId: string;
  typeCode: string;
  customActivityTypeId?: string | null;
  subject: string;
  description?: string | null;
  status: ActivityStatus;
  priority: ActivityPriority;
  direction: ActivityDirection;
  createdByUserId?: string | null;
  responsibleUserId?: string | null;
  startAt?: Date | null;
  endAt?: Date | null;
  deadline?: Date | null;
  /** Bumped whenever the deadline changes so each deadline occurrence can raise its own overdue event. */
  deadlineVersion: number;
  location?: string | null;
  resultText?: string | null;
  completedAt?: Date | null;
  cancelledAt?: Date | null;
  cancellationReason?: string | null;
  reopenedAt?: Date | null;
  adapterKind?: string | null;
  adapterResourceId?: string | null;
  externalOrigin?: string | null;
  externalId?: string | null;
  fileIds: string[];
  version: number;
  isDeleted: boolean;
  deletedAt?: Date | null;
  deletedByUserId?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ActivityBinding = {
  id: string;
  workspaceId: string;
  activityId: string;
  entityType: string;
  entityId: string;
  isPrimary: boolean;
  createdByUserId?: string | null;
  createdAt: Date;
};

export type ActivityParticipantRole = 'PARTICIPANT' | 'WATCHER';

export type ActivityParticipant = {
  id: string;
  workspaceId: string;
  activityId: string;
  userId: string;
  role: ActivityParticipantRole;
  createdAt: Date;
};

export type ActivityCommunicationType = 'PHONE' | 'EMAIL' | 'MESSENGER' | 'OTHER';

export type ActivityCommunication = {
  id: string;
  workspaceId: string;
  activityId: string;
  communicationType: ActivityCommunicationType;
  crmEntityType?: string | null;
  crmEntityId?: string | null;
  normalizedValue: string;
  rawDisplayValue?: string | null;
  label?: string | null;
  isPrimary: boolean;
  createdAt: Date;
};

export type ReminderMode = 'RELATIVE' | 'ABSOLUTE';
export type ReminderRelativeTo = 'START' | 'DEADLINE';
export type ReminderStatus = 'SCHEDULED' | 'SENT' | 'CANCELLED';

export type ActivityReminder = {
  id: string;
  workspaceId: string;
  activityId: string;
  mode: ReminderMode;
  relativeTo?: ReminderRelativeTo | null;
  offsetSeconds?: number | null;
  absoluteAt?: Date | null;
  /** Concrete fire time derived from mode + the Activity's current times. */
  scheduledFor?: Date | null;
  status: ReminderStatus;
  occurrenceKey: string;
  sentAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ActivityReminderRecipient = {
  id: string;
  workspaceId: string;
  reminderId: string;
  userId: string;
};

export type ActivityOverdueOccurrence = {
  id: string;
  workspaceId: string;
  activityId: string;
  deadline: Date;
  deadlineVersion: number;
  emittedAt: Date;
};

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export const TIMELINE_CATEGORIES = [
  'ACTIVITY',
  'COMMUNICATION',
  'CRM_CHANGE',
  'STAGE_CHANGE',
  'DOCUMENT',
  'AUTOMATION',
  'COMMERCIAL',
  'PAYMENT',
  'FORM',
  'COMMENT',
  'SYSTEM',
] as const;
export type TimelineCategory = (typeof TIMELINE_CATEGORIES)[number];

export type TimelineActorType = 'USER' | 'SERVICE' | 'SYSTEM' | 'PROVIDER';

export type TimelineEntry = {
  id: string;
  workspaceId: string;
  entityType: string;
  entityId: string;
  category: TimelineCategory;
  sourceType: string;
  sourceId: string;
  sourceEventId: string;
  projectionKind: string;
  sourceVersion?: number | null;
  occurredAt: Date;
  actorType: TimelineActorType;
  actorUserId?: string | null;
  actorDisplaySnapshot?: string | null;
  summaryCode: string;
  summaryTextSnapshot?: string | null;
  presentationSnapshot: Record<string, unknown>;
  correlationId?: string | null;
  projectionVersion: number;
  createdAt: Date;
};

export type TimelineComment = {
  id: string;
  workspaceId: string;
  entityType: string;
  entityId: string;
  linkedActivityId?: string | null;
  authorUserId: string;
  body: string;
  fileIds: string[];
  isDeleted: boolean;
  deletedAt?: Date | null;
  deletedByUserId?: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type TimelineCommentMention = {
  id: string;
  workspaceId: string;
  commentId: string;
  userId: string;
  createdAt: Date;
};

export const TIMELINE_PROJECTION_VERSION = 1;
