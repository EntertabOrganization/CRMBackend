import { verifiedUser } from './helpers';

function leadSuccessStage(app: Awaited<ReturnType<typeof verifiedUser>>['app'], workspaceId: string) {
  const pipeline = app.store.state.crmPipelines.find((item) => item.workspaceId === workspaceId && item.entityType === 'LEAD' && item.isDefault)!;
  return app.store.state.crmStages.find((item) => item.pipelineId === pipeline.id && item.semanticType === 'SUCCESS')!;
}

describe('CRM leads and conversion', () => {
  it('creates rich Leads with communications, acquisition metadata, existing customer links and duplicate detection', async () => {
    const { app, user, workspace } = await verifiedUser();
    const contact = app.crmCore.createContact(user, workspace.id, { firstName: 'Existing', lastName: 'Buyer' });
    const company = app.crmCore.createCompany(user, workspace.id, { name: 'Existing Co' });

    const lead = app.crm.createLead(user, workspace.id, {
      title: 'Website request',
      firstName: 'Laila',
      lastName: 'Youssef',
      companyName: 'NewCo',
      companyId: company.id,
      contactIds: [contact.id],
      estimatedAmount: 25000,
      currencyCode: 'USD',
      utmSource: 'google',
      utmCampaign: 'crm-launch',
      originSystem: 'website',
      originExternalId: 'form-123',
      communications: [
        { type: 'EMAIL', value: 'Lead@Example.com' },
        { type: 'PHONE', value: '+20 122 222 2222' },
      ],
    });

    expect(lead.responsibleUserId).toBe(user.id);
    expect(lead.conversionStatus).toBe('NOT_CONVERTED');
    expect(lead.estimatedAmount).toBe(25000);
    expect(lead.utmSource).toBe('google');
    expect(app.store.state.crmLeadContacts).toEqual([expect.objectContaining({ leadId: lead.id, contactId: contact.id })]);
    expect(app.store.state.crmLeadCommunications.find((item) => item.type === 'EMAIL')?.normalizedValue).toBe('lead@example.com');

    expect(() =>
      app.crm.createLead(user, workspace.id, {
        title: 'Duplicate lead',
        communications: [{ type: 'EMAIL', value: 'lead@example.com' }],
      }),
    ).toThrow('Potential duplicate lead detected.');
  });

  it('does not convert a Lead when it moves to a SUCCESS stage', async () => {
    const { app, user, workspace } = await verifiedUser();
    const lead = app.crm.createLead(user, workspace.id, { title: 'Qualified but not converted' });
    const success = leadSuccessStage(app, workspace.id);

    const moved = app.crm.transitionLead(user, workspace.id, lead.id, { expectedVersion: lead.version, targetStageId: success.id });

    expect(moved.status).toBe('QUALIFIED');
    expect(moved.conversionStatus).toBe('NOT_CONVERTED');
    expect(app.store.state.crmLeadConversions).toHaveLength(0);
  });

  it('converts a Lead to a new Contact, Company and Deal with history, audit, outbox and idempotent replay', async () => {
    const { app, user, workspace } = await verifiedUser();
    const lead = app.crm.createLead(user, workspace.id, {
      title: 'Conversion inquiry',
      firstName: 'Sara',
      lastName: 'Ali',
      companyName: 'Converted Co',
      estimatedAmount: 10000,
      currencyCode: 'EUR',
      communications: [{ type: 'EMAIL', value: 'sara@example.com' }],
    });
    const payload = {
      expectedVersion: lead.version,
      contact: { action: 'CREATE' as const },
      company: { action: 'CREATE' as const },
      deal: { action: 'CREATE' as const, title: 'Converted opportunity' },
    };

    const result = app.crmCore.convertLead(user, workspace.id, lead.id, payload, 'convert-key-1') as any;
    const replay = app.crmCore.convertLead(user, workspace.id, lead.id, payload, 'convert-key-1') as any;

    expect(result.lead.conversionStatus).toBe('CONVERTED');
    expect(result.contact.displayName).toBe('Sara Ali');
    expect(result.company.name).toBe('Converted Co');
    expect(result.deal.amount).toBe(10000);
    expect(result.deal.currencyCode).toBe('EUR');
    expect(replay.conversion.id).toBe(result.conversion.id);
    expect(app.store.state.crmLeadConversions).toEqual([
      expect.objectContaining({ leadId: lead.id, contactId: result.contact.id, companyId: result.company.id, dealId: result.deal.id }),
    ]);
    expect(app.store.state.auditLogs.some((log) => log.action === 'CRM.LEAD.CONVERTED' && log.entityId === lead.id)).toBe(true);
    expect(app.store.state.outboxEvents.some((event) => event.eventType === 'CRM.LEAD.CONVERTED' && event.entityId === lead.id)).toBe(true);
  });

  it('supports link-only conversion and rejects cross-workspace existing customer IDs without partial writes', async () => {
    const first = await verifiedUser();
    const second = await verifiedUser();
    const contact = first.app.crmCore.createContact(first.user, first.workspace.id, { firstName: 'Linked', lastName: 'Contact' });
    const lead = first.app.crm.createLead(first.user, first.workspace.id, { title: 'Link only' });
    const foreignCompany = second.app.crmCore.createCompany(second.user, second.workspace.id, { name: 'Foreign' });

    expect(() =>
      first.app.crmCore.convertLead(first.user, first.workspace.id, lead.id, {
        expectedVersion: lead.version,
        contact: { action: 'LINK_EXISTING', contactId: contact.id },
        company: { action: 'LINK_EXISTING', companyId: foreignCompany.id },
        deal: { action: 'NONE' },
      }),
    ).toThrow('CRM_COMPANY was not found.');
    expect(first.app.store.state.crmLeadConversions).toHaveLength(0);
    expect(first.app.store.state.crmContacts).toHaveLength(1);

    const converted = first.app.crmCore.convertLead(first.user, first.workspace.id, lead.id, {
      expectedVersion: lead.version,
      contact: { action: 'LINK_EXISTING', contactId: contact.id },
      company: { action: 'NONE' },
      deal: { action: 'NONE' },
    }) as any;

    expect(converted.contact.id).toBe(contact.id);
    expect(converted.company).toBeNull();
    expect(converted.deal).toBeNull();
    expect(() =>
      first.app.crmCore.convertLead(first.user, first.workspace.id, lead.id, {
        expectedVersion: converted.lead.version,
        contact: { action: 'LINK_EXISTING', contactId: contact.id },
        company: { action: 'NONE' },
        deal: { action: 'NONE' },
      }),
    ).toThrow('Lead has already been converted.');
  });

  it('rejects idempotency key reuse with a different conversion payload', async () => {
    const { app, user, workspace } = await verifiedUser();
    const lead = app.crm.createLead(user, workspace.id, { title: 'Idempotency lead' });
    const contact = app.crmCore.createContact(user, workspace.id, { firstName: 'Reuse', lastName: 'Target' });

    app.crmCore.convertLead(user, workspace.id, lead.id, {
      expectedVersion: lead.version,
      contact: { action: 'LINK_EXISTING', contactId: contact.id },
      company: { action: 'NONE' },
      deal: { action: 'NONE' },
    }, 'same-key');

    expect(() =>
      app.crmCore.convertLead(user, workspace.id, lead.id, {
        expectedVersion: lead.version,
        contact: { action: 'NONE' },
        company: { action: 'CREATE', create: { name: 'Different' } },
        deal: { action: 'NONE' },
      }, 'same-key'),
    ).toThrow('Idempotency key was reused');
  });
});
