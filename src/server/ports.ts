import type { ActorContext } from './access-service';
import type { ReferenceCheck } from './fields/field-types';

/**
 * Narrow contracts to modules that are owned elsewhere (Files, Calendar, Tasks, Communication). These modules are not
 * part of this codebase yet, so the Custom Fields / Activities / Timeline modules depend on ports, never on tables of
 * another module, and never re-implement the specialist behaviour.
 */

export interface FilePort {
  /** Is the file present, usable (not quarantined) and accessible to the actor for attaching? */
  check(workspaceId: string, actor: ActorContext, fileId: string): ReferenceCheck;
}

/** Default until the shared Files/Documents module is wired: refuses references instead of trusting unknown ids. */
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
