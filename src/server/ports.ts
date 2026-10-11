import type { ActorContext } from './access-service';
import type { ReferenceCheck } from './fields/field-types';

/**
 * Contracts to the owning Files, Calendar, Tasks and Communication modules. Custom Fields, Activities and Timeline use
 * these ports rather than accessing owning-module tables or reimplementing their behavior.
 */

export interface FilePort {
  /** Is the file present, usable (not quarantined) and accessible to the actor for attaching? */
  check(workspaceId: string, actor: ActorContext, fileId: string): ReferenceCheck;
}

/** Fail-closed adapter for configurations without a Files provider. The application normally wires the real Files authority. */
export class UnconfiguredFilePort implements FilePort {
  check(): ReferenceCheck {
    return 'UNAVAILABLE';
  }
}

/** Deterministic fake used by tests: files must be registered per workspace first. */
export class InMemoryFilePort implements FilePort {
  private readonly files = new Map<string, { workspaceId: string; blockedFor: Set<string> }>();

  register(workspaceId: string, fileId: string, blockedForUserIds: string[] = []) {
    this.files.set(fileId.toLowerCase(), { workspaceId, blockedFor: new Set(blockedForUserIds) });
  }

  check(workspaceId: string, actor: ActorContext, fileId: string): ReferenceCheck {
    const file = this.files.get(fileId.toLowerCase());
    if (!file || file.workspaceId !== workspaceId) return 'MISSING';
    if (file.blockedFor.has(actor.user.id)) return 'FORBIDDEN';
    return 'OK';
  }
}

export type CalendarMeetingInput = {
  workspaceId: string;
  actorUserId: string;
  activityId: string;
  subject: string;
  startAt: Date | null;
  endAt: Date | null;
  location: string | null;
  participantUserIds: string[];
  idempotencyKey: string;
};

export type CalendarMeetingResult = {
  eventId: string;
  startAt: Date | null;
  endAt: Date | null;
  location: string | null;
};

/** Calendar owns meeting scheduling; CRM only reflects the confirmed outcome. */
export interface CalendarPort {
  createMeeting(input: CalendarMeetingInput): Promise<CalendarMeetingResult> | CalendarMeetingResult;
  updateMeeting(eventId: string, input: CalendarMeetingInput): Promise<CalendarMeetingResult> | CalendarMeetingResult;
  cancelMeeting(eventId: string, input: { workspaceId: string; actorUserId: string; idempotencyKey: string }): Promise<void> | void;
  completeMeeting(eventId: string, input: { workspaceId: string; actorUserId: string; idempotencyKey: string }): Promise<void> | void;
}

export type TaskInput = {
  workspaceId: string;
  actorUserId: string;
  activityId: string;
  subject: string;
  description: string | null;
  deadline: Date | null;
  responsibleUserId: string | null;
  idempotencyKey: string;
};

/** Tasks owns task lifecycle (status, recurrence, dependencies); CRM delegates and mirrors. */
export interface TaskPort {
  createTask(input: TaskInput): Promise<{ taskId: string }> | { taskId: string };
  updateTask(taskId: string, input: TaskInput): Promise<void> | void;
  completeTask(taskId: string, input: { workspaceId: string; actorUserId: string; idempotencyKey: string }): Promise<void> | void;
  cancelTask(taskId: string, input: { workspaceId: string; actorUserId: string; idempotencyKey: string }): Promise<void> | void;
  reopenTask(taskId: string, input: { workspaceId: string; actorUserId: string; idempotencyKey: string }): Promise<void> | void;
}

export class AdapterUnavailableError extends Error {}

// ---- Automation adapters --------------------------------------------------------------------------------------------
// Notifications, Communication, Documents and the secret store are owned by other modules. Automation talks to them only
// through these ports; until a module is wired, the matching Action stays unavailable instead of being faked.

export type PortResult = { reference?: string | null };

export interface NotificationPort {
  /** Optional owning email provider for external booking guests; absence remains a retryable failure. */
  notifyGuests?(input: { workspaceId: string; recipientEmails: string[]; title: string; message: string;
    link?: string | null; idempotencyKey: string; notificationType: string; signal?: AbortSignal }): Promise<PortResult> | PortResult;
  /** The owning Notifications service evaluates live channel permissions and user preferences. */
  canDeliver?(input: { workspaceId: string; recipientUserId: string; channel: 'IN_APP' | 'EMAIL' | 'PUSH'; notificationType: string }): Promise<boolean> | boolean;
  notifyUsers(input: {
    workspaceId: string;
    actorUserId: string;
    recipientUserIds: string[];
    title: string;
    message: string;
    link?: string | null;
    idempotencyKey: string;
    channel?: 'IN_APP' | 'EMAIL' | 'PUSH';
    notificationType?: string;
    signal?: AbortSignal;
  }): Promise<PortResult> | PortResult;
}

export interface CommunicationPort {
  send(input: {
    workspaceId: string;
    actorUserId: string;
    channel: 'EMAIL' | 'MESSAGE';
    to: string[];
    subject: string | null;
    body: string;
    target: { type: string; id: string };
    idempotencyKey: string;
  }): Promise<PortResult> | PortResult;
}

export interface DocumentPort {
  generate(input: {
    workspaceId: string;
    actorUserId: string;
    templateId: string;
    name: string | null;
    target: { type: string; id: string };
    idempotencyKey: string;
  }): Promise<PortResult & { fileId?: string | null }> | (PortResult & { fileId?: string | null });
}

/** Secure credential store. Rules hold only a reference name; the value is resolved at call time and never persisted or logged. */
export interface SecretPort {
  resolve(workspaceId: string, ref: string): string | null;
}

export class UnconfiguredSecretPort implements SecretPort {
  resolve(): string | null {
    return null;
  }
}

export class InMemorySecretPort implements SecretPort {
  private readonly secrets = new Map<string, string>();

  set(workspaceId: string, ref: string, value: string) {
    this.secrets.set(`${workspaceId}:${ref}`, value);
  }

  resolve(workspaceId: string, ref: string) {
    return this.secrets.get(`${workspaceId}:${ref}`) ?? null;
  }
}

/** Test doubles that record what Automation asked the owning modules to do. */
export class RecordingNotificationPort implements NotificationPort {
  readonly sent: Array<Parameters<NotificationPort['notifyUsers']>[0]> = [];
  private readonly denied = new Set<string>();
  setChannelAllowed(workspaceId: string, userId: string, channel: 'IN_APP' | 'EMAIL' | 'PUSH', allowed: boolean) {
    const key = `${workspaceId}:${userId}:${channel}`;
    if (allowed) this.denied.delete(key); else this.denied.add(key);
  }
  canDeliver(input: Parameters<NonNullable<NotificationPort['canDeliver']>>[0]) {
    return !this.denied.has(`${input.workspaceId}:${input.recipientUserId}:${input.channel}`);
  }
  notifyUsers(input: Parameters<NotificationPort['notifyUsers']>[0]) {
    if (!this.sent.some((item) => item.idempotencyKey === input.idempotencyKey)) this.sent.push(input);
    return { reference: input.idempotencyKey };
  }
}

export class RecordingCommunicationPort implements CommunicationPort {
  readonly sent: Array<Parameters<CommunicationPort['send']>[0]> = [];
  send(input: Parameters<CommunicationPort['send']>[0]) {
    if (!this.sent.some((item) => item.idempotencyKey === input.idempotencyKey)) this.sent.push(input);
    return { reference: input.idempotencyKey };
  }
}

export class RecordingDocumentPort implements DocumentPort {
  readonly generated: Array<Parameters<DocumentPort['generate']>[0]> = [];
  generate(input: Parameters<DocumentPort['generate']>[0]) {
    if (!this.generated.some((item) => item.idempotencyKey === input.idempotencyKey)) this.generated.push(input);
    return { reference: input.idempotencyKey, fileId: null };
  }
}
