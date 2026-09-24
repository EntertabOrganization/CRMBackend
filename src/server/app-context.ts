import { AccessService } from './access-service';
import { ActivityFieldEntityAdapter } from './activities/activity-field-adapter';
import { ActivityService } from './activities/activity-service';
import { ActivityTypeRegistry, ActivityTypeService } from './activities/activity-types';
import { ActivityAdapterRegistry } from './activities/adapters';
import { TimelineService } from './activities/timeline-service';
import { AuthService } from './auth-service';
import { AuditService } from './audit-service';
import { CrmCoreService } from './crm-core-service';
import { CrmPipelineService } from './crm-pipeline-service';
import { DepartmentService } from './department-service';
import { createCrmFieldEntityRegistry } from './fields/entity-registry';
import { FieldEngine } from './fields/field-engine';
import { PartnerService } from './partner-service';
import { UnconfiguredFilePort } from './ports';
import type { FilePort } from './ports';
import { FakeGoogleAuthProvider, MemoryMailService } from './providers';
import { RealtimeHub } from './realtime';
import { RoleService } from './role-service';
import { InMemoryStore } from './store';
import { UserService } from './user-service';
import { WorkspaceService } from './workspace-service';

function createAppContext() {
  const store = new InMemoryStore();
  const mailer = new MemoryMailService();
  const google = new FakeGoogleAuthProvider();
  const realtime = new RealtimeHub();
  const access = new AccessService(store);
  const registry = createCrmFieldEntityRegistry(store, access);
  const ports = { files: new UnconfiguredFilePort() as FilePort };
  const fields = new FieldEngine({ store, access, registry, realtime, files: ports.files });
  const activityTypes = new ActivityTypeRegistry(store);
  const adapters = new ActivityAdapterRegistry();
  const activities = new ActivityService(store, access, activityTypes, fields, adapters, realtime, () => ports.files);
  registry.register(new ActivityFieldEntityAdapter(store, activities.policy, access));
  const timeline = new TimelineService(store, access, registry, activities.policy, realtime, () => ports.files);
  const activityTypeAdmin = new ActivityTypeService(store, access, activityTypes, (workspaceId) => {
    realtime.enqueue({ type: 'ACTIVITY_TYPE_CHANGED', workspaceId, data: {} });
  });
  return {
    store,
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
    /** Wire the shared Files/Documents module here once it exists; until then file references are refused. */
    setFilePort(port: FilePort) {
      ports.files = port;
      fields.setFilePort(port);
    },
    auth: new AuthService(store, mailer, google),
    audit: new AuditService(store),
    users: new UserService(store, mailer),
    workspaces: new WorkspaceService(store),
    roles: new RoleService(store),
    departments: new DepartmentService(store),
    partners: new PartnerService(store),
    crmCore: new CrmCoreService(store, fields),
    crm: new CrmPipelineService(store, undefined, fields),
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
