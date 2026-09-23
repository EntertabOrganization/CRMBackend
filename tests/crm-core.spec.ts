import { verifiedUser } from './helpers';

describe('CRM core customer records', () => {
  it('supports normalized Contact communications with one primary per type and duplicate force-create flow', async () => {
    const { app, user, workspace } = await verifiedUser();

    const contact = app.crmCore.createContact(user, workspace.id, {
      firstName: 'Mona',
      lastName: 'Said',
      communications: [
        { type: 'PHONE', value: '+20 100 000 0000', label: 'MOBILE' },
        { type: 'EMAIL', value: 'Mona@Example.com', label: 'WORK' },
        { type: 'WEB', value: 'https://example.com/' },
        { type: 'IM', value: 'telegram:mona' },
      ],
    });

    expect(contact.displayName).toBe('Mona Said');
    expect(app.store.state.crmContactCommunications.filter((item) => item.contactId === contact.id)).toHaveLength(4);
    expect(app.store.state.crmContactCommunications.find((item) => item.type === 'EMAIL')?.normalizedValue).toBe('mona@example.com');
    app.crmCore.addContactCommunication(user, workspace.id, contact.id, { type: 'EMAIL', value: 'second@example.com', isPrimary: true });
    expect(app.store.state.crmContactCommunications.filter((item) => item.contactId === contact.id && item.type === 'EMAIL' && item.isPrimary)).toHaveLength(1);

    expect(() =>
      app.crmCore.createContact(user, workspace.id, {
        firstName: 'Duplicate',
        lastName: 'Contact',
        communications: [{ type: 'PHONE', value: '+201000000000' }],
      }),
    ).toThrow('Potential duplicate contact detected.');
    const duplicate = app.crmCore.createContact(user, workspace.id, {
      firstName: 'Duplicate',
      lastName: 'Allowed',
      forceCreate: true,
      communications: [{ type: 'PHONE', value: '+201000000000' }],
    });
    expect(duplicate.id).toBeTruthy();
  });

  it('isolates communication duplicate detection and communication mutation by Workspace', async () => {
    const first = await verifiedUser();
    const second = await verifiedUser();
    const firstContact = first.app.crmCore.createContact(first.user, first.workspace.id, {
      firstName: 'First',
      lastName: 'Workspace',
      communications: [{ type: 'EMAIL', value: 'shared@example.com' }],
    });

    const secondContact = second.app.crmCore.createContact(second.user, second.workspace.id, {
      firstName: 'Second',
      lastName: 'Workspace',
      communications: [{ type: 'EMAIL', value: 'shared@example.com' }],
    });

    expect(firstContact.id).not.toBe(secondContact.id);
    expect(first.app.store.state.crmContactCommunications).toHaveLength(1);
    expect(second.app.store.state.crmContactCommunications).toHaveLength(1);
    expect(() =>
      first.app.crmCore.addContactCommunication(first.user, first.workspace.id, secondContact.id, {
        type: 'PHONE',
        value: '+20 100 222 3333',
      }),
    ).toThrow('CRM_CONTACT was not found.');
  });

  it('supports many-to-many Contact and Company relationships with relationship-specific job data', async () => {
    const { app, user, workspace } = await verifiedUser();
    const contact = app.crmCore.createContact(user, workspace.id, { firstName: 'Nour', lastName: 'Adel' });
    const primaryCompany = app.crmCore.createCompany(user, workspace.id, { name: 'Entertab' });
    const secondaryCompany = app.crmCore.createCompany(user, workspace.id, { name: 'Partner Co' });

    const primary = app.crmCore.linkContactCompany(user, workspace.id, {
      contactId: contact.id,
      companyId: primaryCompany.id,
      jobTitle: 'Head of Sales',
      department: 'Sales',
    });
    const secondary = app.crmCore.linkContactCompany(user, workspace.id, {
      contactId: contact.id,
      companyId: secondaryCompany.id,
      jobTitle: 'Advisor',
      department: 'Board',
      isPrimary: true,
    });

    expect(primary.jobTitle).toBe('Head of Sales');
    expect(secondary.department).toBe('Board');
    expect(app.store.state.crmContactCompanies.filter((item) => item.contactId === contact.id)).toHaveLength(2);
    expect(app.store.state.crmContactCompanies.filter((item) => item.contactId === contact.id && item.isPrimary)).toEqual([
      expect.objectContaining({ companyId: secondaryCompany.id }),
    ]);
  });

  it('requires explicit replacement when removing a primary company relationship while others remain', async () => {
    const { app, user, workspace } = await verifiedUser();
    const contact = app.crmCore.createContact(user, workspace.id, { firstName: 'Omar', lastName: 'Fathy' });
    const a = app.crmCore.createCompany(user, workspace.id, { name: 'A Corp' });
    const b = app.crmCore.createCompany(user, workspace.id, { name: 'B Corp' });
    const primary = app.crmCore.linkContactCompany(user, workspace.id, { contactId: contact.id, companyId: a.id });
    app.crmCore.linkContactCompany(user, workspace.id, { contactId: contact.id, companyId: b.id });

    expect(() => app.crmCore.removeContactCompany(user, workspace.id, primary.id)).toThrow('explicit replacement');
    app.crmCore.removeContactCompany(user, workspace.id, primary.id, b.id);

    expect(app.store.state.crmContactCompanies).toEqual([
      expect.objectContaining({ contactId: contact.id, companyId: b.id, isPrimary: true }),
    ]);
  });

  it('keeps CRM Company distinct from Workspace and supports Company communications and protected delete references', async () => {
    const { app, user, workspace } = await verifiedUser();
    const company = app.crmCore.createCompany(user, workspace.id, {
      name: 'Customer Account',
      communications: [
        { type: 'PHONE', value: '+20 111 111 1111' },
        { type: 'EMAIL', value: 'INFO@CUSTOMER.COM' },
        { type: 'WEB', value: 'https://customer.com/' },
        { type: 'IM', value: 'whatsapp:+201111111111' },
      ],
    });

    expect(company.id).not.toBe(workspace.id);
    expect(company.name).not.toBe(workspace.name);
    expect(app.store.state.crmCompanyCommunications.filter((item) => item.companyId === company.id)).toHaveLength(4);
    expect(app.store.state.crmCompanyCommunications.find((item) => item.type === 'WEB')?.normalizedValue).toBe('customer.com');

    const deal = app.crm.createDeal(user, workspace.id, { title: 'Renewal', companyId: company.id });
    expect(deal.companyId).toBe(company.id);
    expect(() => app.crmCore.softDeleteCompany(user, workspace.id, company.id)).toThrow('referenced by active deals');
  });

  it('validates cross-workspace Contact and Company relationship IDs as not found', async () => {
    const first = await verifiedUser();
    const second = await verifiedUser();
    const foreignCompany = second.app.crmCore.createCompany(second.user, second.workspace.id, { name: 'Foreign Co' });
    const localContact = first.app.crmCore.createContact(first.user, first.workspace.id, { firstName: 'Local', lastName: 'User' });

    expect(() =>
      first.app.crmCore.linkContactCompany(first.user, first.workspace.id, {
        contactId: localContact.id,
        companyId: foreignCompany.id,
      }),
    ).toThrow('CRM_COMPANY was not found.');
  });

  it('allows one Company to participate in many Deals and supports Deal Contacts with one primary', async () => {
    const { app, user, workspace } = await verifiedUser();
    const company = app.crmCore.createCompany(user, workspace.id, { name: 'Multi Deal Co' });
    const primaryContact = app.crmCore.createContact(user, workspace.id, { firstName: 'Primary', lastName: 'Person' });
    const secondaryContact = app.crmCore.createContact(user, workspace.id, { firstName: 'Secondary', lastName: 'Person' });

    const firstDeal = app.crm.createDeal(user, workspace.id, {
      title: 'First',
      companyId: company.id,
      contactIds: [primaryContact.id, secondaryContact.id],
      primaryContactId: secondaryContact.id,
    });
    const secondDeal = app.crm.createDeal(user, workspace.id, { title: 'Second', companyId: company.id });

    expect(firstDeal.companyId).toBe(company.id);
    expect(secondDeal.companyId).toBe(company.id);
    expect(app.store.state.crmDeals.filter((deal) => deal.companyId === company.id)).toHaveLength(2);
    expect(app.store.state.auditLogs.some((log) => log.action === 'CRM.DEAL.CREATED' && log.entityId === firstDeal.id)).toBe(true);
    expect(app.store.state.outboxEvents.some((event) => event.eventType === 'CRM.DEAL.CREATED' && event.entityId === firstDeal.id)).toBe(true);
    expect(app.store.state.crmDealContacts.filter((item) => item.dealId === firstDeal.id && item.isPrimary)).toEqual([
      expect.objectContaining({ contactId: secondaryContact.id }),
    ]);
  });
});
