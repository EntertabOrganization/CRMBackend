import { evaluateCondition } from '@/src/server/fields/requirement-service';
import { actorOf, addMember, CRM_READ_UPDATE, expectAppError, fullApp } from './support/domain';

type App = Awaited<ReturnType<typeof fullApp>>;

const field = (t: App, input: Record<string, unknown>) => t.app.fields.definitions.create(t.user, t.workspace.id, { entityType: 'LEAD', ...input }) as any;
const rule = (t: App, input: Record<string, unknown>) => t.app.fields.requirements.create(t.user, t.workspace.id, { entityType: 'LEAD', ...input }) as any;

function leadPipeline(t: App) {
  const pipeline = t.app.store.state.crmPipelines.find((item) => item.workspaceId === t.workspace.id && item.entityType === 'LEAD' && item.isDefault)!;
  const stages = t.app.store.state.crmStages.filter((item) => item.pipelineId === pipeline.id);
  return { pipeline, initial: stages.find((s) => s.isDefault)!, qualified: stages.find((s) => s.name === 'Qualified')! };
}

const newLead = (t: App, extra: Record<string, unknown> = {}) => t.app.crm.createLead(t.user, t.workspace.id, { title: 'Lead', ...extra });

function customValues(t: App, lead: { id: string }) {
  return t.app.fields.decorate(actorOf(t.app, t.user, t.workspace.id), 'LEAD', [lead as any])[0].customFields as Record<string, any>;
}

describe('Required Fields - rule evaluation', () => {
  it('supports required rules for supported system and custom fields', async () => {
    const t = await fullApp();
    const contract = field(t, { label: 'Contract number', code: 'contract_number', fieldType: 'TEXT' });
    rule(t, { target: { kind: 'SYSTEM', key: 'estimatedAmount' } });
    rule(t, { target: { kind: 'CUSTOM', fieldId: contract.id } });
    const error = await expectAppError(() => newLead(t), 'FIELD_VALIDATION_FAILED');
    expect(error.details.fields.estimatedAmount).toEqual([expect.objectContaining({ code: 'REQUIRED', message: 'Estimated amount is required.' })]);
    expect(error.details.fields.contract_number).toEqual([expect.objectContaining({ code: 'REQUIRED' })]);
    // Protected/internal system fields cannot be targeted.
    await expectAppError(() => rule(t, { target: { kind: 'SYSTEM', key: 'status' } }), 'FIELD_REQUIREMENT_INVALID', 400);
    await expectAppError(() => rule(t, { target: { kind: 'SYSTEM', key: 'nope' } }), 'FIELD_REQUIREMENT_INVALID', 400);
    const lead = newLead(t, { estimatedAmount: 10, customFields: { contract_number: 'C-1' } });
    expect(customValues(t, lead)).toEqual({ contract_number: 'C-1' });
  });

  it('treats 0 and false as present while whitespace, empty arrays and null are empty', async () => {
    const t = await fullApp();
    const count = field(t, { label: 'Count', code: 'count', fieldType: 'INTEGER' });
    const vip = field(t, { label: 'Vip', code: 'vip', fieldType: 'BOOLEAN' });
    const note = field(t, { label: 'Note', code: 'note', fieldType: 'TEXT' });
    const tags = field(t, { label: 'Tags', code: 'tags', fieldType: 'MULTI_LIST', options: [{ label: 'A' }] });
    for (const target of [count, vip, note, tags]) rule(t, { target: { kind: 'CUSTOM', fieldId: target.id } });

    const zeroFalse = newLead(t, { customFields: { count: 0, vip: false, note: 'x', tags: [tags.options[0].id] } });
    expect(customValues(t, zeroFalse)).toMatchObject({ count: 0, vip: false });
    const error = await expectAppError(() => newLead(t, { customFields: { count: null, vip: null, note: '   ', tags: [] } }), 'FIELD_VALIDATION_FAILED');
    expect(Object.keys(error.details.fields).sort()).toEqual(['count', 'note', 'tags', 'vip']);
    // Missing on create with no default is empty too.
    const missing = await expectAppError(() => newLead(t), 'FIELD_VALIDATION_FAILED');
    expect(Object.keys(missing.details.fields).sort()).toEqual(['count', 'note', 'tags', 'vip']);
  });

  it('enforces global rules on create and update', async () => {
    const t = await fullApp();
    const region = field(t, { label: 'Region', code: 'region', fieldType: 'TEXT' });
    const lead = newLead(t); // created before the rule exists
    rule(t, { target: { kind: 'CUSTOM', fieldId: region.id } });
    await expectAppError(() => newLead(t), 'FIELD_VALIDATION_FAILED');
    // Updating any field re-evaluates the rule against the post-write state.
    await expectAppError(() => t.app.crmCore.updateRecord(t.user, t.workspace.id, 'LEAD', lead.id, { expectedVersion: lead.version, title: 'Renamed' }), 'FIELD_VALIDATION_FAILED');
    t.app.crmCore.updateRecord(t.user, t.workspace.id, 'LEAD', lead.id, { expectedVersion: lead.version, title: 'Renamed', customFields: { region: 'North' } });
    expect(lead.title).toBe('Renamed');
    // Clearing a required value on a later save is refused, and nothing changes.
    await expectAppError(() => t.app.crmCore.updateRecord(t.user, t.workspace.id, 'LEAD', lead.id, { expectedVersion: lead.version, customFields: { region: null } }), 'FIELD_VALIDATION_FAILED');
    expect(customValues(t, lead).region).toBe('North');
  });

  it('enforces target pipeline/stage rules before a stage transition commits, and on later saves in that stage', async () => {
    const t = await fullApp();
    const { pipeline, initial, qualified } = leadPipeline(t);
    const budget = field(t, { label: 'Budget approved', code: 'budget_approved', fieldType: 'BOOLEAN' });
    const owner = field(t, { label: 'Deal owner', code: 'deal_owner', fieldType: 'TEXT' });
    const stageRule = rule(t, { target: { kind: 'CUSTOM', fieldId: budget.id }, pipelineId: pipeline.id, stageId: qualified.id });
    rule(t, { target: { kind: 'CUSTOM', fieldId: owner.id }, pipelineId: pipeline.id });
    // Creating in the initial stage needs only the pipeline-wide rule.
    await expectAppError(() => newLead(t), 'FIELD_VALIDATION_FAILED');
    const lead = newLead(t, { customFields: { deal_owner: 'Ahmed' } });
    expect(lead.stageId).toBe(initial.id);

    const before = { version: lead.version, stageId: lead.stageId, history: t.app.store.state.crmStageHistory.length, events: t.app.store.state.outboxEvents.length };
    const error = await expectAppError(
      () => t.app.crm.transitionLead(t.user, t.workspace.id, lead.id, { expectedVersion: lead.version, targetStageId: qualified.id }),
      'FIELD_VALIDATION_FAILED',
    );
    expect(error.details.fields.budget_approved[0].code).toBe('REQUIRED');
    // The transition did not commit: no stage change, history row or event.
    expect(lead).toMatchObject({ version: before.version, stageId: before.stageId });
    expect(t.app.store.state.crmStageHistory.length).toBe(before.history);
    expect(t.app.store.state.outboxEvents.length).toBe(before.events);

    // False satisfies the rule, and the value can be supplied together with the transition.
    const moved = t.app.crm.transitionLead(t.user, t.workspace.id, lead.id, { expectedVersion: lead.version, targetStageId: qualified.id, customFields: { budget_approved: false } });
    expect(moved.stageId).toBe(qualified.id);
    expect(customValues(t, lead).budget_approved).toBe(false);
    // While the record stays in that stage every normal save keeps the rule.
    await expectAppError(() => t.app.crmCore.updateRecord(t.user, t.workspace.id, 'LEAD', lead.id, { expectedVersion: lead.version, customFields: { budget_approved: null } }), 'FIELD_VALIDATION_FAILED');
    // Deactivating the rule lifts the requirement.
    t.app.fields.requirements.setActive(t.user, t.workspace.id, stageRule.id, false);
    t.app.crmCore.updateRecord(t.user, t.workspace.id, 'LEAD', lead.id, { expectedVersion: lead.version, customFields: { budget_approved: null } });
  });

  it('evaluates nested ALL/ANY conditional groups with type-aware operators', async () => {
    const t = await fullApp();
    const approval = field(t, { label: 'Approval', code: 'approval', fieldType: 'TEXT' });
    const kind = field(t, { label: 'Kind', code: 'kind', fieldType: 'LIST', options: [{ label: 'Enterprise' }, { label: 'SMB' }] });
    const [enterprise] = kind.options;
    rule(t, {
      target: { kind: 'CUSTOM', fieldId: approval.id },
      conditions: {
        operator: 'ALL',
        children: [
          { type: 'PREDICATE', field: { kind: 'CUSTOM', fieldId: kind.id }, operator: 'EQ', value: enterprise.id },
          {
            type: 'GROUP',
            operator: 'ANY',
            children: [
              { type: 'PREDICATE', field: { kind: 'SYSTEM', key: 'estimatedAmount' }, operator: 'GTE', value: '100000' },
              { type: 'PREDICATE', field: { kind: 'SYSTEM', key: 'sourceDescription' }, operator: 'CONTAINS', value: 'partner' },
            ],
          },
        ],
      },
    });
    // Not enterprise: never required.
    newLead(t, { estimatedAmount: 500000 });
    // Enterprise but neither branch of the ANY matches: not required.
    newLead(t, { estimatedAmount: 10, customFields: { kind: enterprise.id } });
    // Enterprise AND (amount >= 100000): required.
    await expectAppError(() => newLead(t, { estimatedAmount: 100000, customFields: { kind: enterprise.id } }), 'FIELD_VALIDATION_FAILED');
    // Enterprise AND (source contains partner): required, case-insensitively.
    await expectAppError(() => newLead(t, { sourceDescription: 'Big PARTNER referral', customFields: { kind: enterprise.id } }), 'FIELD_VALIDATION_FAILED');
    // Satisfying the requirement passes.
    newLead(t, { estimatedAmount: 100000, customFields: { kind: enterprise.id, approval: 'APR-1' } });
  });

  it('supports every operator deterministically (pure evaluator)', () => {
    const operand = (dataType: any, values: unknown[]) => () => ({ dataType, values, empty: values.length === 0 });
    const p = (operator: string, value?: unknown) => ({ type: 'PREDICATE' as const, field: { kind: 'SYSTEM' as const, key: 'x' }, operator: operator as any, value });
    const num = operand('NUMBER', ['150.5']);
    expect(evaluateCondition(p('EQ', '150.5'), num)).toBe(true);
    expect(evaluateCondition(p('NEQ', '150.5'), num)).toBe(false);
    expect(evaluateCondition(p('GT', '150.49999999'), num)).toBe(true);
    expect(evaluateCondition(p('GTE', '150.5'), num)).toBe(true);
    expect(evaluateCondition(p('LT', '150.5'), num)).toBe(false);
    expect(evaluateCondition(p('LTE', '150.5'), num)).toBe(true);
    expect(evaluateCondition(p('IN', ['1', '150.5']), num)).toBe(true);
    expect(evaluateCondition(p('NOT_IN', ['1', '2']), num)).toBe(true);
    expect(evaluateCondition(p('IS_EMPTY'), num)).toBe(false);
    expect(evaluateCondition(p('IS_NOT_EMPTY'), num)).toBe(true);
    expect(evaluateCondition(p('IS_EMPTY'), operand('TEXT', []))).toBe(true);
    // Multi-value operands: EQ/IN match ANY element, NEQ/NOT_IN match NONE.
    const multi = operand('ENUM', ['a', 'b']);
    expect(evaluateCondition(p('EQ', 'b'), multi)).toBe(true);
    expect(evaluateCondition(p('NEQ', 'b'), multi)).toBe(false);
    expect(evaluateCondition(p('NOT_IN', ['c']), multi)).toBe(true);
    const date = operand('DATE', ['2027-03-01']);
    expect(evaluateCondition(p('GT', '2027-02-28'), date)).toBe(true);
    expect(evaluateCondition(p('LT', '2027-03-01'), date)).toBe(false);
    expect(evaluateCondition(p('EQ', true), operand('BOOLEAN', [true]))).toBe(true);
    // Absent operand values never satisfy comparisons; empty groups and null trees are vacuously true.
    expect(evaluateCondition(p('GT', '1'), operand('NUMBER', []))).toBe(false);
    expect(evaluateCondition(null, num)).toBe(true);
    expect(evaluateCondition({ type: 'GROUP', operator: 'ANY', children: [p('EQ', 'zzz'), p('EQ', '150.5')] }, num)).toBe(true);
    expect(evaluateCondition({ type: 'GROUP', operator: 'ALL', children: [p('EQ', 'zzz'), p('EQ', '150.5')] }, num)).toBe(false);
  });

  it('makes a field required when any applicable rule requires it', async () => {
    const t = await fullApp();
    const { pipeline, qualified } = leadPipeline(t);
    const note = field(t, { label: 'Note', code: 'note', fieldType: 'TEXT' });
    const tier = field(t, { label: 'Tier', code: 'tier', fieldType: 'TEXT' });
    // One rule whose condition is false, one that is true: the true one wins (union semantics, no override).
    rule(t, { target: { kind: 'CUSTOM', fieldId: note.id }, conditions: { type: 'PREDICATE', field: { kind: 'CUSTOM', fieldId: tier.id }, operator: 'EQ', value: 'gold' } });
    rule(t, { target: { kind: 'CUSTOM', fieldId: note.id }, pipelineId: pipeline.id, stageId: qualified.id });
    newLead(t, { customFields: { tier: 'silver' } });
    await expectAppError(() => newLead(t, { customFields: { tier: 'gold' } }), 'FIELD_VALIDATION_FAILED');
    const lead = newLead(t, { customFields: { tier: 'silver' } });
    await expectAppError(() => t.app.crm.transitionLead(t.user, t.workspace.id, lead.id, { expectedVersion: lead.version, targetStageId: qualified.id }), 'FIELD_VALIDATION_FAILED');
  });

  it('rejects unsupported operators and invalid typed condition constants at configuration time', async () => {
    const t = await fullApp();
    const target = field(t, { label: 'Target', code: 'target', fieldType: 'TEXT' });
    const flag = field(t, { label: 'Flag', code: 'flag', fieldType: 'BOOLEAN' });
    const num = field(t, { label: 'Num', code: 'num', fieldType: 'INTEGER' });
    const bad = async (conditions: unknown, message?: RegExp) => {
      const error = await expectAppError(() => rule(t, { target: { kind: 'CUSTOM', fieldId: target.id }, conditions }), 'FIELD_REQUIREMENT_INVALID', 400);
      if (message) expect(JSON.stringify(error.details)).toMatch(message);
    };
    await bad({ type: 'PREDICATE', field: { kind: 'CUSTOM', fieldId: flag.id }, operator: 'GT', value: true }, /not supported for BOOLEAN/);
    await bad({ type: 'PREDICATE', field: { kind: 'CUSTOM', fieldId: num.id }, operator: 'CONTAINS', value: '1' }, /not supported for NUMBER/);
    await bad({ type: 'PREDICATE', field: { kind: 'CUSTOM', fieldId: num.id }, operator: 'GT', value: 'abc' }, /not a valid NUMBER/);
    await bad({ type: 'PREDICATE', field: { kind: 'CUSTOM', fieldId: num.id }, operator: 'IN', value: 'not-an-array' });
    await bad({ type: 'PREDICATE', field: { kind: 'CUSTOM', fieldId: num.id }, operator: 'EVAL', value: '1' }, /Unsupported operator/);
    await bad({ type: 'PREDICATE', field: { kind: 'SYSTEM', key: 'not_a_field' }, operator: 'EQ', value: 'x' }, /cannot be used/);
    await bad({ type: 'PREDICATE', field: { kind: 'CUSTOM', fieldId: '00000000-0000-4000-8000-000000000000' }, operator: 'EQ', value: 'x' });
    await bad({ type: 'GROUP', operator: 'XOR', children: [] });
    await bad({ type: 'GROUP', operator: 'ALL', children: [] });
    await bad({ type: 'PREDICATE', field: { kind: 'SYSTEM', key: 'title' }, operator: 'EQ', value: { $where: 'sleep(1000)' } });
    // No arbitrary expressions: only the declarative shape is accepted.
    await bad('title == "x" && process.exit(1)');
    // Nesting depth is bounded.
    let deep: any = { type: 'PREDICATE', field: { kind: 'SYSTEM', key: 'title' }, operator: 'EQ', value: 'x' };
    for (let i = 0; i < 8; i += 1) deep = { type: 'GROUP', operator: 'ALL', children: [deep] };
    await bad(deep, /nested at most/);
  });

  it('keeps legacy records readable after a new rule but enforces on next save/transition', async () => {
    const t = await fullApp();
    const { qualified } = leadPipeline(t);
    const legacy = newLead(t);
    const reason = field(t, { label: 'Reason', code: 'reason', fieldType: 'TEXT' });
    rule(t, { target: { kind: 'CUSTOM', fieldId: reason.id } });
    // Nothing is backfilled or rejected on read.
    expect(t.app.crmCore.getRecord(t.user, t.workspace.id, 'LEAD', legacy.id).id).toBe(legacy.id);
    expect(t.app.crmCore.listLeads(t.user, t.workspace.id, new URLSearchParams()).data.map((item: any) => item.id)).toContain(legacy.id);
    expect(customValues(t, legacy)).toEqual({ reason: null });
    // The next normal save or transition is where the rule applies.
    await expectAppError(() => t.app.crm.transitionLead(t.user, t.workspace.id, legacy.id, { expectedVersion: legacy.version, targetStageId: qualified.id }), 'FIELD_VALIDATION_FAILED');
    await expectAppError(() => t.app.crmCore.updateRecord(t.user, t.workspace.id, 'LEAD', legacy.id, { expectedVersion: legacy.version, title: 'x' }), 'FIELD_VALIDATION_FAILED');
    // The schema tells the UI what is required right now.
    const schema = t.app.fields.schema.getSchema(t.user, t.workspace.id, 'LEAD', { surface: 'edit', entityId: legacy.id }) as any;
    expect(schema.fields.find((item: any) => item.code === 'reason').required).toBe(true);
  });

  it('does not allow API, Import, Forms or Automation normal paths to bypass requirements', async () => {
    const t = await fullApp();
    const imported = field(t, { label: 'Imported note', code: 'imported_note', fieldType: 'TEXT', availableInImport: true, availableInForms: true });
    rule(t, { target: { kind: 'CUSTOM', fieldId: imported.id } });
    const actor = actorOf(t.app, t.user, t.workspace.id);
    const write = (origin: any, supplied: unknown) =>
      t.app.fields.validateWrite({ actor, entityType: 'LEAD', entityId: null, isCreate: true, supplied, systemState: { title: 'x' }, origin });
    for (const origin of ['API', 'FORM', 'IMPORT', 'AUTOMATION']) {
      await expectAppError(() => write(origin, {}), 'FIELD_VALIDATION_FAILED');
      expect(write(origin, { imported_note: 'ok' }).changes.size).toBe(1);
    }
    // Automation/internal creation goes through the same domain service, so it is validated too.
    await expectAppError(() => newLead(t), 'FIELD_VALIDATION_FAILED');
    // Lead conversion creates a deal through the same path.
    const dealField = field(t, { entityType: 'DEAL', label: 'Deal note', code: 'deal_note', fieldType: 'TEXT' });
    t.app.fields.requirements.create(t.user, t.workspace.id, { entityType: 'DEAL', target: { kind: 'CUSTOM', fieldId: dealField.id } });
    const lead = t.app.crm.createLead(t.user, t.workspace.id, { title: 'To convert', customFields: { imported_note: 'ok' } });
    const conversion = { expectedVersion: lead.version, contact: { action: 'CREATE' as const }, company: { action: 'NONE' as const }, deal: { action: 'CREATE' as const } };
    await expectAppError(() => t.app.crmCore.convertLead(t.user, t.workspace.id, lead.id, conversion), 'FIELD_VALIDATION_FAILED');
    expect(t.app.store.state.crmContacts).toHaveLength(0); // the failed conversion rolled everything back
    const converted = t.app.crmCore.convertLead(t.user, t.workspace.id, lead.id, { ...conversion, deal: { action: 'CREATE', customFields: { deal_note: 'from conversion' } } }) as any;
    expect(converted.deal.id).toBeTruthy();
  });

  it('allows only an explicit, audited, reasoned repair to bypass requirement rules', async () => {
    const t = await fullApp();
    const reason = field(t, { label: 'Reason', code: 'reason', fieldType: 'TEXT' });
    rule(t, { target: { kind: 'CUSTOM', fieldId: reason.id } });
    const actor = actorOf(t.app, t.user, t.workspace.id);
    const args = { actor, entityType: 'LEAD', entityId: null, isCreate: true, supplied: {}, systemState: {} };
    await expectAppError(() => t.app.fields.validateWrite({ ...args, repair: { serviceIdentity: 'repair-job', reason: '   ' } }), 'VALIDATION_BYPASS_FORBIDDEN', 403);
    const prepared = t.app.fields.validateWrite({ ...args, repair: { serviceIdentity: 'repair-job', reason: 'Backfill legacy import #42' } });
    expect(prepared.violations).toEqual({});
    const audit = t.app.store.state.auditLogs.find((log) => log.action === 'CUSTOM_FIELD.VALIDATION_BYPASSED')!;
    expect(audit.metadata).toMatchObject({ serviceIdentity: 'repair-job', reason: 'Backfill legacy import #42' });
    // Type validation is never bypassed, even by a repair.
    field(t, { label: 'Count', code: 'count', fieldType: 'INTEGER' });
    await expectAppError(() => t.app.fields.validateWrite({ ...args, supplied: { count: 'x' }, repair: { serviceIdentity: 'repair-job', reason: 'r' } }), 'FIELD_VALIDATION_FAILED');
  });

  it('prevents a knowingly hidden/uneditable field from becoming an unsatisfiable requirement', async () => {
    const t = await fullApp();
    const member = await addMember(t.app, t.user, t.workspace.id, 'rep', [...CRM_READ_UPDATE, ['crm.lead.create', 'WORKSPACE']]);
    const restricted = field(t, { label: 'Margin', code: 'margin', fieldType: 'DECIMAL', restrictions: [{ subjectType: 'ROLE', subjectId: member.role.id, restriction: 'READ_ONLY' }] });
    await expectAppError(() => rule(t, { target: { kind: 'CUSTOM', fieldId: restricted.id } }), 'FIELD_REQUIREMENT_CONFIGURATION_CONFLICT', 409);
    // ...and a required field cannot be restricted afterwards either.
    const open = field(t, { label: 'Open', code: 'open', fieldType: 'TEXT' });
    rule(t, { target: { kind: 'CUSTOM', fieldId: open.id } });
    await expectAppError(() => t.app.fields.definitions.update(t.user, t.workspace.id, open.id, { version: open.version, restrictions: [{ subjectType: 'ROLE', subjectId: member.role.id, restriction: 'HIDDEN' }] }), 'FIELD_REQUIREMENT_CONFIGURATION_CONFLICT', 409);
  });

  it('reports a configuration error (naming no field) when a legacy requirement cannot be completed by the actor', async () => {
    const t = await fullApp();
    const member = await addMember(t.app, t.user, t.workspace.id, 'rep', [...CRM_READ_UPDATE, ['crm.lead.create', 'WORKSPACE']]);
    const open = field(t, { label: 'Open', code: 'open', fieldType: 'TEXT' });
    const created = rule(t, { target: { kind: 'CUSTOM', fieldId: open.id } });
    t.app.fields.requirements.setActive(t.user, t.workspace.id, created.id, false);
    const lead = newLead(t, { customFields: { open: 'x' } });
    t.app.crmCore.updateRecord(t.user, t.workspace.id, 'LEAD', lead.id, { expectedVersion: lead.version, customFields: { open: null } });
    // Restrict AFTER the fact (possible while the rule is inactive), then re-activate through a repair-style direct edit.
    t.app.store.state.crmFieldVisibilityRules.push({ id: 'r1', workspaceId: t.workspace.id, fieldId: open.id, subjectType: 'ROLE', subjectId: member.role.id, restriction: 'HIDDEN', createdAt: new Date(), updatedAt: new Date() });
    t.app.store.state.crmFieldRequirements.find((item) => item.id === created.id)!.isActive = true;
    const error = await expectAppError(() => t.app.crmCore.updateRecord(member.user, t.workspace.id, 'LEAD', lead.id, { expectedVersion: lead.version, title: 'Edited' }), 'FIELD_REQUIREMENT_CONFIGURATION_CONFLICT', 409);
    expect(error.message).not.toMatch(/open|Open/);
  });

  it('applies requirement rules to Activities registered with the same engine', async () => {
    const t = await fullApp();
    const outcome = t.app.fields.definitions.create(t.user, t.workspace.id, { entityType: 'ACTIVITY', label: 'Outcome', code: 'outcome', fieldType: 'TEXT' }) as any;
    t.app.fields.requirements.create(t.user, t.workspace.id, { entityType: 'ACTIVITY', target: { kind: 'CUSTOM', fieldId: outcome.id } });
    await expectAppError(() => t.app.activities.create(t.user, t.workspace.id, { typeCode: 'FOLLOW_UP', subject: 'Call back' }), 'FIELD_VALIDATION_FAILED');
    const created = await t.app.activities.create(t.user, t.workspace.id, { typeCode: 'FOLLOW_UP', subject: 'Call back', customFields: { outcome: 'pending' } });
    expect(created.customFields).toEqual({ outcome: 'pending' });
  });

  it('administers rules with versions, activation and safe deletion, and lists system field descriptors', async () => {
    const t = await fullApp();
    const created = rule(t, { target: { kind: 'SYSTEM', key: 'estimatedAmount' } });
    await expectAppError(() => t.app.fields.requirements.update(t.user, t.workspace.id, created.id, { target: { kind: 'SYSTEM', key: 'sourceDescription' } }), 'CONFIGURATION_VERSION_REQUIRED', 400);
    const updated = t.app.fields.requirements.update(t.user, t.workspace.id, created.id, { version: created.version, target: { kind: 'SYSTEM', key: 'sourceDescription' } }) as any;
    expect(updated.targetSystemFieldKey).toBe('sourceDescription');
    await expectAppError(() => t.app.fields.requirements.update(t.user, t.workspace.id, created.id, { version: created.version, target: { kind: 'SYSTEM', key: 'city' } }), 'CONFIGURATION_VERSION_CONFLICT', 409);
    const listed = t.app.fields.requirements.list(t.user, t.workspace.id, new URLSearchParams({ entityType: 'LEAD' })) as any;
    expect(listed.data).toHaveLength(1);
    const descriptors = t.app.fields.requirements.systemFields(t.user, t.workspace.id, 'LEAD') as any[];
    expect(descriptors.find((item) => item.key === 'estimatedAmount').operators).toContain('GTE');
    expect(descriptors.find((item) => item.key === 'title').requirementCapable).toBe(false);
    t.app.fields.requirements.delete(t.user, t.workspace.id, created.id);
    expect(t.app.store.state.auditLogs.map((log) => log.action)).toEqual(expect.arrayContaining(['FIELD_REQUIREMENT.CREATED', 'FIELD_REQUIREMENT.UPDATED', 'FIELD_REQUIREMENT.DELETED_IF_SAFE']));
    const member = await addMember(t.app, t.user, t.workspace.id, 'nope', CRM_READ_UPDATE);
    await expectAppError(() => t.app.fields.requirements.list(member.user, t.workspace.id, new URLSearchParams()), 'PERMISSION_DENIED', 403);
  });
});
