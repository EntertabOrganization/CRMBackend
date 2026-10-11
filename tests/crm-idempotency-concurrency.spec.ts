import { verifiedUser } from './helpers';

function leadSuccessStage(app: Awaited<ReturnType<typeof verifiedUser>>['app'], workspaceId: string) {
  const pipeline = app.store.state.crmPipelines.find((item) => item.workspaceId === workspaceId && item.entityType === 'LEAD' && item.isDefault)!;
  return app.store.state.crmStages.find((item) => item.pipelineId === pipeline.id && item.semanticType === 'SUCCESS')!;
}

describe('CRM idempotency and concurrency scenarios', () => {
  it('replays lead creation with the same idempotency key without duplicating relationships or communications', async () => {
    const { app, user, workspace } = await verifiedUser();
    const contact = app.crmCore.createContact(user, workspace.id, { firstName: 'Create', lastName: 'Replay' });
    const payload = {
      title: 'Created once',
      contactIds: [contact.id],
      communications: [{ type: 'EMAIL' as const, value: 'create-once@example.com' }],
    };

    const first = app.crm.createLead(user, workspace.id, payload, 'create-lead-key');
    const replay = app.crm.createLead(user, workspace.id, payload, 'create-lead-key');

    expect(replay).toEqual(first);
    expect(app.store.state.crmLeads).toHaveLength(1);
    expect(app.store.state.crmLeadContacts.filter((relation) => relation.leadId === first.id)).toHaveLength(1);
    expect(app.store.state.crmLeadCommunications.filter((communication) => communication.leadId === first.id)).toHaveLength(1);
    expect(app.store.state.crmStageHistory.filter((history) => history.recordId === first.id)).toHaveLength(1);
  });

  it('replays deal creation with the same idempotency key without duplicating contacts or stage history', async () => {
    const { app, user, workspace } = await verifiedUser();
    const contact = app.crmCore.createContact(user, workspace.id, { firstName: 'Deal', lastName: 'Replay' });
    const payload = { title: 'Deal created once', contactIds: [contact.id] };

    const first = app.crm.createDeal(user, workspace.id, payload, 'create-deal-key');
    const replay = app.crm.createDeal(user, workspace.id, payload, 'create-deal-key');

    expect(replay).toEqual(first);
    expect(app.store.state.crmDeals).toHaveLength(1);
    expect(app.store.state.crmDealContacts.filter((relation) => relation.dealId === first.id)).toHaveLength(1);
    expect(app.store.state.crmStageHistory.filter((history) => history.recordId === first.id)).toHaveLength(1);
  });

  it('rejects create idempotency key reuse with a different payload', async () => {
    const { app, user, workspace } = await verifiedUser();

    app.crm.createLead(user, workspace.id, { title: 'Original' }, 'create-reuse-key');

    expect(() => app.crm.createLead(user, workspace.id, { title: 'Changed' }, 'create-reuse-key')).toThrow(
      'Idempotency key was reused with a different payload.',
    );
  });

  it('replays contact-company relationship creation without duplicating the relationship or audit entry', async () => {
    const { app, user, workspace } = await verifiedUser();
    const contact = app.crmCore.createContact(user, workspace.id, { firstName: 'Relation', lastName: 'Replay' });
    const company = app.crmCore.createCompany(user, workspace.id, { name: 'Relation Co' });
    const payload = { contactId: contact.id, companyId: company.id, jobTitle: 'Buyer' };

    const first = app.crmCore.linkContactCompany(user, workspace.id, payload, 'contact-company-key');
    const replay = app.crmCore.linkContactCompany(user, workspace.id, payload, 'contact-company-key');

    expect(replay).toEqual(first);
    expect(app.store.state.crmContactCompanies.filter((relation) => relation.contactId === contact.id && relation.companyId === company.id)).toHaveLength(1);
    expect(app.store.state.auditLogs.filter((log) => log.action === 'CRM.CONTACT.COMPANY_LINKED' && log.entityId === contact.id)).toHaveLength(1);
  });

  it('replays deal-contact relationship creation without duplicating the relationship or audit entry', async () => {
    const { app, user, workspace } = await verifiedUser();
    const contact = app.crmCore.createContact(user, workspace.id, { firstName: 'Deal', lastName: 'Contact' });
    const deal = app.crm.createDeal(user, workspace.id, { title: 'Relationship replay', contactIds: [contact.id] });
    const secondContact = app.crmCore.createContact(user, workspace.id, { firstName: 'Second', lastName: 'Contact' });
    const payload = { dealId: deal.id, contactId: secondContact.id, role: 'Finance' };

    const first = app.crmCore.linkDealContact(user, workspace.id, payload, 'deal-contact-key');
    const replay = app.crmCore.linkDealContact(user, workspace.id, payload, 'deal-contact-key');

    expect(replay).toEqual(first);
    expect(app.store.state.crmDealContacts.filter((relation) => relation.dealId === deal.id && relation.contactId === secondContact.id)).toHaveLength(1);
    expect(app.store.state.auditLogs.filter((log) => log.action === 'CRM.DEAL.CONTACT_LINKED' && log.entityId === deal.id)).toHaveLength(1);
  });

  it('replays lead transition commands with the same idempotency key without duplicating side effects', async () => {
    const { app, user, workspace } = await verifiedUser();
    const lead = app.crm.createLead(user, workspace.id, { title: 'Idempotent transition' });
    const targetStage = leadSuccessStage(app, workspace.id);
    const payload = { expectedVersion: lead.version, targetStageId: targetStage.id };

    const first = app.crm.transitionLead(user, workspace.id, lead.id, payload, 'transition-key');
    const replay = app.crm.transitionLead(user, workspace.id, lead.id, payload, 'transition-key');

    expect(replay).toEqual(first);
    expect(app.store.state.crmStageHistory.filter((history) => history.recordId === lead.id)).toHaveLength(2);
    expect(app.store.state.auditLogs.filter((log) => log.action === 'CRM.LEAD.STAGE_CHANGED' && log.entityId === lead.id)).toHaveLength(1);
    expect(app.store.state.outboxEvents.filter((event) => event.eventType === 'CRM.LEAD.STAGE_CHANGED' && event.entityId === lead.id)).toHaveLength(1);
  });

  it('rejects transition idempotency key reuse with a different payload', async () => {
    const { app, user, workspace } = await verifiedUser();
    const lead = app.crm.createLead(user, workspace.id, { title: 'Transition reuse' });
    const targetStage = leadSuccessStage(app, workspace.id);

    app.crm.transitionLead(user, workspace.id, lead.id, { expectedVersion: lead.version, targetStageId: targetStage.id }, 'reuse-key');

    expect(() =>
      app.crm.transitionLead(user, workspace.id, lead.id, { expectedVersion: lead.version + 1, targetStageId: lead.stageId }, 'reuse-key'),
    ).toThrow('Idempotency key was reused with a different payload.');
  });

  it('isolates idempotency keys by workspace and actor', async () => {
    const first = await verifiedUser();
    const second = await verifiedUser();
    const firstLead = first.app.crm.createLead(first.user, first.workspace.id, { title: 'First workspace' });
    const secondLead = second.app.crm.createLead(second.user, second.workspace.id, { title: 'Second workspace' });
    const firstStage = leadSuccessStage(first.app, first.workspace.id);
    const secondStage = leadSuccessStage(second.app, second.workspace.id);

    const firstResult = first.app.crm.transitionLead(
      first.user,
      first.workspace.id,
      firstLead.id,
      { expectedVersion: firstLead.version, targetStageId: firstStage.id },
      'shared-key',
    );
    const secondResult = second.app.crm.transitionLead(
      second.user,
      second.workspace.id,
      secondLead.id,
      { expectedVersion: secondLead.version, targetStageId: secondStage.id },
      'shared-key',
    );

    expect(firstResult.id).toBe(firstLead.id);
    expect(secondResult.id).toBe(secondLead.id);
    expect(first.app.store.state.idempotencyRecords).toHaveLength(1);
    expect(second.app.store.state.idempotencyRecords).toHaveLength(1);
  });

  it('stores CRM idempotency records with at least near-24-hour retention', async () => {
    const { app, user, workspace } = await verifiedUser();
    const lead = app.crm.createLead(user, workspace.id, { title: 'Retention lead' });
    const targetStage = leadSuccessStage(app, workspace.id);
    const before = Date.now();

    app.crm.transitionLead(user, workspace.id, lead.id, { expectedVersion: lead.version, targetStageId: targetStage.id }, 'retention-key');

    const record = app.store.state.idempotencyRecords.find((item) => item.idempotencyKey === 'retention-key')!;
    expect(record.expiresAt.getTime()).toBeGreaterThanOrEqual(before + (24 * 60 * 60 * 1000) - 1000);
  });

  it('replays assignment commands and rejects stale non-idempotent mutation', async () => {
    const { app, user: owner, workspace } = await verifiedUser();
    const role = app.roles.create(owner, workspace.id, { name: 'Assignable' });
    app.roles.replacePermissions(owner, workspace.id, role.id, [{ permissionId: 'crm.lead.assign', scope: 'WORKSPACE' }]);
    const invitation = await app.users.invite(owner, { workspaceId: workspace.id, email: 'assign-replay@example.com', roleId: role.id });
    const signup = await app.auth.signup({ firstName: 'Assign', lastName: 'Replay', email: 'assign-replay@example.com', password: 'Password1' });
    await app.auth.verifyEmail(signup.verificationToken);
    const assignee = app.store.state.users.find((candidate) => candidate.email === 'assign-replay@example.com')!;
    await app.users.acceptInvitation(assignee, invitation.invitationToken);
    const lead = app.crm.createLead(owner, workspace.id, { title: 'Assignment replay' });
    const payload = { responsibleUserId: assignee.id, expectedVersion: lead.version };

    const first = app.crmCore.assignRecord(owner, workspace.id, 'LEAD', lead.id, payload, 'assign-key');
    const replay = app.crmCore.assignRecord(owner, workspace.id, 'LEAD', lead.id, payload, 'assign-key');

    expect(replay).toEqual(first);
    expect(app.store.state.auditLogs.filter((log) => log.action === 'CRM.LEAD.ASSIGNED' && log.entityId === lead.id)).toHaveLength(1);
    expect(() => app.crmCore.assignRecord(owner, workspace.id, 'LEAD', lead.id, payload)).toThrow('CRM record version is stale.');
  });
});
