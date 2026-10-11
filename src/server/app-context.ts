import { AccessService } from './access-service';
import { ActivityFieldEntityAdapter } from './activities/activity-field-adapter';
import { ActivityService } from './activities/activity-service';
import { ActivityTypeRegistry, ActivityTypeService } from './activities/activity-types';
import { ActivityAdapterRegistry } from './activities/adapters';
import { TimelineService } from './activities/timeline-service';
import { AuthService } from './auth-service';
import { AuditService } from './audit-service';
import { AutomationModule } from './automation';
import { CatalogModule } from './catalog';
import { CrmCoreService } from './crm-core-service';
import { CrmPipelineService } from './crm-pipeline-service';
import { DepartmentService } from './department-service';
import { createCrmFieldEntityRegistry } from './fields/entity-registry';
import { FieldEngine } from './fields/field-engine';
import { PartnerService } from './partner-service';
import { UnconfiguredFilePort } from './ports';
import type { FilePort, NotificationPort } from './ports';
import { FakeGoogleAuthProvider, MemoryMailService } from './providers';
import { RealtimeHub } from './realtime';
import { RoleService } from './role-service';
import { InMemoryStore } from './store';
import { UserService } from './user-service';
import { WorkspaceService } from './workspace-service';
import { CommercialCaptureContactCenterModule } from './commercial';
import { DataIntegrationIntelligenceAnalyticsModule } from './intelligence';
import { CollaborationModule } from './collab';
import type { TemplateValue } from './collab/files/document-render';
import { NotificationService } from './notifications/service';
import { BookingNotificationDelivery } from './collab/calendar/booking-notification-delivery';
import { prisma } from './prisma-client';

function createAppContext() {
  const store = new InMemoryStore();
  const mailer = new MemoryMailService();
  const google = new FakeGoogleAuthProvider();
  const realtime = new RealtimeHub();
  const access = new AccessService(store);
  const registry = createCrmFieldEntityRegistry(store, access);
  const notifications = new NotificationService(prisma);
  const ports = { files: new UnconfiguredFilePort() as FilePort, notifications: notifications as NotificationPort | null };
  const bookingNotifications = new BookingNotificationDelivery(prisma, () => ports.notifications);
  const fields = new FieldEngine({ store, access, registry, realtime, files: ports.files });
  const activityTypes = new ActivityTypeRegistry(store);
  const adapters = new ActivityAdapterRegistry();
  const activities = new ActivityService(store, access, activityTypes, fields, adapters, realtime, () => ports.files);
  registry.register(new ActivityFieldEntityAdapter(store, activities.policy, access));
  const timeline = new TimelineService(store, access, registry, activities.policy, realtime, () => ports.files);
  const activityTypeAdmin = new ActivityTypeService(store, access, activityTypes, (workspaceId) => {
    realtime.enqueue({ type: 'ACTIVITY_TYPE_CHANGED', workspaceId, data: {} });
  });
  const crmCore = new CrmCoreService(store, fields);
  const catalog = new CatalogModule({ store, access, realtime, fields, registry, crmCore, files: () => ports.files });
  const crm = new CrmPipelineService(store, undefined, fields);
  const automation = new AutomationModule({ store, access, realtime, fields, registry, crm, crmCore, activities });
  automation.setNotificationPort(notifications);
  const commercialPack = new CommercialCaptureContactCenterModule({ store, access, crmCore, crm });
  const intelligence = new DataIntegrationIntelligenceAnalyticsModule({ store, access, crmCore });
  const collab = new CollaborationModule({ store, access, realtime, files: () => ports.files, notifications: () => ports.notifications });
  for (const adapter of registry.list()) collab.attachments.register({ entityType: adapter.entityType,
    exists: (workspaceId, id) => Boolean(adapter.findRecord(workspaceId, id)), authorize: (actor, id, write) => {
    if (!adapter.findRecord(actor.workspaceId, id) || !adapter.canRead(actor, id) || write && !adapter.canUpdate(actor, id))
      throw new Error('Owning module denied attachment access');
  } });
  // Document generation reads CRM records only through their field adapters: record access plus field-visibility rules.
  for (const adapter of registry.list()) collab.documents.templates.registerContext({ entityType: adapter.entityType, supportsCustomFields: true,
    fields: ['id', ...adapter.systemFields().map(field => field.key)], read: (actor, id) => {
    const record = adapter.findRecord(actor.workspaceId, id);
    if (!record || !adapter.canRead(actor, id)) throw new Error('Owning module denied document access');
    return { fields: { id, ...adapter.systemValues(record) } as Record<string, TemplateValue>,
      customFields: fields.decorate(actor, adapter.entityType, [{ id }])[0].customFields as Record<string, TemplateValue> };
  } });
  ports.files = collab.attachments;
  fields.setFilePort(ports.files);
  collab.attachments.registerLegacyTargets((workspaceId, fileId) => [
    ...store.state.crmActivities.filter(row => row.workspaceId === workspaceId && row.fileIds.includes(fileId)).map(row => ({ entityType: 'ACTIVITY', entityId: row.id })),
    ...store.state.crmTimelineComments.filter(row => row.workspaceId === workspaceId && row.fileIds.includes(fileId)).map(row => ({ entityType: row.entityType, entityId: row.entityId })),
    ...store.state.catalogProductMedia.filter(row => row.workspaceId === workspaceId && row.fileId === fileId).map(row => ({ entityType: 'PRODUCT', entityId: row.productId })),
    ...store.state.crmCustomFieldValues.filter(row => row.workspaceId === workspaceId && row.valueUuid === fileId &&
      store.state.crmCustomFields.some(field => field.id === row.fieldId && field.fieldType === 'FILE')).map(row => ({ entityType: row.entityType, entityId: row.entityId })),
  ]);
  collab.router.get('notifications', async (r) => {
    const { listed } = await import('./collab/http');
    return listed(await notifications.list(r.actor, r.query));
  }).post('notifications/:id/read', (r) => { r.body.only([]); return notifications.read(r.actor, r.params.id); })
    .get('notification-preferences', (r) => notifications.preferences(r.actor))
    .put('notification-preferences', (r) => notifications.setPreference(r.actor, r.body));
  collab.calendar.events.registerBindingResolver({ entityType: 'ACTIVITY', canBind: (actor, id) => {
    const activity = store.state.crmActivities.find((row) => row.id === id && !row.isDeleted);
    return Boolean(activity && activities.policy.canRead(actor, activity));
  } });
  return {
    store,
    notifications,
    bookingNotifications,
    collab,
    catalog,
    automation,
    commercialPack,
    intelligence,
    mailer,
    google,
    realtime,
    access,
    registry,
    fields,
    adapters,
    activityTypes,
    activityTypeAdmin,
    activities,
    timeline,
    /** Override the real Files authority adapter (for an alternate owning provider or deterministic tests). */
    setFilePort(port: FilePort) {
      ports.files = port;
      fields.setFilePort(port);
    },
    setNotificationPort(port: NotificationPort | null) {
      ports.notifications = port;
      automation.setNotificationPort(port);
    },
    auth: new AuthService(store, mailer, google),
    audit: new AuditService(store),
    users: new UserService(store, mailer),
    workspaces: new WorkspaceService(store),
    roles: new RoleService(store),
    departments: new DepartmentService(store, (workspaceId, departmentId, actorUserId) => collab.communication.chats.departmentChanged(workspaceId, departmentId, actorUserId)),
    partners: new PartnerService(store),
    crmCore,
    crm,
  };
}

type AppContext = ReturnType<typeof createAppContext>;

const globalState = globalThis as typeof globalThis & {
  __trueAgentAppContext?: AppContext;
};

export const appContext = globalState.__trueAgentAppContext ??= createAppContext();

export function resetAppContextForTests() {
  globalState.__trueAgentAppContext = createAppContext();
  return globalState.__trueAgentAppContext;
}
