import type { ActorContext, AccessService } from '../access-service';
import { AuditService } from '../audit-service';
import type { User } from '../domain';
import { AppError, badRequest, conflict, fieldValidationFailed, forbidden } from '../errors';
import { emitDomainEvent } from '../events';
import type { FieldEngine } from '../fields/field-engine';
import type { RealtimeHub } from '../realtime';
import type { InMemoryStore } from '../store';
import { ActivityAccessPolicy } from './activity-access';
import {
  MAX_BINDINGS,
  MAX_BULK,
  MAX_COMMUNICATIONS,
  MAX_DESCRIPTION,
  MAX_FILES,
  MAX_LOCATION,
  MAX_PARTICIPANTS,
  MAX_REMINDERS,
  MAX_RESULT,
  MAX_SUBJECT,
  decodeCursor,
  encodeCursor,
  fingerprint,
  isOpenStatus,
  normalizeCommunicationValue,
  parseInstant,
  priorityRank,
  requireString,
  resolvedDeadline,
  timeInvalid,
} from './activity-helpers';
import type { ActivityTypeDescriptor, ActivityTypeRegistry } from './activity-types';
import { ActivityAdapterRegistry } from './adapters';
import type {
  Activity,
  ActivityBinding,
  ActivityCommunication,
  ActivityCommunicationType,
  ActivityDirection,
  ActivityParticipant,
  ActivityPriority,
  ActivityReminder,
  ActivityStatus,
} from './types';
import { ACTIVITY_DIRECTIONS, ACTIVITY_PRIORITIES } from './types';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const REMINDER_OFFSET_LIMIT = 30 * 24 * 60 * 60;
const COMMUNICATION_TYPES: ActivityCommunicationType[] = ['PHONE', 'EMAIL', 'MESSENGER', 'OTHER'];

type Json = Record<string, unknown>;
type CommandName = 'start' | 'complete' | 'cancel' | 'reopen';

const TRANSITIONS: Record<CommandName, { from: ActivityStatus[]; to: ActivityStatus }[]> = {
  start: [{ from: ['PLANNED'], to: 'IN_PROGRESS' }],
  complete: [{ from: ['PLANNED', 'IN_PROGRESS'], to: 'COMPLETED' }],
  cancel: [{ from: ['PLANNED', 'IN_PROGRESS'], to: 'CANCELLED' }],
  reopen: [
    { from: ['COMPLETED'], to: 'IN_PROGRESS' },
    { from: ['CANCELLED'], to: 'PLANNED' },
  ],
};

const COMMAND_EVENT: Record<CommandName, string> = {
  start: 'ACTIVITY_UPDATED',
  complete: 'ACTIVITY_COMPLETED',
  cancel: 'ACTIVITY_CANCELLED',
  reopen: 'ACTIVITY_REOPENED',
};

export type ActivityDto = ReturnType<ActivityService['buildDto']>;

export type ProviderCommunicationInput = {
  origin: string;
  externalId: string;
  typeCode: 'CALL' | 'EMAIL' | 'MESSAGE';
  direction: ActivityDirection;
  subject: string;
  occurredAt: Date;
  endAt?: Date | null;
  responsibleUserId: string;
  resultText?: string | null;
  bindings?: Array<{ entityType: string; entityId: string }>;
  communications?: Array<{ type: ActivityCommunicationType; value: string; crmEntityType?: string; crmEntityId?: string; label?: string }>;
  planned?: boolean;
};

/**
 * CRM-facing Activity domain. It never owns Calendar/Tasks/Communication/Files truth: specialist behaviour is delegated
 * through ports, and Timeline is projected afterwards from the outbox events written here.
 */
export class ActivityService {
  readonly policy: ActivityAccessPolicy;

  constructor(
    private readonly store: InMemoryStore,
    private readonly access: AccessService,
    private readonly types: ActivityTypeRegistry,
    private readonly fields: FieldEngine,
    private readonly adapters: ActivityAdapterRegistry,
    private readonly realtime: RealtimeHub,
    private readonly files: () => { check(workspaceId: string, actor: ActorContext, fileId: string): 'OK' | 'MISSING' | 'FORBIDDEN' | 'UNAVAILABLE' },
  ) {
    this.policy = new ActivityAccessPolicy(store, access);
  }

  private get state() {
    return this.store.state;
  }

  private actorOf(user: User, workspaceId: string) {
    return this.access.actor(user, workspaceId);
  }

  private audit(workspaceId: string, actorUserId: string | null, action: string, activityId: string, before: unknown, after: unknown, metadata?: unknown) {
    new AuditService(this.store).write({ workspaceId, actorUserId, action, entityType: 'CrmActivity', entityId: activityId, beforeData: before, afterData: after, metadata });
  }

  private activity(workspaceId: string, activityId: string): Activity {
    const activity = this.state.crmActivities.find((item) => item.id === activityId && item.workspaceId === workspaceId);
    if (!activity) throw new AppError('ACTIVITY_NOT_FOUND', 'Activity was not found.', 404);
    return activity;
  }

  /** Loads an Activity the actor may read; foreign, deleted-by-default and unauthorized ones are all "not found". */
  private readable(actor: ActorContext, activityId: string, includeDeleted = false): Activity {
    const activity = this.activity(actor.workspaceId, activityId);
    const deletedVisible = includeDeleted && this.policy.scopeCovers(actor, 'activity.delete', activity);
    if ((activity.isDeleted && !deletedVisible) || !this.policy.canRead(actor, activity)) {
      throw new AppError('ACTIVITY_NOT_FOUND', 'Activity was not found.', 404);
    }
    return activity;
  }

  // ---- idempotency ------------------------------------------------------------------------------------------------

  private replayOrRun<T>(workspaceId: string, actorId: string, operation: string, key: string | undefined, request: unknown, run: () => T): { replay: boolean; value: T | { activityId: string } } {
    if (!key) return { replay: false, value: run() };
    const hash = fingerprint(request);
    const existing = this.state.idempotencyRecords.find(
      (item) => item.workspaceId === workspaceId && item.actorUserId === actorId && item.operation === operation && item.idempotencyKey === key && item.expiresAt > new Date(),
    );
    if (existing) {
      if (existing.requestHash !== hash) throw new AppError('IDEMPOTENCY_CONFLICT', 'The idempotency key was already used with a different request.', 409);
      return { replay: true, value: existing.response as { activityId: string } };
    }
    return { replay: false, value: run() };
  }

  private remember(workspaceId: string, actorId: string, operation: string, key: string | undefined, request: unknown, activityId: string) {
    if (!key) return;
    this.state.idempotencyRecords.push({
      id: this.store.id(),
      workspaceId,
      actorUserId: actorId,
      operation,
      idempotencyKey: key,
      requestHash: fingerprint(request),
      response: { activityId },
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
      createdAt: new Date(),
    });
  }

  private async idempotent(
    actor: ActorContext,
    operation: string,
    key: string | undefined,
    request: unknown,
    run: () => Promise<string>,
  ): Promise<string> {
    if (key !== undefined && (typeof key !== 'string' || key.length === 0 || key.length > 200)) {
      throw badRequest('IDEMPOTENCY_KEY_INVALID', 'idempotencyKey must be a non-empty string (max 200 characters).');
    }
    const replay = this.replayOrRun(actor.workspaceId, actor.user.id, operation, key, request, () => null as unknown as string);
    if (replay.replay) return (replay.value as { activityId: string }).activityId;
    const activityId = await run();
    this.remember(actor.workspaceId, actor.user.id, operation, key, request, activityId);
    return activityId;
  }

  /**
   * Adapter failures roll the business operation back, so their audit evidence is written AFTER the rollback (inside the
   * operation it would be rolled back with everything else).
   */
  private async guardAdapter<T>(actor: ActorContext, activityId: string, operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AppError && (error.code === 'ACTIVITY_ADAPTER_UNAVAILABLE' || error.code === 'ACTIVITY_ADAPTER_CONFLICT')) {
        this.audit(actor.workspaceId, actor.user.id, 'ACTIVITY.ADAPTER_SYNC_FAILED', activityId, null, { operation, code: error.code });
      }
      throw error;
    }
  }

  // ---- create ---------------------------------------------------------------------------------------------------------

  async create(user: User, workspaceId: string, input: Json, headerKey?: string): Promise<ActivityDto> {
    const actor = this.actorOf(user, workspaceId);
    this.access.requireScope(actor, 'activity.create');
    const key = (input.idempotencyKey as string | undefined) ?? headerKey;
    const id = await this.guardAdapter(actor, 'new', 'create', () => this.idempotent(actor, 'crm.activity.create', key, input, () => this.store.atomic(() => this.createUnsafe(actor, input, key))));
    // The creator may have assigned the Activity to someone else; they still get the (redacted) result of their own action.
    return this.buildDto(actor, this.activity(workspaceId, id));
  }

  private async createUnsafe(actor: ActorContext, input: Json, key: string | undefined): Promise<string> {
    const workspaceId = actor.workspaceId;
    const descriptor = this.types.require(workspaceId, input.typeCode);
    if (!descriptor.enabled) throw new AppError('ACTIVITY_TYPE_DISABLED', 'This Activity type is disabled.', 409);
    if (input.status !== undefined) throw badRequest('ACTIVITY_STATUS_PATCH_FORBIDDEN', 'status cannot be set directly; use the lifecycle commands.');

    const subject = requireString(input.subject, 'subject', MAX_SUBJECT)!;
    const description = requireString(input.description, 'description', MAX_DESCRIPTION, false);
    const location = requireString(input.location, 'location', MAX_LOCATION, false);
    if (location && !descriptor.supportsLocation) throw fieldValidationFailed({ location: [{ code: 'UNSUPPORTED', message: `${descriptor.label} does not support a location.` }] });

    const priority = this.priority(input.priority, descriptor.defaultPriority);
    const direction = this.direction(input.direction, descriptor);
    const times = this.times(descriptor, input, null);
    const responsibleUserId = this.responsible(actor, input.responsibleUserId);
    const bindings = this.parseBindings(actor, input.bindings);
    const participantIds = this.parseParticipants(actor, descriptor, input.participants, responsibleUserId);
    const communications = this.parseCommunications(actor, descriptor, input.communications);
    const fileIds = this.parseFiles(actor, descriptor, input.fileIds);

    const activityId = this.store.id();
    const now = new Date();
    const activity: Activity = {
      id: activityId,
      workspaceId,
      typeCode: descriptor.code,
      customActivityTypeId: descriptor.customActivityTypeId,
      subject,
      description,
      status: 'PLANNED',
      priority,
      direction,
      createdByUserId: actor.user.id,
      responsibleUserId,
      startAt: times.startAt,
      endAt: times.endAt,
      deadline: times.deadline,
      deadlineVersion: 1,
      location,
      resultText: null,
      completedAt: null,
      cancelledAt: null,
      cancellationReason: null,
      reopenedAt: null,
      adapterKind: null,
      adapterResourceId: null,
      externalOrigin: null,
      externalId: null,
      fileIds,
      version: 1,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      createdAt: now,
      updatedAt: now,
    };

    const prepared = this.fields.validateWrite({
      actor,
      entityType: 'ACTIVITY',
      entityId: null,
      isCreate: true,
      supplied: input.customFields,
      systemState: this.systemState(activity),
      activityTypeId: descriptor.customActivityTypeId,
    });
    const reminderPlan = this.parseReminders(activity, input.reminders, responsibleUserId, participantIds, now);

    // Specialist authority first: only after Calendar/Tasks confirm do we record the CRM-side representation.
    await this.delegateCreate(actor, activity, descriptor, participantIds, key);

    this.state.crmActivities.push(activity);
    this.state.crmActivityBindings.push(...bindings.map((binding, index) => this.bindingRow(actor, activity, binding, index === 0)));
    this.state.crmActivityParticipants.push(...participantIds.map((userId) => this.participantRow(workspaceId, activityId, userId, 'PARTICIPANT')));
    this.state.crmActivityCommunications.push(...communications.map((item) => this.communicationRow(workspaceId, activityId, item)));
    this.createReminderRows(activity, reminderPlan);
    this.fields.commit(prepared, activityId);

    this.audit(workspaceId, actor.user.id, 'ACTIVITY.CREATED', activityId, null, this.auditShape(activity));
    this.emit(activity, 'ACTIVITY_CREATED', actor.user.id, {
      typeCode: activity.typeCode,
      subject: activity.subject,
      priority,
      responsibleUserId,
      deadline: activity.deadline?.toISOString() ?? null,
      startAt: activity.startAt?.toISOString() ?? null,
    }, key);
    if (responsibleUserId && responsibleUserId !== actor.user.id) {
      this.emit(activity, 'ACTIVITY_REASSIGNED', actor.user.id, { from: null, to: responsibleUserId, initialAssignment: true }, key);
    }
    return activityId;
  }

  private async delegateCreate(actor: ActorContext, activity: Activity, descriptor: ActivityTypeDescriptor, participantIds: string[], key: string | undefined) {
    if (!descriptor.adapterKind || !this.adapters.has(descriptor.adapterKind)) return;
    try {
      if (descriptor.adapterKind === 'CALENDAR') {
        const result = await this.adapters.getCalendar()!.createMeeting({
          workspaceId: activity.workspaceId,
          actorUserId: actor.user.id,
          activityId: activity.id,
          subject: activity.subject,
          startAt: activity.startAt ?? null,
          endAt: activity.endAt ?? null,
          location: activity.location ?? null,
          participantUserIds: participantIds,
          idempotencyKey: `${key ?? activity.id}:calendar:create`,
        });
        activity.adapterKind = 'CALENDAR';
        activity.adapterResourceId = result.eventId;
        // Reflect what Calendar confirmed, not what was asked for.
        activity.startAt = result.startAt;
        activity.endAt = result.endAt;
        activity.location = result.location;
      } else if (descriptor.adapterKind === 'TASKS') {
        const result = await this.adapters.getTasks()!.createTask({
          workspaceId: activity.workspaceId,
          actorUserId: actor.user.id,
          activityId: activity.id,
          subject: activity.subject,
          description: activity.description ?? null,
          deadline: activity.deadline ?? null,
          responsibleUserId: activity.responsibleUserId ?? null,
          idempotencyKey: `${key ?? activity.id}:tasks:create`,
        });
        activity.adapterKind = 'TASKS';
        activity.adapterResourceId = result.taskId;
      }
      this.audit(activity.workspaceId, actor.user.id, 'ACTIVITY.ADAPTER_LINKED', activity.id, null, { adapterKind: activity.adapterKind, adapterResourceId: activity.adapterResourceId });
    } catch (error) {
      ActivityAdapterRegistry.wrap(error);
    }
  }

  // ---- read -----------------------------------------------------------------------------------------------------------

  getById(user: User, workspaceId: string, activityId: string, includeDeleted = false): ActivityDto {
    const actor = this.actorOf(user, workspaceId);
    return this.buildDto(actor, this.readable(actor, activityId, includeDeleted));
  }

  /** Shapes an Activity for one reader: unauthorized bindings and custom fields never leave the server. */
  buildDto(actor: ActorContext, activity: Activity) {
    const descriptor = this.types.find(activity.workspaceId, activity.typeCode);
    const bindings = this.policy.visibleBindings(actor, activity.id).map((binding) => ({
      id: binding.id,
      entityType: binding.entityType,
      entityId: binding.entityId,
      isPrimary: binding.isPrimary,
      displayName: this.displayName(binding.entityType, binding.entityId),
    }));
    const participants = this.state.crmActivityParticipants.filter((item) => item.activityId === activity.id).map((item) => ({ userId: item.userId, role: item.role }));
    const communications = this.state.crmActivityCommunications
      .filter((item) => item.activityId === activity.id)
      .map((item) => {
        const referenceVisible = item.crmEntityType && item.crmEntityId && this.access.canAccessCrmRecord(actor, item.crmEntityType, item.crmEntityId, 'read');
        return {
          id: item.id,
          type: item.communicationType,
          value: item.normalizedValue,
          displayValue: item.rawDisplayValue ?? item.normalizedValue,
          label: item.label ?? null,
          isPrimary: item.isPrimary,
          crmEntityType: referenceVisible ? item.crmEntityType : null,
          crmEntityId: referenceVisible ? item.crmEntityId : null,
        };
      });
    const reminders = this.state.crmActivityReminders
      .filter((item) => item.activityId === activity.id)
      .map((item) => ({
        id: item.id,
        mode: item.mode,
        relativeTo: item.relativeTo ?? null,
        offsetSeconds: item.offsetSeconds ?? null,
        absoluteAt: item.absoluteAt ?? null,
        scheduledFor: item.scheduledFor ?? null,
        status: item.status,
        recipientUserIds: this.state.crmActivityReminderRecipients.filter((recipient) => recipient.reminderId === item.id).map((recipient) => recipient.userId),
      }));
    const customFields = this.fields.decorate(actor, 'ACTIVITY', [{ id: activity.id, customActivityTypeId: activity.customActivityTypeId ?? null }])[0].customFields;
    const deadline = descriptor ? resolvedDeadline(activity, descriptor.deadlineBasis) : activity.deadline ?? null;
    return {
      id: activity.id,
      typeCode: activity.typeCode,
      typeLabel: descriptor?.label ?? activity.typeCode,
      customActivityTypeId: activity.customActivityTypeId ?? null,
      subject: activity.subject,
      description: activity.description ?? null,
      status: activity.status,
      priority: activity.priority,
      direction: activity.direction,
      createdByUserId: activity.createdByUserId ?? null,
      responsibleUserId: activity.responsibleUserId ?? null,
      startAt: activity.startAt ?? null,
      endAt: activity.endAt ?? null,
      deadline: activity.deadline ?? null,
      location: activity.location ?? null,
      resultText: activity.resultText ?? null,
      completedAt: activity.completedAt ?? null,
      cancelledAt: activity.cancelledAt ?? null,
      cancellationReason: activity.cancellationReason ?? null,
      reopenedAt: activity.reopenedAt ?? null,
      adapterKind: activity.adapterKind ?? null,
      adapterResourceId: activity.adapterResourceId ?? null,
      externalOrigin: activity.externalOrigin ?? null,
      fileIds: activity.fileIds,
      isOverdue: this.isOverdue(activity, new Date()),
      overdueDeadline: deadline,
      version: activity.version,
      isDeleted: activity.isDeleted,
      deletedAt: activity.deletedAt ?? null,
      createdAt: activity.createdAt,
      updatedAt: activity.updatedAt,
      bindings,
      participants,
      communications,
      reminders,
      customFields,
      actions: {
        canUpdate: this.policy.canDo(actor, 'activity.update', activity) && isOpenStatus(activity.status) && !activity.isDeleted,
        canComplete: this.policy.canDo(actor, 'activity.complete', activity) && isOpenStatus(activity.status) && !activity.isDeleted,
        canCancel: this.policy.canDo(actor, 'activity.update', activity) && isOpenStatus(activity.status) && !activity.isDeleted,
        canReopen: this.policy.canDo(actor, 'activity.reopen', activity) && !isOpenStatus(activity.status) && !activity.isDeleted,
        canDelete: this.policy.canDo(actor, 'activity.delete', activity),
        canAssign: this.policy.canDo(actor, 'activity.assign', activity),
      },
    };
  }

  private displayName(entityType: string, entityId: string) {
    const s = this.state;
    if (entityType === 'LEAD') return s.crmLeads.find((item) => item.id === entityId)?.title ?? null;
    if (entityType === 'DEAL') return s.crmDeals.find((item) => item.id === entityId)?.title ?? null;
    if (entityType === 'CONTACT') return s.crmContacts.find((item) => item.id === entityId)?.displayName ?? null;
    if (entityType === 'COMPANY') return s.crmCompanies.find((item) => item.id === entityId)?.name ?? null;
    return null;
  }

  isOverdue(activity: Activity, at: Date) {
    if (activity.isDeleted || !isOpenStatus(activity.status)) return false;
    const descriptor = this.types.find(activity.workspaceId, activity.typeCode);
    const deadline = resolvedDeadline(activity, descriptor?.deadlineBasis ?? 'DEADLINE');
    return deadline !== null && deadline.getTime() < at.getTime();
  }

  list(user: User, workspaceId: string, searchParams: URLSearchParams) {
    const actor = this.actorOf(user, workspaceId);
    this.access.requireScope(actor, 'activity.read');
    const now = new Date();
    const q = (key: string) => searchParams.get(key) ?? undefined;
    const csv = (key: string) => (q(key) ? q(key)!.split(',').map((part) => part.trim()).filter(Boolean) : undefined);
    const includeDeleted = q('includeDeleted') === 'true';
    if (includeDeleted && this.access.scopeFor(actor, 'activity.delete') === null) throw forbidden('activity.delete permission is required to include deleted Activities.');

    const view = q('view') === 'ALL' ? 'ALL' : 'MY_OPEN';
    const statuses = csv('status');
    const typeCodes = csv('typeCode');
    const priorities = csv('priority');
    for (const status of statuses ?? []) if (!['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].includes(status)) throw badRequest('CRM_QUERY_INVALID', `Unknown status ${status}.`);
    for (const priority of priorities ?? []) if (!ACTIVITY_PRIORITIES.includes(priority as ActivityPriority)) throw badRequest('CRM_QUERY_INVALID', `Unknown priority ${priority}.`);
    const responsibleFilter = q('responsibleUserId');
    const participantFilter = q('participantUserId');
    const bindingType = q('bindingEntityType');
    const bindingId = q('bindingEntityId');
    const overdueFilter = q('overdue');
    const date = (key: string) => {
      const raw = q(key);
      if (!raw) return undefined;
      const parsed = parseInstant(raw, key);
      return parsed!.getTime();
    };
    const deadlineFrom = date('deadlineFrom');
    const deadlineTo = date('deadlineTo');
    const createdFrom = date('createdFrom');
    const createdTo = date('createdTo');
    const search = q('search')?.toLowerCase();
    const sort = q('sort') === 'DEADLINE' ? 'DEADLINE' : q('sort') === 'CREATED_DESC' ? 'CREATED_DESC' : 'URGENCY';
    const limit = Math.min(Math.max(Number(q('limit') ?? '25') || 25, 1), 100);
    const bindingSet = new Map<string, Set<string>>();
    for (const binding of this.state.crmActivityBindings) {
      if (binding.workspaceId !== workspaceId) continue;
      if (!bindingSet.has(binding.activityId)) bindingSet.set(binding.activityId, new Set());
      bindingSet.get(binding.activityId)!.add(`${binding.entityType}:${binding.entityId}`);
    }

    let rows = this.state.crmActivities.filter((activity) => activity.workspaceId === workspaceId && (includeDeleted || !activity.isDeleted));
    rows = rows.filter((activity) => this.policy.canRead(actor, activity));
    if (view === 'MY_OPEN') {
      rows = rows.filter((activity) => activity.responsibleUserId === actor.user.id);
      if (!statuses) rows = rows.filter((activity) => isOpenStatus(activity.status));
    }
    if (statuses) rows = rows.filter((activity) => statuses.includes(activity.status));
    if (typeCodes) rows = rows.filter((activity) => typeCodes.includes(activity.typeCode));
    if (priorities) rows = rows.filter((activity) => priorities.includes(activity.priority));
    if (responsibleFilter) rows = rows.filter((activity) => activity.responsibleUserId === responsibleFilter);
    if (participantFilter) {
      rows = rows.filter((activity) => this.state.crmActivityParticipants.some((item) => item.activityId === activity.id && item.userId === participantFilter));
    }
    if (bindingType || bindingId) {
      rows = rows.filter((activity) => {
        const set = bindingSet.get(activity.id);
        if (!set) return false;
        return [...set].some((entry) => {
          const [type, id] = entry.split(':');
          if (bindingType && type !== bindingType) return false;
          if (bindingId && id !== bindingId) return false;
          // Filtering may only use bindings the reader is allowed to see.
          return this.access.canAccessCrmRecord(actor, type, id, 'read');
        });
      });
    }
    if (overdueFilter !== undefined) {
      const wanted = overdueFilter === 'true';
      rows = rows.filter((activity) => this.isOverdue(activity, now) === wanted);
    }
    if (deadlineFrom !== undefined || deadlineTo !== undefined) {
      rows = rows.filter((activity) => {
        const descriptor = this.types.find(workspaceId, activity.typeCode);
        const deadline = resolvedDeadline(activity, descriptor?.deadlineBasis ?? 'DEADLINE');
        if (!deadline) return false;
        return (deadlineFrom === undefined || deadline.getTime() >= deadlineFrom) && (deadlineTo === undefined || deadline.getTime() <= deadlineTo);
      });
    }
    if (createdFrom !== undefined) rows = rows.filter((activity) => activity.createdAt.getTime() >= createdFrom);
    if (createdTo !== undefined) rows = rows.filter((activity) => activity.createdAt.getTime() <= createdTo);
    if (search) rows = rows.filter((activity) => activity.subject.toLowerCase().includes(search) || (activity.description ?? '').toLowerCase().includes(search));

    const keyOf = (activity: Activity): string => {
      const descriptor = this.types.find(workspaceId, activity.typeCode);
      const deadline = resolvedDeadline(activity, descriptor?.deadlineBasis ?? 'DEADLINE');
      const deadlineKey = deadline ? deadline.toISOString() : '9999-12-31T23:59:59.999Z';
      if (sort === 'CREATED_DESC') return `${String(9_999_999_999_999 - activity.createdAt.getTime()).padStart(13, '0')}|${activity.id}`;
      if (sort === 'DEADLINE') return `${deadlineKey}|${activity.id}`;
      // URGENCY: overdue first, then earliest deadline, then priority.
      return `${this.isOverdue(activity, now) ? '0' : '1'}|${deadlineKey}|${priorityRank(activity.priority)}|${activity.id}`;
    };
    const keyed = rows.map((activity) => ({ activity, key: keyOf(activity) })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const cursor = decodeCursor(q('cursor'));
    const after = cursor ? keyed.filter((row) => row.key > cursor.key) : keyed;
    const page = after.slice(0, limit);
    const hasMore = after.length > limit;
    return {
      data: page.map((row) => this.buildDto(actor, row.activity)),
      meta: { limit, hasMore, nextCursor: hasMore ? encodeCursor({ key: page[page.length - 1].key }) : null, view, sort },
    };
  }

  // ---- update ---------------------------------------------------------------------------------------------------------

  async update(user: User, workspaceId: string, activityId: string, input: Json): Promise<ActivityDto> {
    const actor = this.actorOf(user, workspaceId);
    await this.guardAdapter(actor, activityId, 'update', () => this.store.atomic(() => this.updateUnsafe(actor, activityId, input)));
    return this.buildDto(actor, this.activity(workspaceId, activityId));
  }

  private async updateUnsafe(actor: ActorContext, activityId: string, input: Json) {
    const activity = this.readable(actor, activityId);
    if (!this.policy.scopeCovers(actor, 'activity.update', activity)) throw forbidden();
    if (typeof input.expectedVersion !== 'number') throw badRequest('ACTIVITY_VERSION_REQUIRED', 'expectedVersion is required.');
    if (activity.version !== input.expectedVersion) throw new AppError('ACTIVITY_VERSION_CONFLICT', 'The activity changed after you opened it.', 409, { currentVersion: activity.version });
    if (input.status !== undefined) throw badRequest('ACTIVITY_STATUS_PATCH_FORBIDDEN', 'status cannot be changed with PATCH; use the lifecycle commands.');
    const descriptor = this.types.find(actor.workspaceId, activity.typeCode) ?? this.types.require(actor.workspaceId, 'FOLLOW_UP');

    const editable = new Set(['subject', 'description', 'priority', 'direction', 'startAt', 'endAt', 'deadline', 'location', 'responsibleUserId', 'participants', 'communications', 'fileIds', 'customFields', 'expectedVersion', 'idempotencyKey']);
    const unknown = Object.keys(input).filter((key) => !editable.has(key));
    if (unknown.length > 0) throw badRequest('ACTIVITY_FIELD_NOT_UPDATABLE', `These fields cannot be updated: ${unknown.join(', ')}.`, { fields: unknown });

    const businessKeys = Object.keys(input).filter((key) => !['expectedVersion', 'idempotencyKey', 'fileIds'].includes(key));
    if (!isOpenStatus(activity.status) && businessKeys.length > 0) {
      throw new AppError('ACTIVITY_EDIT_REQUIRES_REOPEN', 'Completed or cancelled activities must be reopened before their business fields can be edited.', 409);
    }
    if (!isOpenStatus(activity.status) && input.fileIds !== undefined) {
      // Files may still be added after completion, but existing references are never removed and history is not rewritten.
      const requested = this.parseFiles(actor, descriptor, input.fileIds);
      if (activity.fileIds.some((id) => !requested.includes(id))) {
        throw new AppError('ACTIVITY_EDIT_REQUIRES_REOPEN', 'Files can only be added to a completed or cancelled activity.', 409);
      }
    }

    const before = this.auditShape(activity);
    const changedFields: string[] = [];
    const next = {
      subject: input.subject !== undefined ? requireString(input.subject, 'subject', MAX_SUBJECT)! : activity.subject,
      description: input.description !== undefined ? requireString(input.description, 'description', MAX_DESCRIPTION, false) : activity.description ?? null,
      location: input.location !== undefined ? requireString(input.location, 'location', MAX_LOCATION, false) : activity.location ?? null,
      priority: input.priority !== undefined ? this.priority(input.priority, activity.priority) : activity.priority,
      direction: input.direction !== undefined ? this.direction(input.direction, descriptor) : activity.direction,
    };
    if (next.location && !descriptor.supportsLocation) throw fieldValidationFailed({ location: [{ code: 'UNSUPPORTED', message: `${descriptor.label} does not support a location.` }] });
    const times = this.times(descriptor, input, activity);

    let responsibleUserId = activity.responsibleUserId ?? null;
    let reassigned = false;
    if (input.responsibleUserId !== undefined && input.responsibleUserId !== activity.responsibleUserId) {
      if (typeof input.responsibleUserId !== 'string' || !this.policy.canAssignTo(actor, input.responsibleUserId)) {
        throw new AppError('ACTIVITY_ASSIGN_FORBIDDEN', 'You are not allowed to assign this activity to that user.', 403);
      }
      responsibleUserId = input.responsibleUserId;
      reassigned = true;
    }

    let participantIds: string[] | null = null;
    if (input.participants !== undefined) participantIds = this.parseParticipants(actor, descriptor, input.participants, responsibleUserId);
    const communications = input.communications !== undefined ? this.parseCommunications(actor, descriptor, input.communications) : null;
    const fileIds = input.fileIds !== undefined ? this.parseFiles(actor, descriptor, input.fileIds) : null;

    const projected: Activity = { ...activity, ...next, ...times, responsibleUserId };
    const prepared = this.fields.validateWrite({
      actor,
      entityType: 'ACTIVITY',
      entityId: activity.id,
      isCreate: false,
      supplied: input.customFields,
      systemState: this.systemState(projected),
      activityTypeId: activity.customActivityTypeId ?? null,
    });

    const oldDeadline = resolvedDeadline(activity, descriptor.deadlineBasis);
    const newDeadline = resolvedDeadline(projected, descriptor.deadlineBasis);
    const rescheduled = this.timeChanged(activity.startAt, projected.startAt) || this.timeChanged(activity.endAt, projected.endAt) || this.timeChanged(activity.deadline, projected.deadline);

    // Specialist authority first (Calendar owns scheduling; Tasks owns the task).
    await this.delegateUpdate(actor, projected, descriptor, participantIds ?? this.participantIds(activity.id));

    for (const key of ['subject', 'description', 'location', 'priority', 'direction'] as const) {
      if ((activity[key] ?? null) !== (projected[key] ?? null)) changedFields.push(key);
    }
    if (rescheduled) changedFields.push(...(['startAt', 'endAt', 'deadline'] as const).filter((key) => this.timeChanged(activity[key], projected[key])));
    Object.assign(activity, {
      ...next,
      startAt: projected.startAt,
      endAt: projected.endAt,
      deadline: projected.deadline,
      location: projected.location,
      responsibleUserId,
    });
    if ((oldDeadline?.getTime() ?? null) !== (newDeadline?.getTime() ?? null)) activity.deadlineVersion += 1;
    if (reassigned) changedFields.push('responsibleUserId');
    if (participantIds) {
      this.state.crmActivityParticipants = this.state.crmActivityParticipants.filter((item) => item.activityId !== activity.id);
      this.state.crmActivityParticipants.push(...participantIds.map((userId) => this.participantRow(activity.workspaceId, activity.id, userId, 'PARTICIPANT')));
      changedFields.push('participants');
    }
    if (communications) {
      this.state.crmActivityCommunications = this.state.crmActivityCommunications.filter((item) => item.activityId !== activity.id);
      this.state.crmActivityCommunications.push(...communications.map((item) => this.communicationRow(activity.workspaceId, activity.id, item)));
      changedFields.push('communications');
    }
    if (fileIds) {
      activity.fileIds = fileIds;
      changedFields.push('fileIds');
    }
    if (prepared.changes.size > 0) {
      this.fields.commit(prepared, activity.id);
      changedFields.push(...[...prepared.changes.values()].map((entry) => `customFields.${entry.field.code}`));
    }
    if (changedFields.length === 0) return;

    if (rescheduled || reassigned || participantIds) this.recomputeReminders(activity, reassigned || Boolean(participantIds));
    activity.version += 1;
    activity.updatedAt = new Date();
    this.audit(activity.workspaceId, actor.user.id, 'ACTIVITY.UPDATED', activity.id, before, this.auditShape(activity), { changedFields });
    this.emit(activity, 'ACTIVITY_UPDATED', actor.user.id, {
      changedFields,
      rescheduled,
      previous: { startAt: before.startAt, deadline: before.deadline },
      next: { startAt: activity.startAt?.toISOString() ?? null, deadline: activity.deadline?.toISOString() ?? null },
      subject: activity.subject,
      typeCode: activity.typeCode,
    });
    if (reassigned) {
      this.audit(activity.workspaceId, actor.user.id, 'ACTIVITY.REASSIGNED', activity.id, { responsibleUserId: before.responsibleUserId }, { responsibleUserId });
      this.emit(activity, 'ACTIVITY_REASSIGNED', actor.user.id, { from: before.responsibleUserId, to: responsibleUserId, subject: activity.subject, typeCode: activity.typeCode });
    }
  }

  private async delegateUpdate(actor: ActorContext, projected: Activity, descriptor: ActivityTypeDescriptor, participantIds: string[]) {
    if (!projected.adapterResourceId || !descriptor.adapterKind || !this.adapters.has(descriptor.adapterKind)) return;
    try {
      const key = `${projected.id}:v${projected.version + 1}:update`;
      if (descriptor.adapterKind === 'CALENDAR') {
        const result = await this.adapters.getCalendar()!.updateMeeting(projected.adapterResourceId, {
          workspaceId: projected.workspaceId,
          actorUserId: actor.user.id,
          activityId: projected.id,
          subject: projected.subject,
          startAt: projected.startAt ?? null,
          endAt: projected.endAt ?? null,
          location: projected.location ?? null,
          participantUserIds: participantIds,
          idempotencyKey: key,
        });
        projected.startAt = result.startAt;
        projected.endAt = result.endAt;
        projected.location = result.location;
      } else if (descriptor.adapterKind === 'TASKS') {
        await this.adapters.getTasks()!.updateTask(projected.adapterResourceId, {
          workspaceId: projected.workspaceId,
          actorUserId: actor.user.id,
          activityId: projected.id,
          subject: projected.subject,
          description: projected.description ?? null,
          deadline: projected.deadline ?? null,
          responsibleUserId: projected.responsibleUserId ?? null,
          idempotencyKey: key,
        });
      }
    } catch (error) {
      ActivityAdapterRegistry.wrap(error);
    }
  }

  // ---- lifecycle commands ----------------------------------------------------------------------------------------------

  start(user: User, workspaceId: string, activityId: string, input: Json = {}, headerKey?: string) {
    return this.command(user, workspaceId, activityId, 'start', input, headerKey);
  }

  complete(user: User, workspaceId: string, activityId: string, input: Json = {}, headerKey?: string) {
    return this.command(user, workspaceId, activityId, 'complete', input, headerKey);
  }

  cancel(user: User, workspaceId: string, activityId: string, input: Json = {}, headerKey?: string) {
    return this.command(user, workspaceId, activityId, 'cancel', input, headerKey);
  }

  reopen(user: User, workspaceId: string, activityId: string, input: Json = {}, headerKey?: string) {
    return this.command(user, workspaceId, activityId, 'reopen', input, headerKey);
  }

  private async command(user: User, workspaceId: string, activityId: string, command: CommandName, input: Json, headerKey?: string): Promise<ActivityDto> {
    const actor = this.actorOf(user, workspaceId);
    const key = (input.idempotencyKey as string | undefined) ?? headerKey;
    await this.guardAdapter(actor, activityId, command, () =>
      this.idempotent(actor, `crm.activity.${command}:${activityId}`, key, input, () =>
        this.store.atomic(async () => {
          await this.commandUnsafe(actor, activityId, command, input, key);
          return activityId;
        }),
      ),
    );
    return this.buildDto(actor, this.activity(workspaceId, activityId));
  }

  private async commandUnsafe(actor: ActorContext, activityId: string, command: CommandName, input: Json, key: string | undefined) {
    const activity = this.readable(actor, activityId);
    const permission = command === 'complete' ? 'activity.complete' : command === 'reopen' ? 'activity.reopen' : 'activity.update';
    if (!this.policy.scopeCovers(actor, permission, activity)) throw forbidden();
    if (input.expectedVersion !== undefined && activity.version !== input.expectedVersion) {
      throw new AppError('ACTIVITY_VERSION_CONFLICT', 'The activity changed after you opened it.', 409, { currentVersion: activity.version });
    }
    const transition = TRANSITIONS[command].find((item) => item.from.includes(activity.status));
    if (!transition) {
      // Repeating a command on a state it already produced is an idempotent success, never a second side effect.
      // (Reopen is excluded: reopening an activity that is already open is an invalid transition, not a replay.)
      const alreadyThere = command !== 'reopen' && TRANSITIONS[command].some((item) => item.to === activity.status);
      if (alreadyThere) return;
      throw new AppError('ACTIVITY_INVALID_TRANSITION', `An activity that is ${activity.status} cannot be ${command === 'start' ? 'started' : command === 'complete' ? 'completed' : command === 'cancel' ? 'cancelled' : 'reopened'}.`, 409);
    }
    const descriptor = this.types.find(actor.workspaceId, activity.typeCode);
    const before = this.auditShape(activity);

    let resultText: string | null | undefined;
    let prepared: ReturnType<FieldEngine['validateWrite']> | null = null;
    let reason: string | null = null;
    if (command === 'complete') {
      resultText = requireString(input.resultText, 'resultText', MAX_RESULT, false);
      if (resultText && descriptor && !descriptor.supportsResult) throw fieldValidationFailed({ resultText: [{ code: 'UNSUPPORTED', message: `${descriptor.label} does not support a result.` }] });
      const projected: Activity = { ...activity, status: 'COMPLETED', resultText: resultText ?? activity.resultText ?? null };
      prepared = this.fields.validateWrite({
        actor,
        entityType: 'ACTIVITY',
        entityId: activity.id,
        isCreate: false,
        supplied: input.customFields,
        systemState: this.systemState(projected),
        activityTypeId: activity.customActivityTypeId ?? null,
      });
    } else if (command === 'cancel' || command === 'reopen') {
      reason = requireString(input.reason, 'reason', 2000, false);
    }

    await this.delegateCommand(actor, activity, descriptor, command, key);

    const now = new Date();
    activity.status = transition.to;
    if (command === 'complete') {
      activity.completedAt = now;
      if (resultText !== undefined && resultText !== null) activity.resultText = resultText;
      if (prepared && prepared.changes.size > 0) this.fields.commit(prepared, activity.id);
      this.cancelPendingReminders(activity.id);
    } else if (command === 'cancel') {
      activity.cancelledAt = now;
      activity.cancellationReason = reason;
      this.cancelPendingReminders(activity.id);
    } else if (command === 'reopen') {
      activity.completedAt = null;
      activity.cancelledAt = null;
      activity.cancellationReason = null;
      activity.reopenedAt = now;
      // Never resurrect a reminder that already fired: only still-future, never-sent occurrences come back.
      this.restoreFutureReminders(activity, now);
    }
    activity.version += 1;
    activity.updatedAt = now;
    this.audit(activity.workspaceId, actor.user.id, `ACTIVITY.${command === 'start' ? 'STARTED' : command === 'complete' ? 'COMPLETED' : command === 'cancel' ? 'CANCELLED' : 'REOPENED'}`, activity.id, before, this.auditShape(activity), reason ? { reason } : undefined);
    this.emit(activity, COMMAND_EVENT[command], actor.user.id, {
      typeCode: activity.typeCode,
      subject: activity.subject,
      from: before.status,
      to: activity.status,
      resultSummary: command === 'complete' ? (activity.resultText ?? '').slice(0, 200) : undefined,
      reason: reason ?? undefined,
    }, key);
  }

  private async delegateCommand(actor: ActorContext, activity: Activity, descriptor: ActivityTypeDescriptor | undefined, command: CommandName, key: string | undefined) {
    if (!activity.adapterResourceId || !descriptor?.adapterKind || !this.adapters.has(descriptor.adapterKind)) return;
    const params = { workspaceId: activity.workspaceId, actorUserId: actor.user.id, idempotencyKey: `${key ?? `${activity.id}:v${activity.version}`}:${command}` };
    try {
      if (descriptor.adapterKind === 'TASKS') {
        const tasks = this.adapters.getTasks()!;
        if (command === 'complete') await tasks.completeTask(activity.adapterResourceId, params);
        else if (command === 'cancel') await tasks.cancelTask(activity.adapterResourceId, params);
        else if (command === 'reopen') await tasks.reopenTask(activity.adapterResourceId, params);
      } else if (descriptor.adapterKind === 'CALENDAR') {
        const calendar = this.adapters.getCalendar()!;
        if (command === 'complete') await calendar.completeMeeting(activity.adapterResourceId, params);
        else if (command === 'cancel') await calendar.cancelMeeting(activity.adapterResourceId, params);
      }
    } catch (error) {
      // The authoritative module refused, so the Activity must NOT look completed/cancelled.
      ActivityAdapterRegistry.wrap(error);
    }
  }

  reassign(user: User, workspaceId: string, activityId: string, input: Json): Promise<ActivityDto> {
    const actor = this.actorOf(user, workspaceId);
    const key = input.idempotencyKey as string | undefined;
    return (async () => {
      await this.idempotent(actor, `crm.activity.reassign:${activityId}`, key, input, () =>
        this.store.atomic(async () => {
          const activity = this.readable(actor, activityId);
          // Re-applying the same assignment is a no-op, which keeps bulk retries safe.
          if (activity.responsibleUserId === input.responsibleUserId) return activityId;
          const version = typeof input.expectedVersion === 'number' ? input.expectedVersion : activity.version;
          await this.updateUnsafe(actor, activityId, { responsibleUserId: input.responsibleUserId, expectedVersion: version });
          return activityId;
        }),
      );
      return this.buildDto(actor, this.activity(workspaceId, activityId));
    })();
  }

  // ---- soft delete / restore ---------------------------------------------------------------------------------------------

  async softDelete(user: User, workspaceId: string, activityId: string): Promise<{ id: string; isDeleted: true }> {
    const actor = this.actorOf(user, workspaceId);
    await this.store.atomic(async () => {
      const activity = this.activity(workspaceId, activityId);
      if (activity.isDeleted) return; // idempotent
      if (!this.policy.canRead(actor, activity)) throw new AppError('ACTIVITY_NOT_FOUND', 'Activity was not found.', 404);
      if (!this.policy.scopeCovers(actor, 'activity.delete', activity)) throw forbidden();
      const before = this.auditShape(activity);
      activity.isDeleted = true;
      activity.deletedAt = new Date();
      activity.deletedByUserId = actor.user.id;
      activity.version += 1;
      activity.updatedAt = new Date();
      // Soft delete never touches the specialist source record (Calendar/Task); that is a separate authorized operation.
      this.cancelPendingReminders(activity.id);
      this.audit(workspaceId, actor.user.id, 'ACTIVITY.SOFT_DELETED', activity.id, before, this.auditShape(activity));
      this.emit(activity, 'ACTIVITY_DELETED', actor.user.id, { typeCode: activity.typeCode, subject: activity.subject });
    });
    return { id: activityId, isDeleted: true };
  }

  async restore(user: User, workspaceId: string, activityId: string, input: Json = {}): Promise<ActivityDto> {
    const actor = this.actorOf(user, workspaceId);
    await this.store.atomic(async () => {
      const activity = this.activity(workspaceId, activityId);
      if (!activity.isDeleted) return; // idempotent
      if (!this.policy.scopeCovers(actor, 'activity.delete', activity)) throw new AppError('ACTIVITY_NOT_FOUND', 'Activity was not found.', 404);
      // Revalidate what the Activity points at: the responsible user, bindings and (custom) type may have changed.
      let responsibleUserId = activity.responsibleUserId ?? null;
      if (typeof input.responsibleUserId === 'string') {
        if (!this.access.isActiveMember(workspaceId, input.responsibleUserId)) throw new AppError('ACTIVITY_RESTORE_INVALID', 'The responsible user is not an active workspace member.', 409);
        responsibleUserId = input.responsibleUserId;
      } else if (responsibleUserId && !this.access.isActiveMember(workspaceId, responsibleUserId)) {
        throw new AppError('ACTIVITY_RESTORE_INVALID', 'The responsible user is no longer an active member. Provide responsibleUserId to restore.', 409, { requires: 'responsibleUserId' });
      }
      const removedBindings: string[] = [];
      for (const binding of this.policy.bindingsOf(activity.id)) {
        if (!this.access.crmRecord(workspaceId, binding.entityType, binding.entityId)) {
          removedBindings.push(binding.id);
        }
      }
      if (removedBindings.length > 0) this.state.crmActivityBindings = this.state.crmActivityBindings.filter((item) => !removedBindings.includes(item.id));
      const before = this.auditShape(activity);
      activity.isDeleted = false;
      activity.deletedAt = null;
      activity.deletedByUserId = null;
      activity.responsibleUserId = responsibleUserId;
      activity.version += 1;
      activity.updatedAt = new Date();
      if (isOpenStatus(activity.status)) this.restoreFutureReminders(activity, new Date());
      this.audit(workspaceId, actor.user.id, 'ACTIVITY.RESTORED', activity.id, before, this.auditShape(activity), { removedBindings: removedBindings.length });
      this.emit(activity, 'ACTIVITY_RESTORED', actor.user.id, { typeCode: activity.typeCode, subject: activity.subject });
    });
    return this.getById(user, workspaceId, activityId);
  }

  // ---- bulk ----------------------------------------------------------------------------------------------------------------

  async bulk(user: User, workspaceId: string, input: Json) {
    this.actorOf(user, workspaceId);
    const operation = String(input.operation ?? '').toUpperCase();
    const ids = input.activityIds;
    if (!['REASSIGN', 'COMPLETE', 'CANCEL', 'SOFT_DELETE', 'DELETE'].includes(operation)) {
      throw badRequest('ACTIVITY_BULK_OPERATION_INVALID', 'operation must be REASSIGN, COMPLETE, CANCEL or SOFT_DELETE.');
    }
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) throw badRequest('ACTIVITY_BULK_INVALID', 'activityIds must be a non-empty array of ids.');
    if (ids.length > MAX_BULK) throw new AppError('ACTIVITY_BULK_LIMIT_EXCEEDED', `At most ${MAX_BULK} activities can be processed at once.`, 400);
    const unique = [...new Set(ids as string[])];
    const root = typeof input.idempotencyKey === 'string' ? input.idempotencyKey : undefined;
    const payload = (input.payload ?? {}) as Json;
    if (operation === 'REASSIGN' && typeof payload.responsibleUserId !== 'string') throw badRequest('ACTIVITY_BULK_INVALID', 'payload.responsibleUserId is required for REASSIGN.');

    const results: Array<{ id: string; success: boolean; version?: number; code?: string; message?: string }> = [];
    for (const id of unique) {
      // Each item goes through the same single-item command and is re-authorized/re-validated on its own.
      const itemKey = root ? `${root}:${id}` : undefined;
      try {
        let dto: ActivityDto | { id: string };
        if (operation === 'COMPLETE') dto = await this.complete(user, workspaceId, id, { ...payload, idempotencyKey: itemKey });
        else if (operation === 'CANCEL') dto = await this.cancel(user, workspaceId, id, { ...payload, idempotencyKey: itemKey });
        else if (operation === 'REASSIGN') dto = await this.reassign(user, workspaceId, id, { responsibleUserId: payload.responsibleUserId, idempotencyKey: itemKey });
        else dto = await this.softDelete(user, workspaceId, id);
        results.push({ id, success: true, version: (dto as ActivityDto).version });
      } catch (error) {
        const app = error instanceof AppError ? error : null;
        // Only safe codes/messages: hidden entity details never appear in per-item errors.
        results.push({ id, success: false, code: app?.code ?? 'INTERNAL_ERROR', message: app && app.status < 500 ? app.message : 'The operation failed.' });
      }
    }
    return {
      operation: operation === 'DELETE' ? 'SOFT_DELETE' : operation,
      succeeded: results.filter((item) => item.success).length,
      failed: results.filter((item) => !item.success).length,
      results,
    };
  }

  // ---- bindings --------------------------------------------------------------------------------------------------------------

  listBindings(user: User, workspaceId: string, activityId: string) {
    const actor = this.actorOf(user, workspaceId);
    const activity = this.readable(actor, activityId);
    return this.policy.visibleBindings(actor, activity.id).map((binding) => ({
      id: binding.id,
      entityType: binding.entityType,
      entityId: binding.entityId,
      isPrimary: binding.isPrimary,
      displayName: this.displayName(binding.entityType, binding.entityId),
    }));
  }

  /** Editing an Activity and binding it to a CRM record are separate authorization decisions. */
  addBinding(user: User, workspaceId: string, activityId: string, input: Json) {
    const actor = this.actorOf(user, workspaceId);
    return this.store.atomicSync(() => {
      const activity = this.readable(actor, activityId);
      if (!this.policy.scopeCovers(actor, 'activity.update', activity)) throw forbidden();
      if (!isOpenStatus(activity.status)) throw new AppError('ACTIVITY_EDIT_REQUIRES_REOPEN', 'Reopen the activity before changing its bindings.', 409);
      const [binding] = this.parseBindings(actor, [input]);
      if (this.policy.bindingsOf(activity.id).some((item) => item.entityType === binding.entityType && item.entityId === binding.entityId)) {
        throw conflict('ACTIVITY_BINDING_EXISTS', 'The activity is already bound to this record.');
      }
      if (this.policy.bindingsOf(activity.id).length >= MAX_BINDINGS) throw badRequest('ACTIVITY_BINDING_LIMIT', `An activity can have at most ${MAX_BINDINGS} bindings.`);
      const row = this.bindingRow(actor, activity, binding, this.policy.bindingsOf(activity.id).length === 0);
      this.state.crmActivityBindings.push(row);
      activity.version += 1;
      activity.updatedAt = new Date();
      this.audit(workspaceId, actor.user.id, 'ACTIVITY.BINDING_ADDED', activity.id, null, { entityType: row.entityType, entityId: row.entityId });
      this.emit(activity, 'ACTIVITY_BINDING_CHANGED', actor.user.id, { added: [{ entityType: row.entityType, entityId: row.entityId }], removed: [] });
      return { id: row.id, entityType: row.entityType, entityId: row.entityId, isPrimary: row.isPrimary };
    });
  }

  removeBinding(user: User, workspaceId: string, activityId: string, bindingId: string) {
    const actor = this.actorOf(user, workspaceId);
    return this.store.atomicSync(() => {
      const activity = this.readable(actor, activityId);
      if (!this.policy.scopeCovers(actor, 'activity.update', activity)) throw forbidden();
      if (!isOpenStatus(activity.status)) throw new AppError('ACTIVITY_EDIT_REQUIRES_REOPEN', 'Reopen the activity before changing its bindings.', 409);
      const binding = this.state.crmActivityBindings.find((item) => item.id === bindingId && item.activityId === activity.id);
      // A binding the reader cannot see must look identical to a missing one.
      if (!binding || !this.policy.canReadBinding(actor, binding)) throw new AppError('ACTIVITY_BINDING_NOT_FOUND', 'Binding was not found.', 404);
      this.state.crmActivityBindings = this.state.crmActivityBindings.filter((item) => item.id !== binding.id);
      activity.version += 1;
      activity.updatedAt = new Date();
      this.audit(workspaceId, actor.user.id, 'ACTIVITY.BINDING_REMOVED', activity.id, { entityType: binding.entityType, entityId: binding.entityId }, null);
      // Timeline keeps the historical projection; only a new "moved" style event would be added by product rules.
      this.emit(activity, 'ACTIVITY_BINDING_CHANGED', actor.user.id, { added: [], removed: [{ entityType: binding.entityType, entityId: binding.entityId }] });
      return { id: binding.id, removed: true };
    });
  }

  // ---- reminders -----------------------------------------------------------------------------------------------------------------

  listReminders(user: User, workspaceId: string, activityId: string) {
    const actor = this.actorOf(user, workspaceId);
    return this.buildDto(actor, this.readable(actor, activityId)).reminders;
  }

  createReminder(user: User, workspaceId: string, activityId: string, input: Json) {
    const actor = this.actorOf(user, workspaceId);
    return this.store.atomicSync(() => {
      const activity = this.readable(actor, activityId);
      if (!this.policy.scopeCovers(actor, 'activity.update', activity)) throw forbidden();
      if (!isOpenStatus(activity.status)) throw new AppError('ACTIVITY_EDIT_REQUIRES_REOPEN', 'Reopen the activity before adding reminders.', 409);
      const existing = this.state.crmActivityReminders.filter((item) => item.activityId === activity.id);
      if (existing.length >= MAX_REMINDERS) throw new AppError('ACTIVITY_REMINDER_INVALID', `An activity can have at most ${MAX_REMINDERS} reminders.`, 400);
      const plan = this.parseReminders(activity, [input], activity.responsibleUserId ?? null, this.participantIds(activity.id), new Date());
      this.createReminderRows(activity, plan);
      activity.version += 1;
      activity.updatedAt = new Date();
      this.audit(workspaceId, actor.user.id, 'ACTIVITY.REMINDER_ADDED', activity.id, null, { mode: plan[0].mode });
      const created = this.state.crmActivityReminders.filter((item) => item.activityId === activity.id).at(-1)!;
      return this.buildDto(actor, activity).reminders.find((item) => item.id === created.id);
    });
  }

  updateReminder(user: User, workspaceId: string, activityId: string, reminderId: string, input: Json) {
    const actor = this.actorOf(user, workspaceId);
    return this.store.atomicSync(() => {
      const activity = this.readable(actor, activityId);
      if (!this.policy.scopeCovers(actor, 'activity.update', activity)) throw forbidden();
      const reminder = this.reminder(activity, reminderId);
      if (reminder.status === 'SENT') throw new AppError('ACTIVITY_REMINDER_INVALID', 'A reminder that was already sent cannot be changed.', 409);
      const plan = this.parseReminders(activity, [input], activity.responsibleUserId ?? null, this.participantIds(activity.id), new Date(), reminder);
      const item = plan[0];
      Object.assign(reminder, {
        mode: item.mode,
        relativeTo: item.relativeTo,
        offsetSeconds: item.offsetSeconds,
        absoluteAt: item.absoluteAt,
        scheduledFor: item.scheduledFor,
        status: 'SCHEDULED',
        occurrenceKey: this.occurrenceKey(activity.id, reminder.id, item.scheduledFor),
        updatedAt: new Date(),
      });
      this.state.crmActivityReminderRecipients = this.state.crmActivityReminderRecipients.filter((recipient) => recipient.reminderId !== reminder.id);
      this.state.crmActivityReminderRecipients.push(...item.recipientUserIds.map((userId) => ({ id: this.store.id(), workspaceId, reminderId: reminder.id, userId })));
      activity.version += 1;
      activity.updatedAt = new Date();
      this.audit(workspaceId, actor.user.id, 'ACTIVITY.REMINDER_UPDATED', activity.id, null, { reminderId });
      return this.buildDto(actor, activity).reminders.find((entry) => entry.id === reminder.id);
    });
  }

  /** Removes the future reminder definition; audit history is retained. */
  deleteReminder(user: User, workspaceId: string, activityId: string, reminderId: string) {
    const actor = this.actorOf(user, workspaceId);
    return this.store.atomicSync(() => {
      const activity = this.readable(actor, activityId);
      if (!this.policy.scopeCovers(actor, 'activity.update', activity)) throw forbidden();
      const reminder = this.reminder(activity, reminderId);
      this.state.crmActivityReminders = this.state.crmActivityReminders.filter((item) => item.id !== reminder.id);
      this.state.crmActivityReminderRecipients = this.state.crmActivityReminderRecipients.filter((item) => item.reminderId !== reminder.id);
      activity.version += 1;
      activity.updatedAt = new Date();
      this.audit(workspaceId, actor.user.id, 'ACTIVITY.REMINDER_REMOVED', activity.id, { reminderId, status: reminder.status }, null);
      return { id: reminderId, removed: true };
    });
  }

  private reminder(activity: Activity, reminderId: string) {
    const reminder = this.state.crmActivityReminders.find((item) => item.id === reminderId && item.activityId === activity.id);
    if (!reminder) throw new AppError('ACTIVITY_REMINDER_NOT_FOUND', 'Reminder was not found.', 404);
    return reminder;
  }

  private occurrenceKey(activityId: string, reminderId: string, scheduledFor: Date | null) {
    return `${activityId}:${reminderId}:${scheduledFor ? scheduledFor.toISOString() : 'none'}`;
  }

  private parseReminders(
    activity: Activity,
    raw: unknown,
    responsibleUserId: string | null,
    participantIds: string[],
    now: Date,
    replacing?: ActivityReminder,
  ) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > MAX_REMINDERS) throw new AppError('ACTIVITY_REMINDER_INVALID', `reminders must be an array of at most ${MAX_REMINDERS} items.`, 400);
    const eligible = new Set([...(responsibleUserId ? [responsibleUserId] : []), ...participantIds]);
    const plan: Array<{ mode: 'RELATIVE' | 'ABSOLUTE'; relativeTo: 'START' | 'DEADLINE' | null; offsetSeconds: number | null; absoluteAt: Date | null; scheduledFor: Date; recipientUserIds: string[] }> = [];
    const invalid = (message: string) => new AppError('ACTIVITY_REMINDER_INVALID', message, 400);
    for (const item of raw as Json[]) {
      const mode = item?.mode;
      let scheduledFor: Date;
      let relativeTo: 'START' | 'DEADLINE' | null = null;
      let offsetSeconds: number | null = null;
      let absoluteAt: Date | null = null;
      if (mode === 'RELATIVE') {
        relativeTo = item.relativeTo === 'START' || item.relativeTo === 'DEADLINE' ? item.relativeTo : null;
        if (!relativeTo) throw invalid('relativeTo must be START or DEADLINE.');
        if (typeof item.offsetSeconds !== 'number' || !Number.isInteger(item.offsetSeconds) || Math.abs(item.offsetSeconds) > REMINDER_OFFSET_LIMIT) {
          throw invalid('offsetSeconds must be an integer within 30 days.');
        }
        offsetSeconds = item.offsetSeconds;
        const anchor = relativeTo === 'START' ? activity.startAt : activity.deadline;
        if (!anchor) throw invalid(`A relative reminder needs the activity ${relativeTo === 'START' ? 'start time' : 'deadline'}.`);
        scheduledFor = new Date(new Date(anchor).getTime() + offsetSeconds * 1000);
      } else if (mode === 'ABSOLUTE') {
        absoluteAt = parseInstant(item.absoluteAt, 'absoluteAt');
        if (!absoluteAt) throw invalid('absoluteAt is required for an absolute reminder.');
        scheduledFor = absoluteAt;
      } else {
        throw invalid('mode must be RELATIVE or ABSOLUTE.');
      }
      // Policy: a reminder that would already be due is rejected instead of firing an immediate surprise notification.
      if (scheduledFor.getTime() <= now.getTime()) throw invalid('The reminder time is already in the past.');
      const recipients = Array.isArray(item.recipientUserIds) && item.recipientUserIds.length > 0 ? (item.recipientUserIds as string[]) : responsibleUserId ? [responsibleUserId] : [];
      if (recipients.length === 0) throw invalid('A reminder needs at least one recipient.');
      const unique = [...new Set(recipients)];
      if (unique.some((userId) => typeof userId !== 'string' || !eligible.has(userId))) throw invalid('Reminder recipients must be the responsible user or a participant.');
      plan.push({ mode, relativeTo, offsetSeconds, absoluteAt, scheduledFor, recipientUserIds: unique });
    }
    void replacing;
    return plan;
  }

  private createReminderRows(activity: Activity, plan: ReturnType<ActivityService['parseReminders']>) {
    const now = new Date();
    for (const item of plan) {
      const id = this.store.id();
      this.state.crmActivityReminders.push({
        id,
        workspaceId: activity.workspaceId,
        activityId: activity.id,
        mode: item.mode,
        relativeTo: item.relativeTo,
        offsetSeconds: item.offsetSeconds,
        absoluteAt: item.absoluteAt,
        scheduledFor: item.scheduledFor,
        status: 'SCHEDULED',
        occurrenceKey: this.occurrenceKey(activity.id, id, item.scheduledFor),
        sentAt: null,
        createdAt: now,
        updatedAt: now,
      });
      this.state.crmActivityReminderRecipients.push(...item.recipientUserIds.map((userId) => ({ id: this.store.id(), workspaceId: activity.workspaceId, reminderId: id, userId })));
    }
  }

  private cancelPendingReminders(activityId: string) {
    for (const reminder of this.state.crmActivityReminders) {
      if (reminder.activityId === activityId && reminder.status === 'SCHEDULED') {
        reminder.status = 'CANCELLED';
        reminder.updatedAt = new Date();
      }
    }
  }

  /** Reopen/restore: only lifecycle-cancelled, never-sent reminders whose time is still ahead are scheduled again. */
  private restoreFutureReminders(activity: Activity, now: Date) {
    for (const reminder of this.state.crmActivityReminders) {
      if (reminder.activityId !== activity.id || reminder.status !== 'CANCELLED' || reminder.sentAt) continue;
      if (reminder.scheduledFor && reminder.scheduledFor.getTime() > now.getTime()) {
        reminder.status = 'SCHEDULED';
        reminder.updatedAt = now;
      }
    }
  }

  /** After a time/participant change: recompute pending fire times; reminders that end up in the past are cancelled, not fired. */
  private recomputeReminders(activity: Activity, revalidateRecipients: boolean) {
    const now = new Date();
    const eligible = new Set([...(activity.responsibleUserId ? [activity.responsibleUserId] : []), ...this.participantIds(activity.id)]);
    for (const reminder of this.state.crmActivityReminders.filter((item) => item.activityId === activity.id && item.status !== 'SENT')) {
      if (reminder.mode === 'RELATIVE') {
        const anchor = reminder.relativeTo === 'START' ? activity.startAt : activity.deadline;
        reminder.scheduledFor = anchor ? new Date(new Date(anchor).getTime() + (reminder.offsetSeconds ?? 0) * 1000) : null;
        reminder.occurrenceKey = this.occurrenceKey(activity.id, reminder.id, reminder.scheduledFor ?? null);
      }
      if (!reminder.scheduledFor || reminder.scheduledFor.getTime() <= now.getTime()) reminder.status = 'CANCELLED';
      else if (reminder.status === 'CANCELLED' && isOpenStatus(activity.status)) reminder.status = 'SCHEDULED';
      reminder.updatedAt = now;
      if (revalidateRecipients) {
        this.state.crmActivityReminderRecipients = this.state.crmActivityReminderRecipients.filter((recipient) => recipient.reminderId !== reminder.id || eligible.has(recipient.userId));
      }
    }
  }

  // ---- background jobs ---------------------------------------------------------------------------------------------------------------

  /**
   * Emits ACTIVITY_OVERDUE once per (activity, deadline occurrence). The unique occurrence row makes worker retries and
   * duplicate deliveries harmless; moving the deadline bumps deadlineVersion so a legitimate new occurrence can fire.
   */
  runOverdueSweep(at: Date = new Date()) {
    let emitted = 0;
    for (const activity of this.state.crmActivities) {
      if (activity.isDeleted || !isOpenStatus(activity.status)) continue;
      const descriptor = this.types.find(activity.workspaceId, activity.typeCode);
      const deadline = resolvedDeadline(activity, descriptor?.deadlineBasis ?? 'DEADLINE');
      if (!deadline || deadline.getTime() >= at.getTime()) continue;
      const exists = this.state.crmActivityOverdueOccurrences.some((row) => row.activityId === activity.id && row.deadlineVersion === activity.deadlineVersion);
      if (exists) continue;
      this.state.crmActivityOverdueOccurrences.push({
        id: this.store.id(),
        workspaceId: activity.workspaceId,
        activityId: activity.id,
        deadline,
        deadlineVersion: activity.deadlineVersion,
        emittedAt: at,
      });
      this.emit(activity, 'ACTIVITY_OVERDUE', null, {
        deadline: deadline.toISOString(),
        deadlineVersion: activity.deadlineVersion,
        responsibleUserId: activity.responsibleUserId ?? null,
        subject: activity.subject,
        typeCode: activity.typeCode,
      });
      emitted += 1;
    }
    return { emitted };
  }

  /** Hands due reminders to consumers via the outbox in the same transaction that marks them SENT. */
  runDueReminders(at: Date = new Date()) {
    let emitted = 0;
    for (const reminder of this.state.crmActivityReminders) {
      if (reminder.status !== 'SCHEDULED' || !reminder.scheduledFor || reminder.scheduledFor.getTime() > at.getTime()) continue;
      const activity = this.state.crmActivities.find((item) => item.id === reminder.activityId);
      if (!activity || activity.isDeleted || !isOpenStatus(activity.status)) {
        reminder.status = 'CANCELLED';
        reminder.updatedAt = at;
        continue;
      }
      const recipients = this.state.crmActivityReminderRecipients.filter((item) => item.reminderId === reminder.id).map((item) => item.userId);
      reminder.status = 'SENT';
      reminder.sentAt = at;
      reminder.updatedAt = at;
      emitDomainEvent(this.store, {
        workspaceId: activity.workspaceId,
        eventType: 'ACTIVITY_REMINDER_DUE',
        entityType: 'ACTIVITY',
        entityId: activity.id,
        changes: { reminderId: reminder.id, occurrenceKey: reminder.occurrenceKey, recipientUserIds: recipients, subject: activity.subject, deadline: activity.deadline?.toISOString() ?? null },
        idempotencyKey: reminder.occurrenceKey,
      });
      emitted += 1;
    }
    return { emitted };
  }

  // ---- provider communications (adapter for the Communication module) ---------------------------------------------------------------

  /**
   * Creates/updates the CRM Activity representation of a provider interaction. The owning integration has already
   * verified and de-duplicated the provider event; the stable (origin, externalId) pair makes retries harmless here too.
   */
  ingestProviderCommunication(workspaceId: string, input: ProviderCommunicationInput) {
    return this.store.atomicSync(() => {
      const descriptor = this.types.require(workspaceId, input.typeCode);
      const existing = this.state.crmActivities.find((item) => item.workspaceId === workspaceId && item.externalOrigin === input.origin && item.externalId === input.externalId);
      if (existing) {
        // Same provider event again: only a genuine change of the provider's own data updates the representation.
        const nextResult = input.resultText ?? existing.resultText ?? null;
        if (nextResult !== (existing.resultText ?? null)) {
          existing.resultText = nextResult;
          existing.version += 1;
          existing.updatedAt = new Date();
          this.audit(workspaceId, null, 'ACTIVITY.PROVIDER_UPDATED', existing.id, null, { origin: input.origin, externalId: input.externalId });
        }
        return { activityId: existing.id, created: false };
      }
      if (!this.access.isActiveMember(workspaceId, input.responsibleUserId)) throw new AppError('ACTIVITY_ASSIGN_FORBIDDEN', 'The responsible user is not an active workspace member.', 403);
      const bindings = (input.bindings ?? []).map((binding) => {
        if (!this.access.crmRecord(workspaceId, binding.entityType, binding.entityId)) throw new AppError('ACTIVITY_BINDING_FORBIDDEN', 'A binding target is not available in this workspace.', 403);
        return binding;
      });
      const now = new Date();
      const completed = input.planned !== true;
      const activity: Activity = {
        id: this.store.id(),
        workspaceId,
        typeCode: descriptor.code,
        customActivityTypeId: null,
        subject: input.subject.trim().slice(0, MAX_SUBJECT),
        description: null,
        status: completed ? 'COMPLETED' : 'PLANNED',
        priority: 'NORMAL',
        direction: input.direction,
        createdByUserId: null,
        responsibleUserId: input.responsibleUserId,
        startAt: input.occurredAt,
        endAt: input.endAt ?? null,
        deadline: null,
        deadlineVersion: 1,
        location: null,
        resultText: input.resultText ?? null,
        completedAt: completed ? input.occurredAt : null,
        cancelledAt: null,
        cancellationReason: null,
        reopenedAt: null,
        adapterKind: 'COMMUNICATION',
        adapterResourceId: input.externalId,
        externalOrigin: input.origin,
        externalId: input.externalId,
        fileIds: [],
        version: 1,
        isDeleted: false,
        deletedAt: null,
        deletedByUserId: null,
        createdAt: now,
        updatedAt: now,
      };
      this.state.crmActivities.push(activity);
      this.state.crmActivityBindings.push(
        ...bindings.map((binding, index) => ({
          id: this.store.id(),
          workspaceId,
          activityId: activity.id,
          entityType: binding.entityType,
          entityId: binding.entityId,
          isPrimary: index === 0,
          createdByUserId: null,
          createdAt: now,
        })),
      );
      for (const item of input.communications ?? []) {
        const normalized = normalizeCommunicationValue(item.type, item.value);
        if (!normalized) continue;
        this.state.crmActivityCommunications.push({
          id: this.store.id(),
          workspaceId,
          activityId: activity.id,
          communicationType: item.type,
          crmEntityType: item.crmEntityType ?? null,
          crmEntityId: item.crmEntityId ?? null,
          normalizedValue: normalized,
          rawDisplayValue: item.value.trim().slice(0, 500),
          label: item.label ?? null,
          isPrimary: false,
          createdAt: now,
        });
      }
      this.audit(workspaceId, null, 'ACTIVITY.PROVIDER_CREATED', activity.id, null, { origin: input.origin, externalId: input.externalId, typeCode: descriptor.code });
      this.emit(activity, 'ACTIVITY_CREATED', null, {
        typeCode: activity.typeCode,
        subject: activity.subject,
        origin: input.origin,
        externalId: input.externalId,
        provider: true,
        status: activity.status,
        responsibleUserId: activity.responsibleUserId,
        startAt: activity.startAt?.toISOString() ?? null,
      }, `provider:${input.origin}:${input.externalId}`);
      return { activityId: activity.id, created: true };
    });
  }

  // ---- parsing / validation helpers -------------------------------------------------------------------------------------------------------

  private priority(value: unknown, fallback: ActivityPriority): ActivityPriority {
    if (value === undefined || value === null) return fallback ?? 'NORMAL';
    if (!ACTIVITY_PRIORITIES.includes(value as ActivityPriority)) throw fieldValidationFailed({ priority: [{ code: 'INVALID', message: 'priority must be LOW, NORMAL or HIGH.' }] });
    return value as ActivityPriority;
  }

  private direction(value: unknown, descriptor: ActivityTypeDescriptor): ActivityDirection {
    if (value === undefined || value === null) return descriptor.defaultDirection;
    if (!ACTIVITY_DIRECTIONS.includes(value as ActivityDirection)) throw fieldValidationFailed({ direction: [{ code: 'INVALID', message: 'direction must be INCOMING, OUTGOING or NOT_APPLICABLE.' }] });
    if ((descriptor.forcesDirectionNotApplicable || !descriptor.supportsDirection) && value !== 'NOT_APPLICABLE') {
      throw fieldValidationFailed({ direction: [{ code: 'UNSUPPORTED', message: `${descriptor.label} activities have no direction.` }] });
    }
    return value as ActivityDirection;
  }

  private times(descriptor: ActivityTypeDescriptor, input: Json, existing: Activity | null) {
    const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key);
    let startAt = has('startAt') ? parseInstant(input.startAt, 'startAt') : existing?.startAt ?? null;
    let endAt = has('endAt') ? parseInstant(input.endAt, 'endAt') : existing?.endAt ?? null;
    const deadline = has('deadline') ? parseInstant(input.deadline, 'deadline') : existing?.deadline ?? null;
    if (startAt && !descriptor.allowsStart) throw timeInvalid(`${descriptor.label} activities do not use a start time.`);
    if (endAt && !descriptor.allowsEnd) throw timeInvalid(`${descriptor.label} activities do not use an end time.`);
    if (deadline && !descriptor.allowsDeadline) throw timeInvalid(`${descriptor.label} activities do not use a deadline.`);
    // Custom-type defaults seed the form but never override an explicit value.
    if (!existing && startAt && !endAt && descriptor.defaultDurationMinutes && !has('endAt')) {
      endAt = new Date(startAt.getTime() + descriptor.defaultDurationMinutes * 60_000);
    }
    if (startAt && endAt && endAt.getTime() < startAt.getTime()) throw timeInvalid('endAt must not be before startAt.');
    if (descriptor.requiresStart && !startAt) throw timeInvalid(`${descriptor.label} activities require startAt.`);
    if (descriptor.requiresEnd && !endAt) throw timeInvalid(`${descriptor.label} activities require endAt.`);
    if (descriptor.requiresDeadline && !deadline) throw timeInvalid(`${descriptor.label} activities require a deadline.`);
    startAt = startAt ?? null;
    return { startAt, endAt: endAt ?? null, deadline };
  }

  private timeChanged(a: Date | null | undefined, b: Date | null | undefined) {
    return (a ? new Date(a).getTime() : null) !== (b ? new Date(b).getTime() : null);
  }

  private responsible(actor: ActorContext, value: unknown): string | null {
    if (value === undefined || value === null) return actor.user.id;
    if (typeof value !== 'string') throw fieldValidationFailed({ responsibleUserId: [{ code: 'INVALID_TYPE', message: 'responsibleUserId must be a user id.' }] });
    if (value === actor.user.id) return value;
    if (!this.policy.canAssignTo(actor, value)) throw new AppError('ACTIVITY_ASSIGN_FORBIDDEN', 'You are not allowed to assign this activity to that user.', 403);
    return value;
  }

  private parseBindings(actor: ActorContext, raw: unknown): Array<{ entityType: string; entityId: string }> {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > MAX_BINDINGS) throw badRequest('ACTIVITY_BINDING_INVALID', `bindings must be an array of at most ${MAX_BINDINGS} items.`);
    const seen = new Set<string>();
    const out: Array<{ entityType: string; entityId: string }> = [];
    for (const item of raw as Json[]) {
      const entityType = typeof item?.entityType === 'string' ? item.entityType.toUpperCase() : '';
      const entityId = typeof item?.entityId === 'string' ? item.entityId : '';
      // Missing, foreign-workspace and unreadable records all fail identically so nothing about them is disclosed.
      if (!['LEAD', 'CONTACT', 'COMPANY', 'DEAL'].includes(entityType) || !entityId || !this.access.canAccessCrmRecord(actor, entityType, entityId, 'read')) {
        throw new AppError('ACTIVITY_BINDING_FORBIDDEN', 'You are not allowed to bind this activity to the requested record.', 403);
      }
      const key = `${entityType}:${entityId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ entityType, entityId });
    }
    return out;
  }

  private parseParticipants(actor: ActorContext, descriptor: ActivityTypeDescriptor, raw: unknown, responsibleUserId: string | null): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > MAX_PARTICIPANTS) throw badRequest('ACTIVITY_PARTICIPANT_INVALID', `participants must be an array of at most ${MAX_PARTICIPANTS} user ids.`);
    if (raw.length > 0 && !descriptor.supportsParticipants) throw fieldValidationFailed({ participants: [{ code: 'UNSUPPORTED', message: `${descriptor.label} activities do not have participants.` }] });
    const ids = [...new Set((raw as unknown[]).map((entry) => (typeof entry === 'string' ? entry : (entry as { userId?: string })?.userId)))];
    for (const id of ids) {
      if (typeof id !== 'string' || !this.access.isActiveMember(actor.workspaceId, id)) {
        throw new AppError('ACTIVITY_PARTICIPANT_INVALID', 'Every participant must be an active member of this workspace.', 400);
      }
    }
    // The responsible user is never duplicated as a participant.
    return (ids as string[]).filter((id) => id !== responsibleUserId);
  }

  private parseCommunications(actor: ActorContext, descriptor: ActivityTypeDescriptor, raw: unknown) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > MAX_COMMUNICATIONS) throw badRequest('ACTIVITY_COMMUNICATION_INVALID', `communications must be an array of at most ${MAX_COMMUNICATIONS} items.`);
    if (raw.length > 0 && !descriptor.supportsCommunications) throw fieldValidationFailed({ communications: [{ code: 'UNSUPPORTED', message: `${descriptor.label} activities do not have customer communications.` }] });
    return (raw as Json[]).map((item, index) => {
      const type = item?.type as ActivityCommunicationType;
      if (!COMMUNICATION_TYPES.includes(type)) throw fieldValidationFailed({ [`communications[${index}].type`]: [{ code: 'INVALID', message: 'type must be PHONE, EMAIL, MESSENGER or OTHER.' }] });
      const value = typeof item.value === 'string' ? item.value : '';
      const normalized = normalizeCommunicationValue(type, value);
      if (!normalized) throw fieldValidationFailed({ [`communications[${index}].value`]: [{ code: 'INVALID', message: `A valid ${type.toLowerCase()} value is required.` }] });
      let crmEntityType: string | null = null;
      let crmEntityId: string | null = null;
      if (item.crmEntityType !== undefined || item.crmEntityId !== undefined) {
        crmEntityType = typeof item.crmEntityType === 'string' ? item.crmEntityType.toUpperCase() : '';
        crmEntityId = typeof item.crmEntityId === 'string' ? item.crmEntityId : '';
        if (!this.access.canAccessCrmRecord(actor, crmEntityType, crmEntityId, 'read')) {
          throw new AppError('ACTIVITY_BINDING_FORBIDDEN', 'You are not allowed to reference that record.', 403);
        }
      }
      return {
        type,
        crmEntityType,
        crmEntityId,
        // Both the CRM reference and the value used at the time are kept, so later Contact edits never rewrite history.
        normalizedValue: normalized,
        rawDisplayValue: value.trim().slice(0, 500),
        label: typeof item.label === 'string' ? item.label.trim().slice(0, 100) || null : null,
        isPrimary: item.isPrimary === true,
      };
    });
  }

  private parseFiles(actor: ActorContext, descriptor: ActivityTypeDescriptor, raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > MAX_FILES || raw.some((id) => typeof id !== 'string')) throw badRequest('ACTIVITY_FILE_INVALID', `fileIds must be an array of at most ${MAX_FILES} file ids.`);
    if (raw.length > 0 && !descriptor.supportsFiles) throw fieldValidationFailed({ fileIds: [{ code: 'UNSUPPORTED', message: `${descriptor.label} activities do not support files.` }] });
    const ids = [...new Set((raw as string[]).map((id) => id.toLowerCase()))];
    for (const id of ids) {
      const check = this.files().check(actor.workspaceId, actor, id);
      if (check === 'UNAVAILABLE') throw new AppError('FILES_UNAVAILABLE', 'File attachments are not available yet.', 400);
      if (check !== 'OK') throw new AppError('FIELD_REFERENCE_INVALID', 'A referenced file is not available.', 400);
    }
    return ids;
  }

  private participantIds(activityId: string) {
    return this.state.crmActivityParticipants.filter((item) => item.activityId === activityId).map((item) => item.userId);
  }

  private bindingRow(actor: ActorContext, activity: Activity, binding: { entityType: string; entityId: string }, isPrimary: boolean): ActivityBinding {
    return {
      id: this.store.id(),
      workspaceId: activity.workspaceId,
      activityId: activity.id,
      entityType: binding.entityType,
      entityId: binding.entityId,
      isPrimary,
      createdByUserId: actor.user.id,
      createdAt: new Date(),
    };
  }

  private participantRow(workspaceId: string, activityId: string, userId: string, role: ActivityParticipant['role']): ActivityParticipant {
    return { id: this.store.id(), workspaceId, activityId, userId, role, createdAt: new Date() };
  }

  private communicationRow(workspaceId: string, activityId: string, item: ReturnType<ActivityService['parseCommunications']>[number]): ActivityCommunication {
    return {
      id: this.store.id(),
      workspaceId,
      activityId,
      communicationType: item.type,
      crmEntityType: item.crmEntityType,
      crmEntityId: item.crmEntityId,
      normalizedValue: item.normalizedValue,
      rawDisplayValue: item.rawDisplayValue,
      label: item.label,
      isPrimary: item.isPrimary,
      createdAt: new Date(),
    };
  }

  private systemState(activity: Activity) {
    return {
      subject: activity.subject,
      description: activity.description ?? null,
      priority: activity.priority,
      direction: activity.direction,
      startAt: activity.startAt ?? null,
      endAt: activity.endAt ?? null,
      deadline: activity.deadline ?? null,
      location: activity.location ?? null,
      responsibleUserId: activity.responsibleUserId ?? null,
    };
  }

  private auditShape(activity: Activity) {
    return {
      id: activity.id,
      typeCode: activity.typeCode,
      subject: activity.subject,
      status: activity.status,
      priority: activity.priority,
      responsibleUserId: activity.responsibleUserId ?? null,
      startAt: activity.startAt?.toISOString() ?? null,
      endAt: activity.endAt?.toISOString() ?? null,
      deadline: activity.deadline?.toISOString() ?? null,
      isDeleted: activity.isDeleted,
      version: activity.version,
    };
  }

  /** Writes the outbox event and queues an advisory realtime hint for readers of the Activity. */
  private emit(activity: Activity, eventType: string, actorUserId: string | null, changes: Json, idempotencyKey?: string) {
    const bindings = this.policy.bindingsOf(activity.id).map((binding) => ({ entityType: binding.entityType, entityId: binding.entityId }));
    emitDomainEvent(this.store, {
      workspaceId: activity.workspaceId,
      eventType,
      entityType: 'ACTIVITY',
      entityId: activity.id,
      actorUserId,
      changes: { ...changes, bindings, version: activity.version },
      idempotencyKey: idempotencyKey ?? null,
    });
    this.realtime.enqueue({
      type: eventType,
      workspaceId: activity.workspaceId,
      data: { activityId: activity.id, version: activity.version },
      audienceUserIds: this.readers(activity),
    });
  }

  private readers(activity: Activity): string[] {
    const readers: string[] = [];
    for (const userId of this.access.activeMemberIds(activity.workspaceId)) {
      const actor = this.safeActor(activity.workspaceId, userId);
      if (actor && this.policy.canRead(actor, activity)) readers.push(userId);
    }
    return readers;
  }

  private safeActor(workspaceId: string, userId: string): ActorContext | null {
    const user = this.state.users.find((item) => item.id === userId && !item.isDeleted);
    if (!user) return null;
    try {
      return this.access.actor(user, workspaceId);
    } catch {
      return null;
    }
  }

}

export { fingerprint };
