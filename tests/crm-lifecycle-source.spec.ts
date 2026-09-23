import { verifiedUser } from './helpers';

describe('CRM lifecycle, sources and explicit relationships', () => {
  it('manages a workspace CRM source catalog and validates active Lead and Deal source references', async () => {
    const { app, user, workspace } = await verifiedUser();
    const source = app.crmCore.createSource(user, workspace.id, { name: 'Website Form', code: 'Website Form' });
    const company = app.crmCore.createCompany(user, workspace.id, { name: 'Source Co' });

    expect(source.code).toBe('website_form');
    expect(app.crmCore.listSources(user, workspace.id)).toEqual([expect.objectContaining({ id: source.id, isActive: true })]);

    const lead = app.crm.createLead(user, workspace.id, {
      title: 'Sourced lead',
      sourceId: source.id,
      sourceDescription: 'Pricing landing page',
      utmSource: 'google',
    });
    const deal = app.crm.createDeal(user, workspace.id, {
      title: 'Sourced deal',
      companyId: company.id,
      sourceId: source.id,
      sourceDescription: 'Imported opportunity',
    });

    expect(lead.sourceId).toBe(source.id);
    expect(deal.sourceDescription).toBe('Imported opportunity');
    app.crmCore.deactivateSource(user, workspace.id, source.id);
    expect(app.crmCore.listSources(user, workspace.id)).toHaveLength(0);
    expect(() => app.crm.createLead(user, workspace.id, { title: 'Inactive source', sourceId: source.id })).toThrow('CRM_SOURCE was not found.');
    expect(app.crmCore.listSources(user, workspace.id, true)).toEqual([expect.objectContaining({ id: source.id, isActive: false })]);
  });

  it('copies Lead acquisition source context to Deals created through conversion', async () => {
    const { app, user, workspace } = await verifiedUser();
    const source = app.crmCore.createSource(user, workspace.id, { name: 'Referral' });
    const lead = app.crm.createLead(user, workspace.id, {
      title: 'Referral lead',
      firstName: 'Nadine',
      lastName: 'Saleh',
      sourceId: source.id,
      sourceDescription: 'Partner introduction',
      utmCampaign: 'q4-growth',
      originSystem: 'website',
      originExternalId: 'lead-42',
      estimatedAmount: 7000,
      currencyCode: 'USD',
    });

    const result = app.crmCore.convertLead(user, workspace.id, lead.id, {
      expectedVersion: lead.version,
      contact: { action: 'CREATE' },
      company: { action: 'NONE' },
      deal: { action: 'CREATE' },
    }) as any;

    expect(result.deal).toEqual(
      expect.objectContaining({
        sourceId: source.id,
        sourceDescription: 'Partner introduction',
        utmCampaign: 'q4-growth',
        originSystem: 'website',
        originExternalId: 'lead-42',
        amount: 7000,
        currencyCode: 'USD',
      }),
    );
  });

  it('distinguishes archive, restore, soft delete, restore delete and hard delete while retaining audit', async () => {
    const { app, user, workspace } = await verifiedUser();
    const lead = app.crm.createLead(user, workspace.id, { title: 'Lifecycle lead' });

    app.crmCore.archiveLead(user, workspace.id, lead.id);
    expect(lead.isArchived).toBe(true);
    expect(lead.archivedByUserId).toBe(user.id);

    app.crmCore.restoreArchivedLead(user, workspace.id, lead.id);
    expect(lead.isArchived).toBe(false);
    expect(lead.archivedAt).toBeNull();

    app.crmCore.softDeleteLead(user, workspace.id, lead.id);
    expect(lead.isDeleted).toBe(true);
    expect(() => app.crm.transitionLead(user, workspace.id, lead.id, { expectedVersion: lead.version, targetStageId: lead.stageId })).toThrow('CRM_LEAD was not found.');

    app.crmCore.restoreDeletedLead(user, workspace.id, lead.id);
    expect(lead.isDeleted).toBe(false);

    const contact = app.crmCore.createContact(user, workspace.id, { firstName: 'Hard', lastName: 'Delete' });
    app.crmCore.softDeleteContact(user, workspace.id, contact.id);
    app.crmCore.hardDeleteContact(user, workspace.id, contact.id);

    expect(app.store.state.crmContacts.some((item) => item.id === contact.id)).toBe(false);
    expect(app.store.state.auditLogs.some((log) => log.action === 'CRM.CONTACT.HARD_DELETED' && log.entityId === contact.id)).toBe(true);
  });

  it('blocks Contact soft delete when protected active business references exist', async () => {
    const { app, user, workspace } = await verifiedUser();
    const contact = app.crmCore.createContact(user, workspace.id, { firstName: 'Protected', lastName: 'Buyer' });
    app.crm.createDeal(user, workspace.id, { title: 'Protected deal', contactIds: [contact.id] });

    expect(() => app.crmCore.softDeleteContact(user, workspace.id, contact.id)).toThrow('referenced by active business records');
  });

  it('mutates Deal Contact relationships explicitly with uniqueness, primary replacement and audit', async () => {
    const { app, user, workspace } = await verifiedUser();
    const company = app.crmCore.createCompany(user, workspace.id, { name: 'Relationship Co' });
    const deal = app.crm.createDeal(user, workspace.id, { title: 'Committee sale', companyId: company.id });
    const first = app.crmCore.createContact(user, workspace.id, { firstName: 'First', lastName: 'Contact' });
    const second = app.crmCore.createContact(user, workspace.id, { firstName: 'Second', lastName: 'Contact' });

    const firstRelation = app.crmCore.linkDealContact(user, workspace.id, { dealId: deal.id, contactId: first.id, role: 'Decision Maker' });
    const secondRelation = app.crmCore.linkDealContact(user, workspace.id, { dealId: deal.id, contactId: second.id, role: 'Finance', isPrimary: true });

    expect(firstRelation.role).toBe('Decision Maker');
    expect(secondRelation.isPrimary).toBe(true);
    expect(app.store.state.crmDealContacts.filter((item) => item.dealId === deal.id && item.isPrimary)).toEqual([
      expect.objectContaining({ contactId: second.id }),
    ]);
    expect(() => app.crmCore.linkDealContact(user, workspace.id, { dealId: deal.id, contactId: second.id })).toThrow('already linked to this deal');
    expect(app.store.state.auditLogs.some((log) => log.action === 'CRM.DEAL.CONTACT_LINKED' && log.entityId === deal.id)).toBe(true);
  });

  it('blocks deleting a user who owns CRM records unless a valid replacement responsible user is supplied', async () => {
    const { app, user, workspace } = await verifiedUser();
    const role = app.roles.create(user, workspace.id, { name: 'Replacement owner' });
    app.roles.replacePermissions(user, workspace.id, role.id, [{ permissionId: 'crm.lead.read', scope: 'WORKSPACE' }]);
    const invitation = await app.users.invite(user, { workspaceId: workspace.id, email: 'crm-replacement@example.com', roleId: role.id });
    const signup = await app.auth.signup({ firstName: 'CRM', lastName: 'Replacement', email: 'crm-replacement@example.com', password: 'Password1' });
    await app.auth.verifyEmail(signup.verificationToken);
    const replacement = app.store.state.users.find((candidate) => candidate.email === 'crm-replacement@example.com')!;
    app.users.acceptInvitation(replacement, invitation.invitationToken);
    const lead = app.crm.createLead(user, workspace.id, { title: 'Owned lead' });
    const contact = app.crmCore.createContact(user, workspace.id, { firstName: 'Owned', lastName: 'Contact' });

    expect(() => app.users.softDelete(user, user.id)).toThrow('CRM records must be reassigned');

    app.users.softDelete(user, user.id, { replacementResponsibleUserId: replacement.id });

    expect(user.isDeleted).toBe(true);
    expect(lead.responsibleUserId).toBe(replacement.id);
    expect(contact.responsibleUserId).toBe(replacement.id);
    expect(app.store.state.auditLogs.filter((log) => log.action === 'CRM.LEAD.ASSIGNED' && log.entityId === lead.id)).toHaveLength(1);
    expect(app.store.state.auditLogs.filter((log) => log.action === 'CRM.CONTACT.ASSIGNED' && log.entityId === contact.id)).toHaveLength(1);
  });
});
