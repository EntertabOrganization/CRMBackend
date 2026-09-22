import { AuthService } from '@/src/server/auth-service';
import { DepartmentService } from '@/src/server/department-service';
import { FakeGoogleAuthProvider, MemoryMailService } from '@/src/server/providers';
import { RoleService } from '@/src/server/role-service';
import { InMemoryStore } from '@/src/server/store';
import { UserService } from '@/src/server/user-service';
import { WorkspaceService } from '@/src/server/workspace-service';
import { PartnerService } from '@/src/server/partner-service';
import { AuditService } from '@/src/server/audit-service';
import { CrmCoreService } from '@/src/server/crm-core-service';
import { CrmPipelineService } from '@/src/server/crm-pipeline-service';

export function testApp() {
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

export async function verifiedUser() {
  const app = testApp();
  const signup = await app.auth.signup({
    firstName: 'Faris',
    lastName: 'Hassan',
    email: ' Faris@Example.com ',
    password: 'Password1',
  });
  const session = await app.auth.verifyEmail(signup.verificationToken);
  const user = app.store.state.users[0];
  const workspace = session.workspace!;
  return { app, user, workspace, session };
}
