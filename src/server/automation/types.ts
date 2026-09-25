/** Row shapes for Automation Rules & Triggers. They mirror the Prisma models 1:1. */

export type RuleState = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'DISABLED' | 'ARCHIVED';
export type RevisionState = 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
export type JobStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'CANCELLED';
export type ExecutionStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'SUCCEEDED_WITH_ERRORS'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FINAL'
  | 'SKIPPED_CONDITION'
  | 'SKIPPED_STALE'
  | 'CANCELLED';
export type ActionStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';

export const EXECUTION_STATUSES: ExecutionStatus[] = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'SUCCEEDED_WITH_ERRORS',
  'FAILED_RETRYABLE',
  'FAILED_FINAL',
  'SKIPPED_CONDITION',
  'SKIPPED_STALE',
  'CANCELLED',
];

/** Terminal execution states (no further work is scheduled without an explicit human retry). */
export const TERMINAL_EXECUTION_STATUSES: ExecutionStatus[] = [
  'SUCCEEDED',
  'SUCCEEDED_WITH_ERRORS',
  'FAILED_FINAL',
  'SKIPPED_CONDITION',
  'SKIPPED_STALE',
  'CANCELLED',
];

export type TimingMode = 'IMMEDIATE' | 'DELAY' | 'SCHEDULED' | 'RELATIVE_TO_FIELD';

export type TimingConfig =
  | { mode: 'IMMEDIATE' }
  | { mode: 'DELAY'; delayMinutes: number }
  | { mode: 'SCHEDULED'; runAt: string }
  | { mode: 'RELATIVE_TO_FIELD'; field: string; offsetMinutes: number; ifPast?: 'RUN_NOW' | 'SKIP' };

export type IdentityKind = 'SERVICE' | 'INITIATING_USER';

export type ExecutionPolicy = {
  /** Which identity performs the Actions. SERVICE = scoped Automation service identity. */
  identity: IdentityKind;
  /** Automatic retries for retryable failures (1..10). */
  maxAttempts: number;
  /** May authorized users run the published Rule manually against a record? */
  allowManual: boolean;
};

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = { identity: 'SERVICE', maxAttempts: 3, allowManual: true };

export type ConditionNode =
  | { type: 'GROUP'; operator: 'ALL' | 'ANY'; children: ConditionNode[] }
  | {
      type: 'CONDITION';
      /** Whitelisted reference: target.<systemField> | target.customFields.<code> | trigger.payload.<key> | actor.id | now */
      field: string;
      operator: string;
      value?: unknown;
    };

export type AutomationRule = {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  targetType: string;
  priority: number;
  state: RuleState;
  activeRevisionId: string | null;
  draftRevisionId: string | null;
  version: number;
  createdByUserId: string;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AutomationRevision = {
  id: string;
  workspaceId: string;
  ruleId: string;
  revisionNumber: number;
  state: RevisionState;
  triggerCode: string | null;
  triggerConfig: Record<string, unknown>;
  conditionTree: ConditionNode | null;
  conditionsVersion: number;
  timing: TimingConfig;
  executionPolicy: Partial<ExecutionPolicy>;
  configHash: string | null;
  publishedAt: Date | null;
  publishedByUserId: string | null;
  supersededAt: Date | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type AutomationAction = {
  id: string;
  workspaceId: string;
  revisionId: string;
  actionCode: string;
  sortOrder: number;
  name: string | null;
  config: Record<string, unknown>;
  continueOnError: boolean;
  createdAt: Date;
};

/** Immutable event context an execution is evaluated against (never a copy of the whole target record). */
export type TriggerContext = {
  eventId: string;
  eventType: string;
  triggerCode: string;
  workspaceId: string;
  targetType: string;
  targetId: string;
  occurredAt: string;
  actor: { type: 'USER' | 'SERVICE' | 'SYSTEM'; id?: string };
  correlationId: string;
  causationId?: string;
  depth: number;
  changedFields?: Record<string, { before: unknown; after: unknown }>;
  payload?: Record<string, unknown>;
  /** Stage triggers: the stage the record entered / left. */
  stage?: { pipelineId: string | null; stageId: string | null; fromPipelineId?: string | null; fromStageId?: string | null };
};

export type AutomationJob = {
  id: string;
  workspaceId: string;
  ruleId: string;
  ruleRevisionId: string;
  targetType: string;
  targetId: string;
  sourceEventId: string;
  triggerCode: string;
  timingMode: TimingMode;
  scheduledAt: Date;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  idempotencyKey: string;
  correlationId: string;
  causationId: string | null;
  depth: number;
  triggerContext: TriggerContext;
  initiatorType: 'USER' | 'SERVICE' | 'SYSTEM' | null;
  initiatorId: string | null;
  identityKind: IdentityKind;
  executionId: string | null;
  leaseExpiresAt: Date | null;
  claimedBy: string | null;
  lastErrorCode: string | null;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AutomationExecution = {
  id: string;
  workspaceId: string;
  ruleId: string;
  ruleRevisionId: string;
  ruleName: string;
  revisionNumber: number;
  jobId: string | null;
  targetType: string;
  targetId: string;
  targetTitle: string | null;
  sourceEventId: string;
  triggerCode: string;
  timingMode: TimingMode;
  status: ExecutionStatus;
  initiatorType: 'USER' | 'SERVICE' | 'SYSTEM' | null;
  initiatorId: string | null;
  identityKind: IdentityKind;
  identityUserId: string | null;
  correlationId: string;
  causationId: string | null;
  depth: number;
  conditionOutcome: Record<string, unknown> | null;
  skipReason: string | null;
  errorCode: string | null;
  errorSummary: string | null;
  retryCount: number;
  isManual: boolean;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ActionAttempt = { attempt: number; startedAt: string; endedAt?: string; outcome?: 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED'; errorCode?: string };

export type AutomationActionExecution = {
  id: string;
  workspaceId: string;
  executionId: string;
  actionId: string;
  actionCode: string;
  actionOrder: number;
  status: ActionStatus;
  attemptCount: number;
  idempotencyKey: string;
  continueOnError: boolean;
  retryable: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  result: Record<string, unknown> | null;
  attempts: ActionAttempt[];
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AutomationLog = {
  id: string;
  workspaceId: string;
  ruleId: string | null;
  executionId: string | null;
  jobId: string | null;
  level: 'INFO' | 'WARN' | 'ERROR';
  code: string;
  message: string;
  data: Record<string, unknown> | null;
  correlationId: string | null;
  createdAt: Date;
};

export type ExtensionKind = 'TRIGGER' | 'ACTION';

export type ExtensionHandler =
  | { kind: 'HTTP'; url: string; method?: 'POST' | 'PUT' | 'PATCH'; secretRef?: string | null; timeoutMs?: number }
  | { kind: 'REGISTERED'; handlerCode: string };

export type AutomationExtension = {
  id: string;
  workspaceId: string;
  installationId: string;
  kind: ExtensionKind;
  code: string;
  name: string;
  description: string | null;
  schemaVersion: number;
  targetTypes: string[];
  configSchema: SchemaNode | null;
  payloadSchema: SchemaNode | null;
  handler: ExtensionHandler | null;
  permissions: string[];
  enabled: boolean;
  createdByUserId: string;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AutomationCredential = {
  id: string;
  workspaceId: string;
  installationId: string;
  name: string;
  secretHash: string;
  triggerCodes: string[];
  isActive: boolean;
  lastUsedAt: Date | null;
  createdByUserId: string;
  createdAt: Date;
  revokedAt: Date | null;
};

/** Restricted JSON-Schema subset used for extension configuration/payload (no executable content, bounded depth). */
export type SchemaNode = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: Array<string | number>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  maxItems?: number;
  /** Sensitive values must be references, never plaintext (rejected for keys that look like credentials). */
  format?: 'uuid' | 'date-time' | 'email' | 'uri' | 'secret-ref';
};

export const AUTOMATION_PERMISSIONS = {
  read: 'automation.read',
  manage: 'automation.manage',
  publish: 'automation.publish',
  execute: 'automation.execute',
  retry: 'automation.retry',
  viewLogs: 'automation.view_logs',
  manageExtensions: 'automation.manage_extensions',
} as const;
