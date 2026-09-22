import type { PermissionScope, User } from '@/src/server/domain';
import { verifiedUser } from './helpers';

type App = Awaited<ReturnType<typeof verifiedUser>>['app'];

async function inviteMember(app: App, owner: User, workspaceId: string, roleId: string, email: string) {
  const invitation = await app.users.invite(owner, { workspaceId, email, roleId });
  const signup = await app.auth.signup({ firstName: 'Stage', lastName: 'Agent', email, password: 'Password1' });
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

function leadDefaultStages(app: App, workspaceId: string) {
  const pipeline = app.store.state.crmPipelines.find((item) => item.workspaceId === workspaceId && item.entityType === 'LEAD' && item.isDefault)!;
  const current = app.store.state.crmStages.find((item) => item.pipelineId === pipeline.id && item.name === 'New')!;
  const success = app.store.state.crmStages.find((item) => item.pipelineId === pipeline.id && item.semanticType === 'SUCCESS')!;
  return { pipeline, current, success };
}

describe('CRM stage permissions', () => {
  it('enforces source-stage leave permission', async () => {
    const { app, user: owner, workspace } = await verifiedUser();
    const role = roleWithPermissions(app, owner, workspace.id, 'Lead Workspace Transitioner', [
      { permissionId: 'crm.lead.transition', scope: 'WORKSPACE' },
    ]);
    const member = await inviteMember(app, owner, workspace.id, role.id, 'stage-leave@example.com');
    const { current, success } = leadDefaultStages(app, workspace.id);
    const lead = app.crm.createLead(owner, workspace.id, { title: 'Leave blocked' });
    app.crm.setStagePermission(owner, workspace.id, role.id, current.id, { canView: true, canEnter: true, canLeave: false });

    expect(() =>
      app.crm.transitionLead(member, workspace.id, lead.id, {
        expectedVersion: lead.version,
        targetStageId: success.id,
      }),
    ).toThrow('CRM stage leave permission is required.');
  });

  it('enforces target-stage view and enter permission', async () => {
    const { app, user: owner, workspace } = await verifiedUser();
    const role = roleWithPermissions(app, owner, workspace.id, 'Lead Target Transitioner', [
      { permissionId: 'crm.lead.transition', scope: 'WORKSPACE' },
    ]);
    const member = await inviteMember(app, owner, workspace.id, role.id, 'stage-enter@example.com');
    const { success } = leadDefaultStages(app, workspace.id);
    const lead = app.crm.createLead(owner, workspace.id, { title: 'Enter blocked' });

    app.crm.setStagePermission(owner, workspace.id, role.id, success.id, { canView: false, canEnter: true, canLeave: true });
    expect(() =>
      app.crm.transitionLead(member, workspace.id, lead.id, {
        expectedVersion: lead.version,
        targetStageId: success.id,
      }),
    ).toThrow('CRM stage view permission is required.');

    app.crm.setStagePermission(owner, workspace.id, role.id, success.id, { canView: true, canEnter: false });
    expect(() =>
      app.crm.transitionLead(member, workspace.id, lead.id, {
        expectedVersion: lead.version,
        targetStageId: success.id,
      }),
    ).toThrow('CRM stage enter permission is required.');
  });

  it('does not let transition override bypass stage access', async () => {
    const { app, user: owner, workspace } = await verifiedUser();
    const graphPipeline = app.crm.createPipeline(owner, workspace.id, {
      entityType: 'LEAD',
      name: 'Restricted Graph',
      transitionRulesEnabled: true,
      stages: [
        { name: 'New', semanticType: 'PROGRESS', isDefault: true },
        { name: 'Qualified', semanticType: 'SUCCESS' },
        { name: 'Rejected', semanticType: 'FAILURE' },
      ],
    });
    const role = roleWithPermissions(app, owner, workspace.id, 'Lead Override Transitioner', [
      { permissionId: 'crm.lead.transition', scope: 'WORKSPACE' },
    ]);
    const member = await inviteMember(app, owner, workspace.id, role.id, 'stage-override@example.com');
    const current = app.store.state.crmStages.find((item) => item.pipelineId === graphPipeline.pipeline.id && item.name === 'New')!;
    const success = app.store.state.crmStages.find((item) => item.pipelineId === graphPipeline.pipeline.id && item.semanticType === 'SUCCESS')!;
    const lead = app.crm.createLead(owner, workspace.id, { title: 'Override blocked', pipelineId: graphPipeline.pipeline.id });
    app.crm.setStagePermission(owner, workspace.id, role.id, success.id, { canView: true, canEnter: false, canLeave: true });

    app.store.state.crmStageTransitions.push({
      id: crypto.randomUUID(),
      workspaceId: workspace.id,
      pipelineId: graphPipeline.pipeline.id,
      fromStageId: current.id,
      toStageId: success.id,
      isActive: true,
    });
    expect(() =>
      app.crm.transitionLead(member, workspace.id, lead.id, {
        expectedVersion: lead.version,
        targetStageId: success.id,
        overrideTransitionGraph: true,
      }),
    ).toThrow('CRM stage enter permission is required.');
  });

  it('does not let stage access bypass base entity transition scope', async () => {
    const { app, user: owner, workspace } = await verifiedUser();
    const role = roleWithPermissions(app, owner, workspace.id, 'Own Transitioner', [
      { permissionId: 'crm.lead.transition', scope: 'OWN' },
    ]);
    const member = await inviteMember(app, owner, workspace.id, role.id, 'stage-scope@example.com');
    const { current, success } = leadDefaultStages(app, workspace.id);
    const lead = app.crm.createLead(owner, workspace.id, { title: 'Entity scope blocked' });
    app.crm.setStagePermission(owner, workspace.id, role.id, current.id, { canView: true, canEnter: true, canLeave: true });
    app.crm.setStagePermission(owner, workspace.id, role.id, success.id, { canView: true, canEnter: true, canLeave: true });

    expect(() =>
      app.crm.transitionLead(member, workspace.id, lead.id, {
        expectedVersion: lead.version,
        targetStageId: success.id,
      }),
    ).toThrow('Permission denied.');
  });
});
