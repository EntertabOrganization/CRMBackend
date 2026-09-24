import type { ActorContext } from '../access-service';
import type { FieldCapableEntityAdapter, SystemFieldDescriptor } from '../fields/entity-registry';
import type { InMemoryStore } from '../store';
import type { ActivityAccessPolicy } from './activity-access';
import type { Activity } from './types';
import type { AccessService } from '../access-service';

const field = (key: string, label: string, dataType: SystemFieldDescriptor['dataType'], overrides: Partial<SystemFieldDescriptor> = {}): SystemFieldDescriptor => ({
  key,
  label,
  dataType,
  requirementCapable: true,
  conditionCapable: true,
  editable: true,
  ...overrides,
});

/** Registers Activities with the custom-field engine exactly like any other field-capable entity. */
export class ActivityFieldEntityAdapter implements FieldCapableEntityAdapter {
  readonly entityType = 'ACTIVITY';
  readonly label = 'Activity';
  readonly supportsPipeline = false;

  constructor(
    private readonly store: InMemoryStore,
    private readonly policy: ActivityAccessPolicy,
    private readonly access: AccessService,
  ) {}

  systemFields(): SystemFieldDescriptor[] {
    return [
      field('subject', 'Subject', 'TEXT', { requirementCapable: false }),
      field('description', 'Description', 'TEXT'),
      field('priority', 'Priority', 'ENUM'),
      field('direction', 'Direction', 'ENUM'),
      field('startAt', 'Start', 'DATETIME'),
      field('endAt', 'End', 'DATETIME'),
      field('deadline', 'Deadline', 'DATETIME'),
      field('location', 'Location', 'TEXT'),
      field('responsibleUserId', 'Responsible user', 'ENUM', { requirementCapable: false, editable: false }),
    ];
  }

  systemValues(record: unknown): Record<string, unknown> {
    const source = record as Record<string, unknown>;
    return Object.fromEntries(this.systemFields().map((descriptor) => [descriptor.key, source[descriptor.key]]));
  }

  findRecord(workspaceId: string, entityId: string): Activity | undefined {
    return this.store.state.crmActivities.find((item) => item.id === entityId && item.workspaceId === workspaceId && !item.isDeleted);
  }

  canRead(actor: ActorContext, entityId: string) {
    const activity = this.findRecord(actor.workspaceId, entityId);
    return Boolean(activity && this.policy.canRead(actor, activity));
  }

  canUpdate(actor: ActorContext, entityId: string) {
    const activity = this.findRecord(actor.workspaceId, entityId);
    return Boolean(activity && this.policy.canDo(actor, 'activity.update', activity));
  }

  canCreate(actor: ActorContext) {
    return this.access.scopeFor(actor, 'activity.create') !== null;
  }
}
