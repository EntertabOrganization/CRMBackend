import type { ActorContext } from '../access-service';
import type { AccessService } from '../access-service';
import type { User } from '../domain';
import { AppError, badRequest, conflict, fieldValidationFailed } from '../errors';
import { emitDomainEvent } from '../events';
import { AuditService } from '../audit-service';
import type { InMemoryStore } from '../store';
import type { ActivityDirection, ActivityPriority, ActivityType } from './types';
import { ACTIVITY_DIRECTIONS, ACTIVITY_PRIORITIES } from './types';

export type ActivityAdapterKind = 'CALENDAR' | 'TASKS' | 'COMMUNICATION' | 'FILES';

export type ActivityTypeDescriptor = {
  code: string;
  label: string;
  builtIn: boolean;
  customActivityTypeId: string | null;
  enabled: boolean;
  supportsDirection: boolean;
  supportsParticipants: boolean;
  supportsCommunications: boolean;
  supportsLocation: boolean;
  supportsFiles: boolean;
  supportsResult: boolean;
  timingPolicy: 'DEADLINE' | 'START_END' | 'FLEXIBLE';
  /** Which timestamps the type accepts. */
  allowsStart: boolean;
  allowsEnd: boolean;
  allowsDeadline: boolean;
  requiresStart: boolean;
  requiresEnd: boolean;
  requiresDeadline: boolean;
  /** Overdue basis, centralized here: DEADLINE only, or the scheduled end/start when no deadline was set. */
  deadlineBasis: 'DEADLINE' | 'SCHEDULE';
  defaultDirection: ActivityDirection;
  defaultPriority: ActivityPriority;
  defaultDurationMinutes: number | null;
  /** When true the type must use NOT_APPLICABLE direction whatever the caller sends. */
  forcesDirectionNotApplicable: boolean;
  adapterKind?: ActivityAdapterKind;
  icon?: string | null;
  colorToken?: string | null;
};

const base = (overrides: Partial<ActivityTypeDescriptor> & Pick<ActivityTypeDescriptor, 'code' | 'label'>): ActivityTypeDescriptor => ({
  builtIn: true,
  customActivityTypeId: null,
  enabled: true,
  supportsDirection: false,
  supportsParticipants: true,
  supportsCommunications: false,
  supportsLocation: false,
  supportsFiles: true,
  supportsResult: true,
  timingPolicy: 'FLEXIBLE',
  allowsStart: true,
  allowsEnd: true,
  allowsDeadline: true,
  requiresStart: false,
  requiresEnd: false,
  requiresDeadline: false,
  deadlineBasis: 'DEADLINE',
  defaultDirection: 'NOT_APPLICABLE',
  defaultPriority: 'NORMAL',
  defaultDurationMinutes: null,
  forcesDirectionNotApplicable: false,
  ...overrides,
});

/** Built-in Activity concepts. REMINDER is deliberately absent: reminders are schedules on Activities (use FOLLOW_UP). */
export const BUILT_IN_ACTIVITY_TYPES: ActivityTypeDescriptor[] = [
  base({ code: 'CALL', label: 'Call', supportsDirection: true, supportsCommunications: true, deadlineBasis: 'SCHEDULE', defaultDirection: 'OUTGOING' }),
  base({
    code: 'MEETING',
    label: 'Meeting',
    supportsLocation: true,
    timingPolicy: 'START_END',
    requiresStart: true,
    requiresEnd: true,
    deadlineBasis: 'SCHEDULE',
    forcesDirectionNotApplicable: true,
    adapterKind: 'CALENDAR',
    defaultDurationMinutes: 60,
  }),
  base({ code: 'EMAIL', label: 'Email', supportsDirection: true, supportsCommunications: true, deadlineBasis: 'SCHEDULE', defaultDirection: 'OUTGOING', adapterKind: 'COMMUNICATION' }),
  base({ code: 'MESSAGE', label: 'Message', supportsDirection: true, supportsCommunications: true, deadlineBasis: 'SCHEDULE', defaultDirection: 'OUTGOING', adapterKind: 'COMMUNICATION' }),
  base({ code: 'FOLLOW_UP', label: 'Follow-up', timingPolicy: 'DEADLINE', supportsParticipants: true }),
  base({ code: 'TASK', label: 'Task', timingPolicy: 'DEADLINE', adapterKind: 'TASKS' }),
  base({ code: 'DOCUMENT', label: 'Document', timingPolicy: 'FLEXIBLE', supportsResult: false, supportsFiles: true, adapterKind: 'FILES' }),
];

export const BUILT_IN_CODES = new Set(BUILT_IN_ACTIVITY_TYPES.map((type) => type.code));
export const RESERVED_CODES = new Set([...BUILT_IN_CODES, 'REMINDER', 'CUSTOM']);
const TYPE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,49}$/;
const ICON_PATTERN = /^[a-z0-9-]{1,40}$/;
const COLOR_TOKEN_PATTERN = /^[a-z0-9-]{1,40}$/;

export function customTypeDescriptor(type: ActivityType): ActivityTypeDescriptor {
  return base({
    code: type.code,
    label: type.name,
    builtIn: false,
    customActivityTypeId: type.id,
    enabled: type.enabled,
    supportsDirection: true,
    supportsCommunications: true,
    supportsLocation: true,
    deadlineBasis: 'SCHEDULE',
    defaultDirection: type.defaultDirection,
    defaultPriority: type.defaultPriority,
    defaultDurationMinutes: type.defaultDurationMinutes ?? null,
    icon: type.icon ?? null,
    colorToken: type.colorToken ?? null,
  });
}

/** Registry over built-in + workspace custom types so validation is data-driven rather than a giant switch. */
export class ActivityTypeRegistry {
  constructor(private readonly store: InMemoryStore) {}

  list(workspaceId: string): ActivityTypeDescriptor[] {
    const custom = this.store.state.crmActivityTypes.filter((type) => type.workspaceId === workspaceId).map(customTypeDescriptor);
    return [...BUILT_IN_ACTIVITY_TYPES.map((descriptor) => ({ ...descriptor })), ...custom];
  }

  find(workspaceId: string, code: string): ActivityTypeDescriptor | undefined {
    return this.list(workspaceId).find((descriptor) => descriptor.code === code);
  }

  require(workspaceId: string, code: unknown): ActivityTypeDescriptor {
    const descriptor = typeof code === 'string' ? this.find(workspaceId, code) : undefined;
    if (!descriptor) throw new AppError('ACTIVITY_TYPE_NOT_FOUND', 'Activity type was not found.', 404);
    return descriptor;
  }
}

type TypeInput = {
  code?: string;
  name?: string;
  icon?: string | null;
  colorToken?: string | null;
  defaultDurationMinutes?: number | null;
  defaultPriority?: string;
  defaultDirection?: string;
  enabled?: boolean;
  version?: number;
};

/** Workspace-defined custom Activity types (requires activity.manage_types). Provider/app types are owned-app scoped. */
export class ActivityTypeService {
  constructor(
    private readonly store: InMemoryStore,
    private readonly access: AccessService,
    private readonly registry: ActivityTypeRegistry,
    private readonly onChange: (workspaceId: string) => void = () => undefined,
  ) {}

  private manageActor(user: User, workspaceId: string): ActorContext {
    const actor = this.access.actor(user, workspaceId);
    this.access.requireWorkspaceScope(actor, 'activity.manage_types');
    return actor;
  }

  private audit(workspaceId: string, actorUserId: string, action: string, id: string, before: unknown, after: unknown) {
    new AuditService(this.store).write({ workspaceId, actorUserId, action, entityType: 'CrmActivityType', entityId: id, beforeData: before, afterData: after });
  }

  private validate(input: TypeInput, existing?: ActivityType) {
    const violations: Record<string, { code: string; message: string }[]> = {};
    const add = (key: string, message: string) => (violations[key] ??= []).push({ code: 'INVALID', message });
    const name = input.name !== undefined ? (typeof input.name === 'string' ? input.name.trim() : '') : existing?.name ?? '';
    if (!name || name.length > 100) add('name', 'name is required (max 100 characters).');
    // Only approved identifiers are accepted: never raw SVG/markup.
    if (input.icon !== undefined && input.icon !== null && (typeof input.icon !== 'string' || !ICON_PATTERN.test(input.icon))) add('icon', 'icon must be an approved icon identifier.');
    if (input.colorToken !== undefined && input.colorToken !== null && (typeof input.colorToken !== 'string' || !COLOR_TOKEN_PATTERN.test(input.colorToken))) add('colorToken', 'colorToken must be a design-system token.');
    if (input.defaultDurationMinutes !== undefined && input.defaultDurationMinutes !== null && (!Number.isInteger(input.defaultDurationMinutes) || input.defaultDurationMinutes < 1 || input.defaultDurationMinutes > 1440)) {
      add('defaultDurationMinutes', 'defaultDurationMinutes must be between 1 and 1440.');
    }
    const priority = input.defaultPriority ?? existing?.defaultPriority ?? 'NORMAL';
    if (!ACTIVITY_PRIORITIES.includes(priority as ActivityPriority)) add('defaultPriority', 'defaultPriority must be LOW, NORMAL or HIGH.');
    const direction = input.defaultDirection ?? existing?.defaultDirection ?? 'NOT_APPLICABLE';
    if (!ACTIVITY_DIRECTIONS.includes(direction as ActivityDirection)) add('defaultDirection', 'defaultDirection must be INCOMING, OUTGOING or NOT_APPLICABLE.');
    if (Object.keys(violations).length > 0) throw fieldValidationFailed(violations);
    return { name, priority: priority as ActivityPriority, direction: direction as ActivityDirection };
  }

  create(user: User, workspaceId: string, input: TypeInput) {
    const actor = this.manageActor(user, workspaceId);
    return this.store.atomicSync(() => {
      const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
      if (!TYPE_CODE_PATTERN.test(code)) throw fieldValidationFailed({ code: [{ code: 'INVALID', message: 'code must be UPPER_SNAKE_CASE (2-50 characters).' }] });
      if (RESERVED_CODES.has(code)) throw conflict('ACTIVITY_TYPE_CODE_CONFLICT', 'This code is reserved for a built-in Activity type.');
      if (this.store.state.crmActivityTypes.some((type) => type.workspaceId === workspaceId && type.code === code)) {
        throw conflict('ACTIVITY_TYPE_CODE_CONFLICT', 'An Activity type with this code already exists.');
      }
      const { name, priority, direction } = this.validate(input);
      const now = new Date();
      const type: ActivityType = {
        id: this.store.id(),
        workspaceId,
        code,
        name,
        icon: input.icon ?? null,
        colorToken: input.colorToken ?? null,
        defaultDurationMinutes: input.defaultDurationMinutes ?? null,
        defaultPriority: priority,
        defaultDirection: direction,
        enabled: input.enabled !== false,
        ownerApp: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.store.state.crmActivityTypes.push(type);
      this.audit(workspaceId, actor.user.id, 'ACTIVITY_TYPE.CREATED', type.id, null, type);
      emitDomainEvent(this.store, { workspaceId, eventType: 'ACTIVITY_TYPE_CHANGED', entityType: 'ACTIVITY_TYPE', entityId: type.id, actorUserId: actor.user.id, changes: { code, change: 'CREATED' } });
      this.onChange(workspaceId);
      return type;
    });
  }

  /** Built-in types are listed for pickers but are immutable. */
  list(user: User, workspaceId: string) {
    const actor = this.access.actor(user, workspaceId);
    const usage = new Map<string, number>();
    for (const activity of this.store.state.crmActivities) {
      if (activity.workspaceId === workspaceId) usage.set(activity.typeCode, (usage.get(activity.typeCode) ?? 0) + 1);
    }
    const fieldCounts = new Map<string, number>();
    for (const field of this.store.state.crmCustomFields) {
      if (field.workspaceId === workspaceId && field.entityType === 'ACTIVITY' && field.activityTypeId) {
        fieldCounts.set(field.activityTypeId, (fieldCounts.get(field.activityTypeId) ?? 0) + 1);
      }
    }
    const manage = this.access.scopeFor(actor, 'activity.manage_types') === 'WORKSPACE';
    return this.registry
      .list(workspaceId)
      // Disabled custom types stay visible to type managers only; everyone can still resolve them on historical Activities.
      .filter((descriptor) => descriptor.builtIn || descriptor.enabled || manage)
      .map((descriptor) => ({
        ...descriptor,
        id: descriptor.customActivityTypeId,
        // Optimistic-concurrency token the type editor sends back with an update / enable / disable.
        version: descriptor.customActivityTypeId ? this.store.state.crmActivityTypes.find((type) => type.id === descriptor.customActivityTypeId)?.version : undefined,
        activityCount: usage.get(descriptor.code) ?? 0,
        customFieldCount: descriptor.customActivityTypeId ? fieldCounts.get(descriptor.customActivityTypeId) ?? 0 : 0,
      }));
  }

  get(user: User, workspaceId: string, typeId: string) {
    this.access.actor(user, workspaceId);
    return this.custom(workspaceId, typeId);
  }

  update(user: User, workspaceId: string, typeId: string, input: TypeInput) {
    const actor = this.manageActor(user, workspaceId);
    return this.store.atomicSync(() => {
      const type = this.custom(workspaceId, typeId);
      if (typeof input.version !== 'number') throw new AppError('CONFIGURATION_VERSION_REQUIRED', 'The current type version is required.', 400);
      if (input.version !== type.version) throw conflict('CONFIGURATION_VERSION_CONFLICT', 'The Activity type changed after you loaded it.', { currentVersion: type.version });
      if (input.code !== undefined && input.code !== type.code) throw badRequest('ACTIVITY_TYPE_CODE_IMMUTABLE', 'code cannot be changed after creation.');
      const { name, priority, direction } = this.validate(input, type);
      const before = { ...type };
      Object.assign(type, {
        name,
        icon: input.icon !== undefined ? input.icon : type.icon,
        colorToken: input.colorToken !== undefined ? input.colorToken : type.colorToken,
        defaultDurationMinutes: input.defaultDurationMinutes !== undefined ? input.defaultDurationMinutes : type.defaultDurationMinutes,
        defaultPriority: priority,
        defaultDirection: direction,
        version: type.version + 1,
        updatedAt: new Date(),
      });
      this.audit(workspaceId, actor.user.id, 'ACTIVITY_TYPE.UPDATED', type.id, before, type);
      emitDomainEvent(this.store, { workspaceId, eventType: 'ACTIVITY_TYPE_CHANGED', entityType: 'ACTIVITY_TYPE', entityId: type.id, actorUserId: actor.user.id, changes: { code: type.code, change: 'UPDATED' } });
      this.onChange(workspaceId);
      return type;
    });
  }

  /** Disabling blocks NEW Activities of the type; historical Activities are untouched. */
  setEnabled(user: User, workspaceId: string, typeId: string, enabled: boolean) {
    const actor = this.manageActor(user, workspaceId);
    return this.store.atomicSync(() => {
      const type = this.custom(workspaceId, typeId);
      if (type.enabled !== enabled) {
        type.enabled = enabled;
        type.version += 1;
        type.updatedAt = new Date();
        this.audit(workspaceId, actor.user.id, enabled ? 'ACTIVITY_TYPE.ENABLED' : 'ACTIVITY_TYPE.DISABLED', type.id, { enabled: !enabled }, { enabled });
        emitDomainEvent(this.store, { workspaceId, eventType: 'ACTIVITY_TYPE_CHANGED', entityType: 'ACTIVITY_TYPE', entityId: type.id, actorUserId: actor.user.id, changes: { code: type.code, change: enabled ? 'ENABLED' : 'DISABLED' } });
        this.onChange(workspaceId);
      }
      return type;
    });
  }

  private custom(workspaceId: string, typeId: string): ActivityType {
    const type = this.store.state.crmActivityTypes.find((item) => item.id === typeId && item.workspaceId === workspaceId);
    // Built-in types have no row, so they cannot be reached through the custom-type endpoints.
    if (!type) throw new AppError('ACTIVITY_TYPE_NOT_FOUND', 'Activity type was not found.', 404);
    return type;
  }
}
