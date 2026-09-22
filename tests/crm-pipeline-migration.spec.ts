import { verifiedUser } from './helpers';

function stageByName(app: Awaited<ReturnType<typeof verifiedUser>>['app'], pipelineId: string, name: string) {
  const stage = app.store.state.crmStages.find((item) => item.pipelineId === pipelineId && item.name === name);
  if (!stage) throw new Error(`Missing stage ${name}`);
  return stage;
}

describe('CRM pipeline and stage migration', () => {
  it('requires replacement migration for a stage with current records and preserves historical stage IDs', async () => {
    const { app, user, workspace } = await verifiedUser();
    const pipeline = app.store.state.crmPipelines.find((item) => item.workspaceId === workspace.id && item.entityType === 'LEAD' && item.isDefault)!;
    const newStage = stageByName(app, pipeline.id, 'New');
    app.crm.createStage(user, workspace.id, pipeline.id, { name: 'Screening', semanticType: 'PROGRESS' });
    const createdLead = app.crm.createLead(user, workspace.id, { title: 'Stage migration lead' });

    expect(() => app.crm.deactivateStage(user, workspace.id, newStage.id)).toThrow('requires an explicit replacement stage');

    const lead = app.store.state.crmLeads.find((item) => item.id === createdLead.id)!;
    const screening = stageByName(app, pipeline.id, 'Screening');
    const initialHistory = app.store.state.crmStageHistory.find((item) => item.recordId === lead.id)!;
    const result = app.crm.deactivateStage(user, workspace.id, newStage.id, screening.id);

    expect(result.migratedRecords).toBe(1);
    expect(app.store.state.crmLeads.find((item) => item.id === lead.id)?.stageId).toBe(screening.id);
    expect(app.store.state.crmStages.find((stage) => stage.id === newStage.id)?.isActive).toBe(false);
    expect(initialHistory.toStageId).toBe(newStage.id);
    expect(app.store.state.crmStageHistory.filter((item) => item.recordId === lead.id)).toEqual([
      expect.objectContaining({ toStageId: newStage.id }),
      expect.objectContaining({ fromStageId: newStage.id, toStageId: screening.id }),
    ]);
  });

  it('protects default stage structure while allowing a PROGRESS replacement to become default', async () => {
    const { app, user, workspace } = await verifiedUser();
    const pipeline = app.store.state.crmPipelines.find((item) => item.workspaceId === workspace.id && item.entityType === 'LEAD' && item.isDefault)!;
    const newStage = stageByName(app, pipeline.id, 'New');
    const qualified = stageByName(app, pipeline.id, 'Qualified');
    const screening = app.crm.createStage(user, workspace.id, pipeline.id, { name: 'Screening', semanticType: 'PROGRESS' });

    expect(() => app.crm.deactivateStage(user, workspace.id, newStage.id, qualified.id)).toThrow('Default stage cannot be removed');

    app.crm.deactivateStage(user, workspace.id, newStage.id, screening.id);

    expect(app.store.state.crmStages.find((stage) => stage.id === newStage.id)?.isActive).toBe(false);
    expect(app.store.state.crmStages.find((stage) => stage.id === screening.id)?.isDefault).toBe(true);
    expect(app.store.state.crmStages.filter((stage) => stage.pipelineId === pipeline.id && stage.isActive && stage.isDefault)).toEqual([
      expect.objectContaining({ id: screening.id, semanticType: 'PROGRESS' }),
    ]);
  });

  it('validates the full pipeline mapping before mutating records', async () => {
    const { app, user, workspace } = await verifiedUser();
    const source = app.crm.createPipeline(user, workspace.id, {
      entityType: 'DEAL',
      name: 'Legacy Deals',
      stages: [
        { name: 'New', semanticType: 'PROGRESS', isDefault: true },
        { name: 'Negotiation', semanticType: 'PROGRESS' },
        { name: 'Won', semanticType: 'SUCCESS' },
        { name: 'Lost', semanticType: 'FAILURE' },
      ],
    });
    const target = app.crm.createPipeline(user, workspace.id, {
      entityType: 'DEAL',
      name: 'Modern Deals',
      isDefault: true,
      stages: [
        { name: 'New', semanticType: 'PROGRESS', isDefault: true },
        { name: 'Won', semanticType: 'SUCCESS' },
        { name: 'Lost', semanticType: 'FAILURE' },
      ],
    });
    const company = app.crmCore.createCompany(user, workspace.id, { name: 'Migration Co' });
    const sourceNew = stageByName(app, source.pipeline.id, 'New');
    const sourceNegotiation = stageByName(app, source.pipeline.id, 'Negotiation');
    const targetNew = stageByName(app, target.pipeline.id, 'New');
    const firstDeal = app.crm.createDeal(user, workspace.id, {
      title: 'First mapped deal',
      companyId: company.id,
      pipelineId: source.pipeline.id,
      stageId: sourceNew.id,
    });
    const secondDeal = app.crm.createDeal(user, workspace.id, {
      title: 'Second mapped deal',
      companyId: company.id,
      pipelineId: source.pipeline.id,
      stageId: sourceNegotiation.id,
    });

    expect(() =>
      app.crm.deactivatePipeline(user, workspace.id, source.pipeline.id, {
        targetPipelineId: target.pipeline.id,
        stageMappings: [{ fromStageId: sourceNew.id, toStageId: targetNew.id }],
      }),
    ).toThrow('must include exactly one target');

    expect(firstDeal.pipelineId).toBe(source.pipeline.id);
    expect(secondDeal.pipelineId).toBe(source.pipeline.id);
    expect(source.pipeline.isActive).toBe(true);
    expect(app.store.state.crmStageHistory.filter((item) => item.recordId === firstDeal.id)).toHaveLength(1);
  });

  it('migrates a pipeline all-or-nothing and deactivates old stages without rewriting history', async () => {
    const { app, user, workspace } = await verifiedUser();
    const source = app.crm.createPipeline(user, workspace.id, {
      entityType: 'LEAD',
      name: 'Legacy Leads',
      stages: [
        { name: 'New', semanticType: 'PROGRESS', isDefault: true },
        { name: 'Qualified', semanticType: 'SUCCESS' },
        { name: 'Disqualified', semanticType: 'FAILURE' },
      ],
    });
    const target = app.crm.createPipeline(user, workspace.id, {
      entityType: 'LEAD',
      name: 'Modern Leads',
      isDefault: true,
      stages: [
        { name: 'New', semanticType: 'PROGRESS', isDefault: true },
        { name: 'Accepted', semanticType: 'SUCCESS' },
        { name: 'Rejected', semanticType: 'FAILURE' },
      ],
    });
    const sourceNew = stageByName(app, source.pipeline.id, 'New');
    const targetNew = stageByName(app, target.pipeline.id, 'New');
    const lead = app.crm.createLead(user, workspace.id, { title: 'Pipeline migration lead', pipelineId: source.pipeline.id });
    const initialHistory = app.store.state.crmStageHistory.find((item) => item.recordId === lead.id)!;

    const result = app.crm.deactivatePipeline(user, workspace.id, source.pipeline.id, {
      targetPipelineId: target.pipeline.id,
      stageMappings: [{ fromStageId: sourceNew.id, toStageId: targetNew.id }],
    });

    expect(result.migratedRecords).toBe(1);
    expect(source.pipeline.isActive).toBe(false);
    expect(app.store.state.crmStages.filter((stage) => stage.pipelineId === source.pipeline.id && stage.isActive)).toHaveLength(0);
    expect(lead.pipelineId).toBe(target.pipeline.id);
    expect(lead.stageId).toBe(targetNew.id);
    expect(initialHistory.toPipelineId).toBe(source.pipeline.id);
    expect(initialHistory.toStageId).toBe(sourceNew.id);
    expect(app.store.state.crmStageHistory.filter((item) => item.recordId === lead.id)).toEqual([
      expect.objectContaining({ toPipelineId: source.pipeline.id, toStageId: sourceNew.id }),
      expect.objectContaining({ fromPipelineId: source.pipeline.id, fromStageId: sourceNew.id, toPipelineId: target.pipeline.id, toStageId: targetNew.id }),
    ]);
    expect(app.store.state.auditLogs.some((log) => log.action === 'CRM.PIPELINE.DEACTIVATED' && log.entityId === source.pipeline.id)).toBe(true);
  });

  it('protects the last active pipeline for an entity type', async () => {
    const { app, user, workspace } = await verifiedUser();
    const defaultLeadPipeline = app.store.state.crmPipelines.find(
      (item) => item.workspaceId === workspace.id && item.entityType === 'LEAD' && item.isDefault,
    )!;

    expect(() => app.crm.deactivatePipeline(user, workspace.id, defaultLeadPipeline.id)).toThrow('last active pipeline');
  });
});
