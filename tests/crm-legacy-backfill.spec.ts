import { verifiedUser } from './helpers';

function removeWorkspacePipelineConfiguration(app: Awaited<ReturnType<typeof verifiedUser>>['app'], workspaceId: string) {
  app.store.state.crmPipelines = app.store.state.crmPipelines.filter((pipeline) => pipeline.workspaceId !== workspaceId);
  app.store.state.crmStages = app.store.state.crmStages.filter((stage) => stage.workspaceId !== workspaceId);
}

describe('CRM legacy pipeline backfill', () => {
  it('bootstraps default Lead and Deal pipelines for an existing Workspace lacking valid configuration', async () => {
    const { app, user, workspace } = await verifiedUser();
    removeWorkspacePipelineConfiguration(app, workspace.id);

    const result = app.crm.backfillLegacyWorkspace(user, workspace.id);

    expect(result.migratedRecords).toBe(0);
    expect(app.store.state.crmPipelines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workspaceId: workspace.id, entityType: 'LEAD', isDefault: true, isActive: true }),
        expect.objectContaining({ workspaceId: workspace.id, entityType: 'DEAL', isDefault: true, isActive: true }),
      ]),
    );
    expect(app.store.state.auditLogs.some((log) => log.action === 'CRM.PIPELINE.LEGACY_BACKFILLED')).toBe(true);
  });

  it('maps records with no legacy stage information to the default New stage', async () => {
    const { app, user, workspace } = await verifiedUser();
    const lead = app.crm.createLead(user, workspace.id, { title: 'Old blank lead' });
    const company = app.crmCore.createCompany(user, workspace.id, { name: 'Old Deal Co' });
    const deal = app.crm.createDeal(user, workspace.id, { title: 'Old blank deal', companyId: company.id });
    removeWorkspacePipelineConfiguration(app, workspace.id);
    lead.pipelineId = '';
    lead.stageId = '';
    deal.pipelineId = '';
    deal.stageId = '';

    const result = app.crm.backfillLegacyWorkspace(user, workspace.id);
    const leadPipeline = app.store.state.crmPipelines.find((pipeline) => pipeline.id === result.leadPipelineId)!;
    const dealPipeline = app.store.state.crmPipelines.find((pipeline) => pipeline.id === result.dealPipelineId)!;
    const leadNew = app.store.state.crmStages.find((stage) => stage.pipelineId === leadPipeline.id && stage.name === 'New')!;
    const dealNew = app.store.state.crmStages.find((stage) => stage.pipelineId === dealPipeline.id && stage.name === 'New')!;

    expect(result.migratedRecords).toBe(2);
    expect(lead.pipelineId).toBe(leadPipeline.id);
    expect(lead.stageId).toBe(leadNew.id);
    expect(lead.status).toBe('ACTIVE');
    expect(deal.pipelineId).toBe(dealPipeline.id);
    expect(deal.stageId).toBe(dealNew.id);
    expect(deal.status).toBe('OPEN');
    expect(app.store.state.crmStageHistory.filter((history) => history.recordId === lead.id).at(-1)).toEqual(
      expect.objectContaining({ fromPipelineId: null, fromStageId: null, toStageId: leadNew.id }),
    );
  });

  it('uses explicit deterministic mappings for known legacy status values', async () => {
    const { app, user, workspace } = await verifiedUser();
    const lead = app.crm.createLead(user, workspace.id, { title: 'Legacy qualified lead' });
    removeWorkspacePipelineConfiguration(app, workspace.id);
    lead.pipelineId = '';
    lead.stageId = '';
    (lead as unknown as { legacyStatus: string }).legacyStatus = 'legacy-qualified';

    app.crm.backfillLegacyWorkspace(user, workspace.id, {
      leadStatusToStageName: { 'legacy-qualified': 'Qualified' },
    });
    const pipeline = app.store.state.crmPipelines.find((item) => item.workspaceId === workspace.id && item.entityType === 'LEAD' && item.isDefault)!;
    const qualified = app.store.state.crmStages.find((stage) => stage.pipelineId === pipeline.id && stage.name === 'Qualified')!;

    expect(lead.stageId).toBe(qualified.id);
    expect(lead.status).toBe('QUALIFIED');
  });

  it('stops instead of silently mapping unknown legacy values and rolls back all changes', async () => {
    const { app, user, workspace } = await verifiedUser();
    const first = app.crm.createLead(user, workspace.id, { title: 'Known legacy lead' });
    const second = app.crm.createLead(user, workspace.id, { title: 'Unknown legacy lead' });
    removeWorkspacePipelineConfiguration(app, workspace.id);
    first.pipelineId = '';
    first.stageId = '';
    second.pipelineId = '';
    second.stageId = '';
    (first as unknown as { legacyStatus: string }).legacyStatus = 'legacy-qualified';
    (second as unknown as { legacyStatus: string }).legacyStatus = 'mystery';

    expect(() =>
      app.crm.backfillLegacyWorkspace(user, workspace.id, {
        leadStatusToStageName: { 'legacy-qualified': 'Qualified' },
      }),
    ).toThrow('Unknown legacy stage or status requires an explicit mapping.');

    expect(app.store.state.crmPipelines.filter((pipeline) => pipeline.workspaceId === workspace.id)).toHaveLength(0);
    expect(first.pipelineId).toBe('');
    expect(second.pipelineId).toBe('');
    expect(app.store.state.auditLogs.some((log) => log.action === 'CRM.PIPELINE.LEGACY_BACKFILLED')).toBe(false);
  });
});
