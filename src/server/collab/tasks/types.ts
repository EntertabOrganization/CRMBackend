/**
 * Tasks & Projects domain rows. Field names mirror the Prisma models one-to-one because the persistence layer upserts
 * rows verbatim. Date-only columns (project start/end, recurrence start/end) are carried as `YYYY-MM-DD` strings so a
 * timezone conversion can never shift the calendar day; the persistence layer converts them at the database boundary.
 */

export type ProjectType = 'PROJECT' | 'WORKGROUP';
export type ProjectStatus = 'PLANNED' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED' | 'ARCHIVED';
export type ProjectVisibility = 'PRIVATE' | 'WORKSPACE_VISIBLE' | 'OPEN' | 'INVITE_ONLY';
export type ProjectRole = 'OWNER' | 'MODERATOR' | 'MEMBER';
export type ProjectMemberStatus = 'ACTIVE' | 'INVITED' | 'REMOVED';
export type ProjectToolType = 'TASKS' | 'KANBAN' | 'CALENDAR' | 'DRIVE' | 'FEED' | 'CHAT' | 'REPORTS' | 'KNOWLEDGE';
export type TaskStatus = 'PENDING' | 'IN_PROGRESS' | 'REVIEW' | 'COMPLETED' | 'DEFERRED' | 'CANCELLED';
export type TaskPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type TaskMemberRole = 'PARTICIPANT' | 'OBSERVER';
export type SubtaskCompletionPolicy = 'IGNORE' | 'WARN' | 'REQUIRE_ALL';
export type TaskReviewDecision = 'PENDING' | 'APPROVED' | 'RETURNED';
export type TaskResultType = 'TEXT' | 'FILE' | 'LINK';
export type TaskDependencyType = 'FINISH_START' | 'START_START' | 'FINISH_FINISH' | 'START_FINISH';
export type RecurrenceFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export const PROJECT_TYPES: ProjectType[] = ['PROJECT', 'WORKGROUP'];
export const PROJECT_STATUSES: ProjectStatus[] = ['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED', 'ARCHIVED'];
export const PROJECT_VISIBILITIES: ProjectVisibility[] = ['PRIVATE', 'WORKSPACE_VISIBLE', 'OPEN', 'INVITE_ONLY'];
export const PROJECT_ROLES: ProjectRole[] = ['OWNER', 'MODERATOR', 'MEMBER'];
export const PROJECT_TOOL_TYPES: ProjectToolType[] = ['TASKS', 'KANBAN', 'CALENDAR', 'DRIVE', 'FEED', 'CHAT', 'REPORTS', 'KNOWLEDGE'];
export const TASK_STATUSES: TaskStatus[] = ['PENDING', 'IN_PROGRESS', 'REVIEW', 'COMPLETED', 'DEFERRED', 'CANCELLED'];
export const TASK_PRIORITIES: TaskPriority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
export const SUBTASK_POLICIES: SubtaskCompletionPolicy[] = ['IGNORE', 'WARN', 'REQUIRE_ALL'];
export const TASK_RESULT_TYPES: TaskResultType[] = ['TEXT', 'FILE', 'LINK'];
export const DEPENDENCY_TYPES: TaskDependencyType[] = ['FINISH_START', 'START_START', 'FINISH_FINISH', 'START_FINISH'];
export const RECURRENCE_FREQUENCIES: RecurrenceFrequency[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

export type Project = {
  id: string;
  workspaceId: string;
  name: string;
  code: string | null;
  description: string | null;
  projectType: ProjectType;
  status: ProjectStatus;
  statusBeforeArchive: ProjectStatus | null;
  ownerUserId: string;
  startDate: string | null;
  endDate: string | null;
  visibility: ProjectVisibility;
  createdByUserId: string;
  version: number;
  isDeleted: boolean;
  deletedAt: Date | null;
  deletedByUserId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ProjectMember = {
  id: string;
  workspaceId: string;
  projectId: string;
  userId: string;
  memberRole: ProjectRole;
  status: ProjectMemberStatus;
  joinedAt: Date | null;
  leftAt: Date | null;
  invitedByUserId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ProjectTool = {
  id: string;
  workspaceId: string;
  projectId: string;
  toolType: ProjectToolType;
  isEnabled: boolean;
  configurationJson: Record<string, unknown>;
  linkedResourceType: string | null;
  linkedResourceId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ProjectStage = {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  code: string;
  sortOrder: number;
  isDefault: boolean;
  isTerminalVisualStage: boolean;
  version: number;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type ProjectStageHistory = {
  id: string;
  workspaceId: string;
  taskId: string;
  projectId: string;
  oldStageId: string | null;
  newStageId: string;
  movedByUserId: string;
  movedAt: Date;
};

export type Task = {
  id: string;
  workspaceId: string;
  projectId: string | null;
  projectStageId: string | null;
  parentTaskId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  createdByUserId: string;
  responsibleUserId: string;
  startAt: Date | null;
  deadlineAt: Date | null;
  plannedDurationSeconds: number | null;
  progressPercent: number;
  requiresResult: boolean;
  completionControl: boolean;
  subtaskCompletionPolicy: SubtaskCompletionPolicy;
  isTimeTrackingEnabled: boolean;
  templateId: string | null;
  recurrenceInstanceId: string | null;
  overdueNotifiedAt: Date | null;
  version: number;
  isDeleted: boolean;
  deletedAt: Date | null;
  deletedByUserId: string | null;
  completedAt: Date | null;
  completedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TaskMember = {
  id: string;
  workspaceId: string;
  taskId: string;
  userId: string;
  role: TaskMemberRole;
  addedByUserId: string;
  createdAt: Date;
};

export type TaskCompletionReview = {
  id: string;
  workspaceId: string;
  taskId: string;
  submittedByUserId: string;
  submittedAt: Date;
  reviewerUserId: string | null;
  decision: TaskReviewDecision;
  comment: string | null;
  decidedAt: Date | null;
};

export type TaskResult = {
  id: string;
  workspaceId: string;
  taskId: string;
  resultType: TaskResultType;
  textValue: string | null;
  fileId: string | null;
  url: string | null;
  submittedByUserId: string;
  createdAt: Date;
};

export type TaskDeadlineHistory = {
  id: string;
  workspaceId: string;
  taskId: string;
  oldDeadlineAt: Date | null;
  newDeadlineAt: Date | null;
  changedByUserId: string;
  reason: string | null;
  changedAt: Date;
};

export type TaskHistory = {
  id: string;
  workspaceId: string;
  taskId: string;
  action: string;
  field: string | null;
  oldValue: unknown;
  newValue: unknown;
  actorUserId: string | null;
  occurredAt: Date;
};

export type TaskCrmBinding = {
  id: string;
  workspaceId: string;
  taskId: string;
  entityType: string;
  entityId: string;
  createdByUserId: string;
  createdAt: Date;
};

export type TaskPlannerPosition = {
  id: string;
  workspaceId: string;
  userId: string;
  taskId: string;
  plannerColumn: string;
  sortOrder: number;
  updatedAt: Date;
};

export type TaskChecklist = {
  id: string;
  workspaceId: string;
  taskId: string;
  name: string;
  sortOrder: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type TaskChecklistItem = {
  id: string;
  workspaceId: string;
  checklistId: string;
  taskId: string;
  parentItemId: string | null;
  title: string;
  assignedUserId: string | null;
  isCompleted: boolean;
  completedByUserId: string | null;
  completedAt: Date | null;
  sortOrder: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type TaskDependency = {
  id: string;
  workspaceId: string;
  predecessorTaskId: string;
  successorTaskId: string;
  type: TaskDependencyType;
  lagSeconds: number;
  createdByUserId: string;
  createdAt: Date;
};

export type TaskTimeEntry = {
  id: string;
  workspaceId: string;
  taskId: string;
  userId: string;
  startedAt: Date;
  endedAt: Date | null;
  durationSeconds: number;
  source: 'MANUAL' | 'TIMER';
  note: string | null;
  status: 'ACTIVE' | 'COMPLETED';
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type TaskTemplate = {
  id: string;
  workspaceId: string;
  scopeType: 'WORKSPACE' | 'PERSONAL' | 'PROJECT';
  scopeId: string | null;
  name: string;
  titleTemplate: string;
  descriptionTemplate: string | null;
  projectId: string | null;
  defaultResponsibleUserId: string | null;
  priority: TaskPriority;
  deadlineOffsetSeconds: number | null;
  plannedDurationSeconds: number | null;
  isTimeTrackingEnabled: boolean;
  completionControl: boolean;
  requiresResult: boolean;
  subtaskCompletionPolicy: SubtaskCompletionPolicy;
  fileIds: string[];
  isActive: boolean;
  isDeleted: boolean;
  createdByUserId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type TaskTemplateMember = {
  id: string;
  workspaceId: string;
  templateId: string;
  userId: string;
  role: TaskMemberRole;
};

export type TaskTemplateChecklistItem = {
  id: string;
  workspaceId: string;
  templateId: string;
  checklistName: string;
  parentItemId: string | null;
  title: string;
  sortOrder: number;
};

export type TaskTemplateSubtask = {
  id: string;
  workspaceId: string;
  templateId: string;
  childTemplateId: string;
  sortOrder: number;
};

export type TaskRecurrenceRule = {
  id: string;
  workspaceId: string;
  templateId: string;
  frequency: RecurrenceFrequency;
  intervalValue: number;
  daysOfWeek: number[];
  dayOfMonth: number | null;
  startDate: string;
  endDate: string | null;
  maxOccurrences: number | null;
  creationLocalTime: string;
  timezone: string;
  nextRunAt: Date | null;
  occurrenceCount: number;
  isActive: boolean;
  isDeleted: boolean;
  lastErrorCode: string | null;
  lastErrorAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type TaskRecurrenceInstance = {
  id: string;
  workspaceId: string;
  recurrenceRuleId: string;
  templateId: string;
  taskId: string | null;
  scheduledFor: Date;
  status: 'CREATED' | 'FAILED';
  attempts: number;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};
