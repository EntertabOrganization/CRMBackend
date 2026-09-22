import type { PermissionScope, User } from '@/src/server/domain';
import { verifiedUser } from './helpers';

type App = Awaited<ReturnType<typeof verifiedUser>>['app'];

async function inviteMember(
  app: App,
  owner: User,
  workspaceId: string,
  roleId: string,
  email: string,
) {
  const invitation = await app.users.invite(owner, { workspaceId, email, roleId });
  const signup = await app.auth.signup({ firstName: 'Member', lastName: 'User', email, password: 'Password1' });
  await app.auth.verifyEmail(signup.verificationToken);
  const user = app.store.state.users.find((candidate) => candidate.email === email)!;
  app.users.acceptInvitation(user, invitation.invitationToken);
  return user;
}

function roleWithPermissions(
  app: App,
  owner: User,
  workspaceId: string,
  name: string,
  permissions: { permissionId: string; scope: PermissionScope }[],
) {
  const role = app.roles.create(owner, workspaceId, { name });
  app.roles.replacePermissions(owner, workspaceId, role.id, permissions);
  return role;
}

describe('CRM responsibility and observers', () => {
  it('interprets OWN scope only as current responsibleUserId', async () => {
    const { app, user: owner, workspace } = await verifiedUser();
    const role = roleWithPermissions(app, owner, workspace.id, 'Own CRM Reader', [{ permissionId: 'crm.lead.read', scope: 'OWN' }]);
    const member = await inviteMember(app, owner, workspace.id, role.id, 'crm-own-reader@example.com');
    const ownedByOwner = app.crm.createLead(owner, workspace.id, { title: 'Owner lead' });
    const ownedByMember = app.crm.createLead(owner, workspace.id, { title: 'Member lead', responsibleUserId: member.id });

    expect(app.crmCore.canReadRecord(member, workspace.id, 'LEAD', ownedByOwner.id)).toBe(false);
    expect(app.crmCore.canReadRecord(member, workspace.id, 'LEAD', ownedByMember.id)).toBe(true);

    app.crmCore.assignRecord(owner, workspace.id, 'LEAD', ownedByMember.id, {
      responsibleUserId: owner.id,
      expectedVersion: ownedByMember.version,
    });

    expect(app.crmCore.canReadRecord(member, workspace.id, 'LEAD', ownedByMember.id)).toBe(false);
  });

  it('requires entity assign permission and active same-workspace target membership', async () => {
    const { app, user: owner, workspace } = await verifiedUser();
    const readOnlyRole = roleWithPermissions(app, owner, workspace.id, 'Read Only CRM', [{ permissionId: 'crm.lead.read', scope: 'WORKSPACE' }]);
    const assignRole = roleWithPermissions(app, owner, workspace.id, 'Lead Assigner', [{ permissionId: 'crm.lead.assign', scope: 'WORKSPACE' }]);
    const readOnly = await inviteMember(app, owner, workspace.id, readOnlyRole.id, 'crm-readonly@example.com');
    const assigner = await inviteMember(app, owner, workspace.id, assignRole.id, 'crm-assigner@example.com');
    const foreign = await verifiedUser();
    const lead = app.crm.createLead(owner, workspace.id, { title: 'Assignment lead' });

    expect(() =>
      app.crmCore.assignRecord(readOnly, workspace.id, 'LEAD', lead.id, {
        responsibleUserId: readOnly.id,
        expectedVersion: lead.version,
      }),
    ).toThrow('Permission denied.');
    expect(() =>
      app.crmCore.assignRecord(assigner, workspace.id, 'LEAD', lead.id, {
        responsibleUserId: foreign.user.id,
        expectedVersion: lead.version,
      }),
    ).toThrow('Workspace member was not found.');

    const assigned = app.crmCore.assignRecord(assigner, workspace.id, 'LEAD', lead.id, {
      responsibleUserId: readOnly.id,
      expectedVersion: lead.version,
    });

    expect(assigned.responsibleUserId).toBe(readOnly.id);
    expect(app.store.state.auditLogs.some((log) => log.action === 'CRM.LEAD.ASSIGNED' && log.entityId === lead.id)).toBe(true);
  });

  it('lets observers read a specific record without granting transition access', async () => {
    const { app, user: owner, workspace } = await verifiedUser();
    const observerRole = roleWithPermissions(app, owner, workspace.id, 'Observer Role', [
      { permissionId: 'crm.lead.read', scope: 'OWN' },
      { permissionId: 'crm.lead.transition', scope: 'OWN' },
    ]);
    const observer = await inviteMember(app, owner, workspace.id, observerRole.id, 'crm-observer@example.com');
    const lead = app.crm.createLead(owner, workspace.id, { title: 'Observed lead' });
    const pipeline = app.store.state.crmPipelines.find((item) => item.workspaceId === workspace.id && item.entityType === 'LEAD' && item.isDefault)!;
    const success = app.store.state.crmStages.find((item) => item.pipelineId === pipeline.id && item.semanticType === 'SUCCESS')!;

    expect(app.crmCore.canReadRecord(observer, workspace.id, 'LEAD', lead.id)).toBe(false);
    app.crmCore.addObserver(owner, workspace.id, 'LEAD', lead.id, observer.id);

    expect(app.crmCore.canReadRecord(observer, workspace.id, 'LEAD', lead.id)).toBe(true);
    expect(() =>
      app.crm.transitionLead(observer, workspace.id, lead.id, {
        expectedVersion: lead.version,
        targetStageId: success.id,
      }),
    ).toThrow('Permission denied.');

    app.crmCore.removeObserver(owner, workspace.id, 'LEAD', lead.id, observer.id);
    expect(app.crmCore.canReadRecord(observer, workspace.id, 'LEAD', lead.id)).toBe(false);
  });
});
