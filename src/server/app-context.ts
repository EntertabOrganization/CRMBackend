import { AuthService } from './auth-service';
import { AuditService } from './audit-service';
import { CrmCoreService } from './crm-core-service';
import { CrmPipelineService } from './crm-pipeline-service';
import { DepartmentService } from './department-service';
import { PartnerService } from './partner-service';
import { FakeGoogleAuthProvider, MemoryMailService } from './providers';
import { RoleService } from './role-service';
import { InMemoryStore } from './store';
import { UserService } from './user-service';
import { WorkspaceService } from './workspace-service';

function createAppContext() {
  const store = new InMemoryStore();
  const mailer = new MemoryMailService();
  const google = new FakeGoogleAuthProvider();
  return {
    store,
    mailer,
    google,
    auth: new AuthService(store, mailer, google),
    audit: new AuditService(store),
    users: new UserService(store, mailer),
    workspaces: new WorkspaceService(store),
    roles: new RoleService(store),
    departments: new DepartmentService(store),
    partners: new PartnerService(store),
    crmCore: new CrmCoreService(store),
    crm: new CrmPipelineService(store),
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
