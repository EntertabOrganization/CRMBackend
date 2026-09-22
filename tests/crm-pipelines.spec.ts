import { verifiedUser } from './helpers';

function stageByName(app: Awaited<ReturnType<typeof verifiedUser>>['app'], pipelineId: string, name: string) {
  const stage = app.store.state.crmStages.find((item) => item.pipelineId === pipelineId && item.name === name);
  if (!stage) throw new Error(`Missing stage ${name}`);
  return stage;
}

describe('CRM pipeline engine', () => {
  it('bootstraps valid default Lead and Deal pipelines for every new workspace', async () => {
    const { app, workspace } = await verifiedUser();

    const leadPipeline = app.store.state.crmPipelines.find(
      (pipeline) => pipeline.workspaceId === workspace.id && pipeline.entityType === 'LEAD' && pipeline.isDefault,
    );
    const dealPipeline = app.store.state.crmPipelines.find(
      (pipeline) => pipeline.workspaceId === workspace.id && pipeline.entityType === 'DEAL' && pipeline.isDefault,
    );

    expect(leadPipeline?.name).toBe('Default Lead Pipeline');
    expect(dealPipeline?.name).toBe('Default Deal Pipeline');
    expect(app.store.state.crmStages.filter((stage) => stage.pipelineId === leadPipeline?.id).map((stage) => [stage.name, stage.semanticType, stage.isDefault])).toEqual([
      ['New', 'PROGRESS', true],
      ['Qualified', 'SUCCESS', false],
      ['Disqualified', 'FAILURE', false],
    ]);
    expect(app.store.state.crmStages.filter((stage) => stage.pipelineId === dealPipeline?.id).map((stage) => [stage.name, stage.semanticType, stage.isDefault])).toEqual([
      ['New', 'PROGRESS', true],
      ['Won', 'SUCCESS', false],
      ['Lost', 'FAILURE', false],
    ]);
  });

  it('supports multiple pipelines while enforcing default and case-insensitive name invariants per entity type', async () => {
    const { app, user, workspace } = await verifiedUser();

    const leadSales = app.crm.createPipeline(user, workspace.id, {
      entityType: 'LEAD',
      name: 'Sales',
      stages: [
        { name: 'New', semanticType: 'PROGRESS', isDefault: true },
        { name: 'Qualified', semanticType: 'SUCCESS' },
        { name: 'Disqualified', semanticType: 'FAILURE' },
      ],
    });
    const dealSales = app.crm.createPipeline(user, workspace.id, {
      entityType: 'DEAL',
      name: 'Sales',
      isDefault: true,
      stages: [
        { name: 'New', semanticType: 'PROGRESS', isDefault: true },
        { name: 'Won', semanticType: 'SUCCESS' },
        { name: 'Lost', semanticType: 'FAILURE' },
      ],
    });

    expect(leadSales.pipeline.entityType).toBe('LEAD');
    expect(dealSales.pipeline.entityType).toBe('DEAL');
    expect(app.store.state.crmPipelines.filter((pipeline) => pipeline.workspaceId === workspace.id && pipeline.entityType === 'DEAL' && pipeline.isDefault)).toHaveLength(1);
    expect(() =>
      app.crm.createPipeline(user, workspace.id, {
        entityType: 'LEAD',
        name: ' sales ',
        stages: [
          { name: 'New', semanticType: 'PROGRESS', isDefault: true },
          { name: 'Qualified', semanticType: 'SUCCESS' },
          { name: 'Disqualified', semanticType: 'FAILURE' },
        ],
      }),
    ).toThrow('Pipeline name already exists');
  });

  it('rejects active pipelines and stages that violate semantic structure', async () => {
    const { app, user, workspace } = await verifiedUser();
    const leadPipeline = app.store.state.crmPipelines.find((pipeline) => pipeline.workspaceId === workspace.id && pipeline.entityType === 'LEAD' && pipeline.isDefault)!;
    const defaultStage = stageByName(app, leadPipeline.id, 'New');
    const successStage = stageByName(app, leadPipeline.id, 'Qualified');

    expect(() =>
      app.crm.createPipeline(user, workspace.id, {
        entityType: 'LEAD',
        name: 'Broken',
        stages: [
          { name: 'New', semanticType: 'PROGRESS', isDefault: true },
          { name: 'Also New', semanticType: 'PROGRESS' },
          { name: 'Disqualified', semanticType: 'FAILURE' },
        ],
      }),
    ).toThrow('exactly one SUCCESS');

    expect(() => app.crm.updateStage(user, workspace.id, defaultStage.id, { isDefault: false })).toThrow('default PROGRESS');
    expect(() => app.crm.updateStage(user, workspace.id, successStage.id, { semanticType: 'PROGRESS' })).toThrow('exactly one SUCCESS');
  });

  it('creates records in default stages and performs valid transitions with history audit and outbox side effects', async () => {
    const { app, user, workspace } = await verifiedUser();
    const leadPipeline = app.store.state.crmPipelines.find((pipeline) => pipeline.workspaceId === workspace.id && pipeline.entityType === 'LEAD' && pipeline.isDefault)!;
    const qualified = stageByName(app, leadPipeline.id, 'Qualified');
    const lead = app.crm.createLead(user, workspace.id, { title: 'Website inquiry' });

    const moved = app.crm.transitionLead(user, workspace.id, lead.id, {
      expectedVersion: lead.version,
      targetStageId: qualified.id,
    });

    expect(moved.stageId).toBe(qualified.id);
    expect(moved.status).toBe('QUALIFIED');
    expect(moved.version).toBe(2);
    expect(app.store.state.crmStageHistory.filter((history) => history.recordId === lead.id)).toHaveLength(2);
    expect(app.store.state.auditLogs.some((log) => log.action === 'CRM.LEAD.STAGE_CHANGED' && log.entityId === lead.id)).toBe(true);
    expect(app.store.state.outboxEvents.some((event) => event.eventType === 'CRM.LEAD.STAGE_CHANGED' && event.entityId === lead.id)).toBe(true);
  });

  it('requires explicit valid cross-pipeline targets and prevents entity type or wrong-stage moves', async () => {
    const { app, user, workspace } = await verifiedUser();
    const lead = app.crm.createLead(user, workspace.id, { title: 'Partner inquiry' });
    const secondary = app.crm.createPipeline(user, workspace.id, {
      entityType: 'LEAD',
      name: 'Partner Leads',
      stages: [
        { name: 'New', semanticType: 'PROGRESS', isDefault: true },
        { name: 'Accepted', semanticType: 'SUCCESS' },
        { name: 'Rejected', semanticType: 'FAILURE' },
      ],
    });
    const dealPipeline = app.store.state.crmPipelines.find((pipeline) => pipeline.workspaceId === workspace.id && pipeline.entityType === 'DEAL' && pipeline.isDefault)!;
    const dealStage = stageByName(app, dealPipeline.id, 'Won');
    const secondarySuccess = stageByName(app, secondary.pipeline.id, 'Accepted');

    expect(() =>
      app.crm.transitionLead(user, workspace.id, lead.id, {
        expectedVersion: lead.version,
        targetPipelineId: dealPipeline.id,
        targetStageId: dealStage.id,
      }),
    ).toThrow('Target pipeline does not match');

    expect(() =>
      app.crm.transitionLead(user, workspace.id, lead.id, {
        expectedVersion: lead.version,
        targetPipelineId: secondary.pipeline.id,
        targetStageId: dealStage.id,
      }),
    ).toThrow('Target stage does not belong');

    const moved = app.crm.transitionLead(user, workspace.id, lead.id, {
      expectedVersion: lead.version,
      targetPipelineId: secondary.pipeline.id,
      targetStageId: secondarySuccess.id,
    });
    expect(moved.pipelineId).toBe(secondary.pipeline.id);
    expect(moved.stageId).toBe(secondarySuccess.id);
  });

  it('enforces transition graph, stale version and failure lost reason rules', async () => {
    const { app, user, workspace } = await verifiedUser();
    const company = app.crmCore.createCompany(user, workspace.id, { name: 'Acme' });
    const graphPipeline = app.crm.createPipeline(user, workspace.id, {
      entityType: 'DEAL',
      name: 'Graph Deals',
      transitionRulesEnabled: true,
      stages: [
        { name: 'New', semanticType: 'PROGRESS', isDefault: true },
        { name: 'Won', semanticType: 'SUCCESS' },
        { name: 'Lost', semanticType: 'FAILURE' },
      ],
    });
    const deal = app.crm.createDeal(user, workspace.id, { title: 'Enterprise sale', pipelineId: graphPipeline.pipeline.id, companyId: company.id });
    const won = stageByName(app, graphPipeline.pipeline.id, 'Won');
    const lost = stageByName(app, graphPipeline.pipeline.id, 'Lost');
    const current = stageByName(app, graphPipeline.pipeline.id, 'New');

    expect(() => app.crm.transitionDeal(user, workspace.id, deal.id, { expectedVersion: deal.version, targetStageId: won.id })).toThrow('transition graph');

    app.store.state.crmStageTransitions.push({
      id: crypto.randomUUID(),
      workspaceId: workspace.id,
      pipelineId: graphPipeline.pipeline.id,
      fromStageId: current.id,
      toStageId: won.id,
      isActive: true,
    });

    app.crm.transitionDeal(user, workspace.id, deal.id, { expectedVersion: deal.version, targetStageId: won.id });
    expect(() => app.crm.transitionDeal(user, workspace.id, deal.id, { expectedVersion: 1, targetStageId: current.id, overrideTransitionGraph: true })).toThrow('version is stale');
    expect(() => app.crm.transitionDeal(user, workspace.id, deal.id, { expectedVersion: deal.version, targetStageId: lost.id, overrideTransitionGraph: true })).toThrow('lost reason is required');

    app.store.state.crmLostReasons.push({ id: 'too-expensive', workspaceId: workspace.id, name: 'Too expensive', isActive: true, isSystem: false });
    const lostDeal = app.crm.transitionDeal(user, workspace.id, deal.id, {
      expectedVersion: deal.version,
      targetStageId: lost.id,
      overrideTransitionGraph: true,
      lostReasonId: 'too-expensive',
    });
    expect(lostDeal.status).toBe('LOST');
    expect(lostDeal.lostReasonId).toBe('too-expensive');
  });
});
