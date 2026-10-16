import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, type Principal } from '../process-platform/context';
import { encrypt } from '../suite/kernel';
import { assertVersion, audit, emitEvent, notFound, requirePlatform, type PlatformPrincipal, type Tx } from '../platform/kernel';
import { adapterFor, connectionSecret, fingerprintSecret } from './providers';
import { allTools, SCENARIOS, toolByCode } from './registry';

export const CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const;
const region = z.string().regex(/^[a-z]{2,10}(-[a-z0-9]{1,20}){0,3}$/);
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
export const scopeKey = (workspaceId: string | null) => workspaceId ?? 'global';

/** Effective settings: workspace module switch + per-scenario enablement (sensitive HR/Billing scenarios need explicit opt-in). */
export async function workspaceAiSettings(db: PrismaClient | Tx, workspaceId: string) {
  const row = await db.aiWorkspaceSetting.findUnique({ where: { workspaceId } });
  return { moduleEnabled: row?.moduleEnabled ?? false, scenarioSettings: (row?.scenarioSettings ?? {}) as Record<string, { enabled?: boolean; roleIds?: string[] }>, classificationRules: (row?.classificationRules ?? {}) as Record<string, unknown>, version: row?.version ?? 0 };
}
export function scenarioEnabled(settings: Awaited<ReturnType<typeof workspaceAiSettings>>, code: string, roleId: string) {
  const s = SCENARIOS[code]; if (!s || !settings.moduleEnabled) return false;
  const cfg = settings.scenarioSettings[code];
  if (s.sensitive ? cfg?.enabled !== true : cfg?.enabled === false) return false;
  return !cfg?.roleIds?.length || cfg.roleIds.includes(roleId);
}

/** Provider connections, model catalog, routes (29/01), scenarios/prompts/assistants (29/02), tool policy and budgets. */
export class AiConfigService {
  constructor(private readonly db: PrismaClient) {}

  async providers() { return this.db.aiProvider.findMany({ where: { active: true }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, adapterVersion: true } }); }
  async models(raw: unknown) {
    const q = z.object({ capability: z.enum(['chat', 'json', 'transcription', 'image', 'embedding', 'tools']).optional() }).parse(raw);
    const rows = await this.db.aiModel.findMany({ where: { active: true }, orderBy: [{ providerId: 'asc' }, { modelKey: 'asc' }, { catalogVersion: 'desc' }] });
    const latest = rows.filter((m, i) => rows.findIndex(o => o.providerId === m.providerId && o.modelKey === m.modelKey) === i);
    return latest.filter(m => !q.capability || (m.capabilities as string[]).includes(q.capability));
  }
  /** Model price changes create a new catalog version; historical usage keeps its pricing snapshot (01 rule 6). */
  async upsertModel(actor: PlatformPrincipal, raw: unknown, requestId: string) {
    requirePlatform(actor, 'ai.providers.manage');
    const input = z.strictObject({ providerCode: z.string(), modelKey: z.string().regex(/^[a-zA-Z0-9._:\/-]{1,120}$/), capabilities: z.array(z.enum(['chat', 'json', 'transcription', 'image', 'embedding', 'tools'])).min(1), contextLimit: z.number().int().min(1024).max(10000000),
      inputRate: z.string().regex(/^\d+(\.\d{1,8})?$/), outputRate: z.string().regex(/^\d+(\.\d{1,8})?$/), rateCurrency: z.string().regex(/^([A-Z]{3}|CREDIT)$/), regions: z.array(region).max(20).default([]) }).parse(raw);
    return this.db.$transaction(async tx => {
      const provider = await tx.aiProvider.findUnique({ where: { code: input.providerCode } }); if (!provider) throw notFound('Provider');
      const last = await tx.aiModel.findFirst({ where: { providerId: provider.id, modelKey: input.modelKey }, orderBy: { catalogVersion: 'desc' } });
      const row = await tx.aiModel.create({ data: { providerId: provider.id, modelKey: input.modelKey, capabilities: input.capabilities, contextLimit: input.contextLimit, inputRate: new Prisma.Decimal(input.inputRate), outputRate: new Prisma.Decimal(input.outputRate), rateCurrency: input.rateCurrency, regions: input.regions, catalogVersion: (last?.catalogVersion ?? 0) + 1 } });
      await audit(tx, { workspaceId: null, actorId: actor.userId, actorType: 'PLATFORM', action: 'AI_MODEL_CATALOG_CHANGED', resourceType: 'AiModel', resourceId: row.id, after: input, requestId });
      return row;
    });
  }
  /** BYOK secret is sealed and never echoed; platform connections reference a vault entry (env:NAME). */
  async createConnection(actor: Principal | PlatformPrincipal, raw: unknown, requestId: string) {
    const platform = !('workspaceId' in actor);
    if (platform) requirePlatform(actor as PlatformPrincipal, 'ai.providers.manage'); else requirePermission(actor as Principal, 'ai.providers.manage');
    const input = z.strictObject({ provider: z.enum(['OPENAI', 'AZURE_OPENAI', 'ANTHROPIC', 'GOOGLE_GEMINI', 'OPENROUTER', 'SANDBOX']), label: z.string().trim().min(1).max(120), region, endpoint: z.string().max(200).optional(),
      allowedClassifications: z.array(z.enum(CLASSIFICATIONS)).min(1).default(['PUBLIC', 'INTERNAL']),
      secretSubmission: z.discriminatedUnion('mode', [z.strictObject({ mode: z.literal('VAULT_REF'), ref: z.string().regex(/^env:[A-Z][A-Z0-9_]{1,80}$/) }), z.strictObject({ mode: z.literal('BYOK'), apiKey: z.string().min(8).max(500) })]) }).parse(raw);
    if (platform && input.secretSubmission.mode !== 'VAULT_REF') throw new AppError('VALIDATION_FAILED', 'Platform connections use vault references.', 400);
    if (!platform && input.secretSubmission.mode !== 'BYOK') throw new AppError('VALIDATION_FAILED', 'Workspace connections bring their own key (BYOK).', 400);
    return this.db.$transaction(async tx => {
      let provider = await tx.aiProvider.findUnique({ where: { code: input.provider } });
      if (!provider && input.provider === 'SANDBOX') { adapterFor('SANDBOX'); provider = await tx.aiProvider.create({ data: { code: 'SANDBOX', name: 'Sandbox' } }); }
      if (!provider) throw notFound('Provider');
      const workspaceId = platform ? null : (actor as Principal).workspaceId, userId = actor.userId;
      const sub = input.secretSubmission;
      const row = await tx.aiProviderConnection.create({ data: { workspaceId, providerId: provider.id, ownerScope: platform ? 'PLATFORM' : 'WORKSPACE', label: input.label, region: input.region, endpoint: input.endpoint ?? null,
        allowedClassifications: input.allowedClassifications, costResponsibility: platform ? 'PLATFORM' : 'WORKSPACE', createdBy: userId,
        ...(sub.mode === 'VAULT_REF' ? { vaultSecretRef: sub.ref } : { secretSealed: encrypt(sub.apiKey), secretFingerprint: fingerprintSecret(sub.apiKey) }) } });
      await audit(tx, { workspaceId, actorId: userId, actorType: platform ? 'PLATFORM' : 'USER', action: 'AI_PROVIDER_CONNECTION_CREATED', resourceType: 'AiProviderConnection', resourceId: row.id, after: { provider: input.provider, region: input.region, mode: sub.mode }, requestId });
      return this.connectionView(row);
    });
  }
  connectionView(c: Prisma.AiProviderConnectionGetPayload<object>) {
    return { id: c.id, workspaceId: c.workspaceId, providerId: c.providerId, ownerScope: c.ownerScope, label: c.label, region: c.region, endpoint: c.endpoint, status: c.status, allowedClassifications: c.allowedClassifications,
      costResponsibility: c.costResponsibility, verifiedAt: c.verifiedAt, keyFingerprint: c.secretFingerprint ? '…' + c.secretFingerprint.slice(-6) : null, vaultRef: c.vaultSecretRef ? c.vaultSecretRef.split(':')[0] + ':***' : null, version: c.version };
  }
  async connections(actor: Principal) {
    requirePermission(actor, 'ai.providers.manage');
    const rows = await this.db.aiProviderConnection.findMany({ where: { OR: [{ workspaceId: actor.workspaceId }, { workspaceId: null, status: 'CONNECTED' }] }, orderBy: { createdAt: 'desc' } });
    return rows.map(r => this.connectionView(r));
  }
  private async loadConnection(tx: Tx, actor: Principal | PlatformPrincipal, id: string) {
    const c = await tx.aiProviderConnection.findUnique({ where: { id: z.uuid().parse(id) } });
    const platform = !('workspaceId' in actor);
    if (!c || (platform ? c.workspaceId !== null : c.workspaceId !== (actor as Principal).workspaceId)) throw notFound('Connection');
    if (platform) requirePlatform(actor as PlatformPrincipal, 'ai.providers.manage'); else requirePermission(actor as Principal, 'ai.providers.manage');
    return c;
  }
  /** Sanitized verification: provider error bodies are never returned. */
  async verifyConnection(actor: Principal | PlatformPrincipal, id: string, requestId: string) {
    const c = await this.db.$transaction(tx => this.loadConnection(tx, actor, id));
    const provider = await this.db.aiProvider.findUniqueOrThrow({ where: { id: c.providerId } });
    const health = await adapterFor(provider.code).validateConnection(connectionSecret(c), c.endpoint).catch(() => ({ ok: false, detail: 'VERIFY_FAILED' }));
    return this.db.$transaction(async tx => {
      const status = health.ok ? 'CONNECTED' : c.status === 'SUSPENDED' ? 'SUSPENDED' : 'UNVERIFIED';
      const row = await tx.aiProviderConnection.update({ where: { id: c.id }, data: { status, verifiedAt: health.ok ? new Date() : c.verifiedAt, lastError: health.ok ? null : health.detail, version: { increment: 1 } } });
      await audit(tx, { workspaceId: c.workspaceId, actorId: actor.userId, actorType: c.workspaceId ? 'USER' : 'PLATFORM', action: health.ok ? 'AI_PROVIDER_CONNECTED' : 'AI_PROVIDER_VERIFY_FAILED', resourceType: 'AiProviderConnection', resourceId: c.id, after: { status, detail: health.detail }, requestId });
      if (health.ok) await emitEvent(tx, { workspaceId: c.workspaceId, eventType: 'AI_PROVIDER_CONNECTED', aggregateType: 'AiProviderConnection', aggregateId: c.id, aggregateVersion: row.version, actorId: actor.userId, payload: {} });
      return this.connectionView(row);
    });
  }
  /** Suspension blocks new runs immediately (routing reads status live, 01 AC03). */
  async suspendConnection(actor: Principal | PlatformPrincipal, id: string, requestId: string) {
    return this.db.$transaction(async tx => {
      const c = await this.loadConnection(tx, actor, id);
      const row = await tx.aiProviderConnection.update({ where: { id: c.id }, data: { status: 'SUSPENDED', version: { increment: 1 } } });
      await audit(tx, { workspaceId: c.workspaceId, actorId: actor.userId, actorType: c.workspaceId ? 'USER' : 'PLATFORM', action: 'AI_PROVIDER_DISABLED', resourceType: 'AiProviderConnection', resourceId: c.id, requestId });
      await emitEvent(tx, { workspaceId: c.workspaceId, eventType: 'AI_PROVIDER_DISABLED', aggregateType: 'AiProviderConnection', aggregateId: c.id, aggregateVersion: row.version, actorId: actor.userId, payload: {} });
      return this.connectionView(row);
    });
  }
  async rotateKey(actor: Principal, id: string, raw: unknown, requestId: string) {
    const input = z.strictObject({ apiKey: z.string().min(8).max(500) }).parse(raw);
    return this.db.$transaction(async tx => {
      const c = await this.loadConnection(tx, actor, id);
      if (c.ownerScope !== 'WORKSPACE') throw new AppError('VALIDATION_FAILED', 'Platform keys rotate in the vault.', 400);
      const row = await tx.aiProviderConnection.update({ where: { id: c.id }, data: { secretSealed: encrypt(input.apiKey), secretFingerprint: fingerprintSecret(input.apiKey), status: 'UNVERIFIED', version: { increment: 1 } } });
      await audit(tx, { workspaceId: c.workspaceId, actorId: actor.userId, action: 'AI_PROVIDER_KEY_ROTATED', resourceType: 'AiProviderConnection', resourceId: c.id, requestId });
      return this.connectionView(row);
    });
  }
  async routes(actor: Principal) {
    requirePermission(actor, 'ai.routes.manage');
    return this.db.aiRoute.findMany({ where: { OR: [{ workspaceId: actor.workspaceId }, { workspaceId: null }] }, orderBy: [{ scenarioCode: 'asc' }, { priority: 'asc' }] });
  }
  private routeInput = z.strictObject({ scenarioId: z.string().max(80), primaryModelId: z.uuid(), connectionId: z.uuid(), fallbackIds: z.array(z.strictObject({ modelId: z.uuid(), connectionId: z.uuid() })).max(5).default([]),
    regionPolicy: z.array(region).max(20).default([]), classifications: z.array(z.enum(CLASSIFICATIONS)).min(1).default(['PUBLIC', 'INTERNAL']), maxCost: z.string().regex(/^\d+(\.\d{1,6})?$/).nullable().default(null), priority: z.number().int().min(1).max(1000).default(100), enabled: z.boolean().default(true) });
  private async validateRoute(tx: Tx, workspaceId: string | null, input: z.infer<typeof this.routeInput>) {
    const scenario = SCENARIOS[input.scenarioId]; if (!scenario) throw new AppError('VALIDATION_FAILED', 'Unknown scenario.', 400);
    for (const { modelId, connectionId } of [{ modelId: input.primaryModelId, connectionId: input.connectionId }, ...input.fallbackIds]) {
      const [model, conn] = await Promise.all([tx.aiModel.findUnique({ where: { id: modelId } }), tx.aiProviderConnection.findUnique({ where: { id: connectionId } })]);
      if (!model || !conn || (conn.workspaceId !== null && conn.workspaceId !== workspaceId) || model.providerId !== conn.providerId) throw new AppError('VALIDATION_FAILED', 'Model/connection must exist, match the provider and be available to this Workspace.', 400);
      // Capability mismatch is rejected before any charge (01 AC04).
      if (!(model.capabilities as string[]).includes(scenario.capability === 'chat' ? (scenario.output === 'JSON' ? 'json' : 'chat') : scenario.capability)) throw new AppError('VALIDATION_FAILED', `Model lacks the ${scenario.capability} capability required by ${scenario.code}.`, 400);
      if (input.regionPolicy.length && !input.regionPolicy.includes(conn.region)) throw new AppError('VALIDATION_FAILED', 'Every route/fallback must be in an allowed region.', 400);
    }
  }
  async createRoute(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'ai.routes.manage');
    const input = this.routeInput.parse(raw);
    return this.db.$transaction(async tx => {
      await this.validateRoute(tx, actor.workspaceId, input);
      const row = await tx.aiRoute.create({ data: { workspaceId: actor.workspaceId, scenarioCode: input.scenarioId, priority: input.priority, connectionId: input.connectionId, modelId: input.primaryModelId, fallbackIds: input.fallbackIds, allowedRegions: input.regionPolicy,
        allowedClassifications: input.classifications, maxCost: input.maxCost ? new Prisma.Decimal(input.maxCost) : null, enabled: input.enabled } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'AI_ROUTE_CHANGED', resourceType: 'AiRoute', resourceId: row.id, after: input, requestId });
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'AI_ROUTE_CHANGED', aggregateType: 'AiRoute', aggregateId: row.id, aggregateVersion: 1, actorId: actor.userId, payload: { scenario: input.scenarioId } });
      return row;
    });
  }
  async updateRoute(actor: Principal, id: string, raw: unknown, requestId: string) {
    requirePermission(actor, 'ai.routes.manage');
    const input = this.routeInput.extend({ expectedVersion: z.number().int().positive() }).parse(raw);
    return this.db.$transaction(async tx => {
      const route = await tx.aiRoute.findFirst({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId } }); if (!route) throw notFound('Route');
      assertVersion(route.version, input.expectedVersion);
      await this.validateRoute(tx, actor.workspaceId, input);
      const row = await tx.aiRoute.update({ where: { id: route.id }, data: { scenarioCode: input.scenarioId, priority: input.priority, connectionId: input.connectionId, modelId: input.primaryModelId, fallbackIds: input.fallbackIds, allowedRegions: input.regionPolicy,
        allowedClassifications: input.classifications, maxCost: input.maxCost ? new Prisma.Decimal(input.maxCost) : null, enabled: input.enabled, version: { increment: 1 } } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'AI_ROUTE_CHANGED', resourceType: 'AiRoute', resourceId: row.id, before: { modelId: route.modelId, version: route.version }, after: input, requestId });
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'AI_ROUTE_CHANGED', aggregateType: 'AiRoute', aggregateId: row.id, aggregateVersion: row.version, actorId: actor.userId, payload: { scenario: input.scenarioId } });
      return row;
    });
  }

  // ------------------------------------------------------------------ 02 settings, scenarios, prompts, assistants
  async settings(actor: Principal) { requirePermission(actor, 'ai.scenario.execute'); const s = await workspaceAiSettings(this.db, actor.workspaceId); return { ...s, scenarios: Object.values(SCENARIOS).map(sc => ({ code: sc.code, moduleCode: sc.moduleCode, sensitive: sc.sensitive, enabled: scenarioEnabled(s, sc.code, actor.roleId) })) }; }
  /** Only ai.scenario.manage may enable scenarios; sensitive HR scenarios additionally need the module's own admin right (02 AC01). */
  async updateSettings(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'ai.scenario.manage');
    const input = z.strictObject({ expectedVersion: z.number().int().min(0), moduleEnabled: z.boolean().optional(), scenarioSettings: z.record(z.string(), z.strictObject({ enabled: z.boolean(), roleIds: z.array(z.uuid()).max(50).optional() })).optional(),
      classificationRules: z.strictObject({ maxClassification: z.enum(CLASSIFICATIONS).default('INTERNAL') }).optional() }).parse(raw);
    for (const code of Object.keys(input.scenarioSettings ?? {})) {
      const s = SCENARIOS[code]; if (!s) throw new AppError('VALIDATION_FAILED', `Unknown scenario ${code}.`, 400);
      if (s.sensitive && input.scenarioSettings![code].enabled) requirePermission(actor, s.moduleCode === 'hr' ? 'hr.employee.private.read' : 'billing.finance.read');
    }
    return this.db.$transaction(async tx => {
      const current = await tx.aiWorkspaceSetting.findUnique({ where: { workspaceId: actor.workspaceId } });
      assertVersion(current?.version ?? 0, input.expectedVersion);
      const data = { ...(input.moduleEnabled !== undefined ? { moduleEnabled: input.moduleEnabled } : {}), ...(input.scenarioSettings ? { scenarioSettings: { ...(current?.scenarioSettings as object ?? {}), ...input.scenarioSettings } } : {}), ...(input.classificationRules ? { classificationRules: input.classificationRules } : {}) };
      const row = current ? await tx.aiWorkspaceSetting.update({ where: { workspaceId: actor.workspaceId }, data: { ...data, version: { increment: 1 } } }) : await tx.aiWorkspaceSetting.create({ data: { workspaceId: actor.workspaceId, ...data } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'AI_SCENARIO_CHANGED', resourceType: 'AiWorkspaceSetting', resourceId: actor.workspaceId, after: input, requestId });
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'AI_SCENARIO_CHANGED', aggregateType: 'AiWorkspaceSetting', aggregateId: actor.workspaceId, aggregateVersion: row.version, actorId: actor.userId, payload: { scenarios: Object.keys(input.scenarioSettings ?? {}) } });
      return row;
    });
  }
  async createPrompt(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'ai.prompt.publish');
    const input = z.strictObject({ scenarioId: z.string().max(80), content: z.string().trim().min(10).max(20000) }).parse(raw);
    if (!SCENARIOS[input.scenarioId]) throw new AppError('VALIDATION_FAILED', 'Unknown scenario.', 400);
    return this.db.$transaction(async tx => {
      const key = scopeKey(actor.workspaceId);
      const last = await tx.aiPromptTemplate.findFirst({ where: { scenarioCode: input.scenarioId, scopeKey: key }, orderBy: { version: 'desc' } });
      const row = await tx.aiPromptTemplate.create({ data: { scenarioCode: input.scenarioId, scopeKey: key, version: (last?.version ?? 0) + 1, content: input.content, contentHash: sha(input.content), createdBy: actor.userId } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'AI_PROMPT_DRAFTED', resourceType: 'AiPromptTemplate', resourceId: row.id, after: { scenario: input.scenarioId, version: row.version, hash: row.contentHash }, requestId });
      return row;
    });
  }
  /** Publishing retires the previous published version; runs keep pinning whatever version they started with (02 AC02). */
  async publishPrompt(actor: Principal, id: string, raw: unknown, requestId: string) {
    requirePermission(actor, 'ai.prompt.publish');
    const input = z.strictObject({ expectedVersion: z.number().int().positive() }).parse(raw);
    return this.db.$transaction(async tx => {
      const row = await tx.aiPromptTemplate.findFirst({ where: { id: z.uuid().parse(id), scopeKey: scopeKey(actor.workspaceId) } }); if (!row) throw notFound('Prompt');
      assertVersion(row.version, input.expectedVersion);
      if (row.status !== 'DRAFT') throw new AppError('INVALID_STATE_TRANSITION', `Prompt is ${row.status}.`, 409);
      await tx.aiPromptTemplate.updateMany({ where: { scenarioCode: row.scenarioCode, scopeKey: row.scopeKey, status: 'PUBLISHED' }, data: { status: 'RETIRED' } });
      const updated = await tx.aiPromptTemplate.update({ where: { id: row.id }, data: { status: 'PUBLISHED', publishedBy: actor.userId, publishedAt: new Date() } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'AI_PROMPT_PUBLISHED', resourceType: 'AiPromptTemplate', resourceId: row.id, after: { scenario: row.scenarioCode, version: row.version }, requestId });
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'AI_PROMPT_PUBLISHED', aggregateType: 'AiPromptTemplate', aggregateId: row.id, aggregateVersion: row.version, actorId: actor.userId, payload: { scenario: row.scenarioCode } });
      return updated;
    });
  }
  async prompts(actor: Principal, raw: unknown) {
    requirePermission(actor, 'ai.prompt.publish');
    const q = z.object({ scenarioId: z.string().max(80).optional() }).parse(raw);
    return this.db.aiPromptTemplate.findMany({ where: { scopeKey: { in: [scopeKey(actor.workspaceId), 'global'] }, ...(q.scenarioId ? { scenarioCode: q.scenarioId } : {}) }, orderBy: [{ scenarioCode: 'asc' }, { version: 'desc' }] });
  }
  async createAssistant(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'ai.assistant.manage');
    const input = z.strictObject({ name: z.string().trim().min(1).max(120), scenarioIds: z.array(z.string().max(80)).min(1).max(20), promptVersionId: z.uuid().optional(), retrievalProfileId: z.uuid().optional(), allowedTools: z.array(z.string().max(80)).max(30).default([]),
      behaviorRole: z.strictObject({ name: z.string().max(120), instructions: z.string().max(4000), guardrails: z.array(z.string().max(300)).max(20).default([]) }).optional() }).parse(raw);
    for (const s of input.scenarioIds) if (!SCENARIOS[s]) throw new AppError('VALIDATION_FAILED', `Unknown scenario ${s}.`, 400);
    for (const t of input.allowedTools) if (!toolByCode(t)) throw new AppError('VALIDATION_FAILED', `Unknown tool ${t}.`, 400);
    return this.db.$transaction(async tx => {
      if (input.promptVersionId && !await tx.aiPromptTemplate.findFirst({ where: { id: input.promptVersionId, status: 'PUBLISHED', scopeKey: { in: [scopeKey(actor.workspaceId), 'global'] } } })) throw new AppError('VALIDATION_FAILED', 'Prompt version must be published.', 400);
      if (input.retrievalProfileId && !await tx.aiRetrievalProfile.findFirst({ where: { id: input.retrievalProfileId, workspaceId: actor.workspaceId } })) throw notFound('Retrieval profile');
      // A behavior role shapes tone/instructions only; it is never an authorization role (02 rule 1).
      const role = input.behaviorRole ? await tx.aiBehaviorRole.create({ data: { workspaceId: actor.workspaceId, name: input.behaviorRole.name, behaviorInstructions: input.behaviorRole.instructions, guardrails: input.behaviorRole.guardrails } }) : null;
      const row = await tx.aiAssistant.create({ data: { workspaceId: actor.workspaceId, name: input.name, promptVersionId: input.promptVersionId ?? null, allowedScenarios: input.scenarioIds, allowedTools: input.allowedTools, retrievalProfileId: input.retrievalProfileId ?? null, behaviorRoleId: role?.id ?? null, createdBy: actor.userId } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'AI_ASSISTANT_CREATED', resourceType: 'AiAssistant', resourceId: row.id, after: { name: input.name, scenarios: input.scenarioIds, tools: input.allowedTools }, requestId });
      return row;
    });
  }
  async assistants(actor: Principal) { requirePermission(actor, 'ai.scenario.execute'); return this.db.aiAssistant.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { name: 'asc' } }); }
  async disableAssistant(actor: Principal, id: string, requestId: string) {
    requirePermission(actor, 'ai.assistant.manage');
    return this.db.$transaction(async tx => {
      const r = await tx.aiAssistant.updateMany({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId, status: 'ACTIVE' }, data: { status: 'DISABLED', version: { increment: 1 } } });
      if (!r.count) throw notFound('Assistant');
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'AI_ASSISTANT_DISABLED', resourceType: 'AiAssistant', resourceId: id, requestId });
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'AI_ASSISTANT_DISABLED', aggregateType: 'AiAssistant', aggregateId: id, actorId: actor.userId, payload: {} });
      return { id, status: 'DISABLED' };
    });
  }
  async createRetrievalProfile(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'ai.assistant.manage');
    const input = z.strictObject({ name: z.string().trim().min(1).max(120), allowedSources: z.array(z.enum(['KNOWLEDGE', 'FILES', 'CRM'])).min(1), maxChunks: z.number().int().min(1).max(20).default(5), maxTokens: z.number().int().min(200).max(16000).default(2000), citationRequired: z.boolean().default(true) }).parse(raw);
    return this.db.$transaction(async tx => {
      const row = await tx.aiRetrievalProfile.create({ data: { workspaceId: actor.workspaceId, name: input.name, sourceTypes: input.allowedSources, maxChunks: input.maxChunks, maxTokens: input.maxTokens, citationRequired: input.citationRequired } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'AI_RETRIEVAL_PROFILE_CREATED', resourceType: 'AiRetrievalProfile', resourceId: row.id, after: input, requestId });
      return row;
    });
  }

  // ------------------------------------------------------------------ 05/07 tool policy, grants, budgets
  /** Allowed tool inventory only: forbidden tools are not even named (05, 08 AC02). */
  async tools(actor: Principal, raw: unknown) {
    requirePermission(actor, 'ai.scenario.execute');
    const q = z.object({ scenarioId: z.string().max(80).optional() }).parse(raw);
    const policies = await this.db.aiToolPolicy.findMany({ where: { workspaceId: actor.workspaceId, enabled: true, scenarioKey: { in: ['*', q.scenarioId ?? '*'] } } });
    return allTools().filter(t => actor.grants.has(t.requiredPermission) && policies.some(p => p.toolCode === t.code)).map(t => ({ code: t.code, risk: t.risk, description: t.description, consentMode: policies.find(p => p.toolCode === t.code)?.consentMode }));
  }
  /** High-risk tools can only be EVERY_TIME (05 rule 2, AC01). */
  async setToolPolicy(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'ai.tool.manage');
    const input = z.strictObject({ toolCode: z.string().max(80), scenarioId: z.string().max(80).default('*'), consentMode: z.enum(['NO_CONFIRM', 'ALLOW_ONCE', 'ALLOW_ALWAYS', 'EVERY_TIME']), enabled: z.boolean().default(true) }).parse(raw);
    const tool = toolByCode(input.toolCode); if (!tool) throw new AppError('VALIDATION_FAILED', 'Unknown tool.', 400);
    if (tool.risk === 'HIGH_WRITE' && input.consentMode !== 'EVERY_TIME') throw new AppError('BUSINESS_RULE_VIOLATION', 'High-risk tools always require confirmation for every invocation.', 422);
    if (tool.risk === 'LOW_WRITE' && input.consentMode === 'NO_CONFIRM') throw new AppError('BUSINESS_RULE_VIOLATION', 'Write tools require at least one-time consent.', 422);
    return this.db.$transaction(async tx => {
      const row = await tx.aiToolPolicy.upsert({ where: { workspaceId_scenarioKey_toolCode: { workspaceId: actor.workspaceId, scenarioKey: input.scenarioId, toolCode: input.toolCode } },
        create: { workspaceId: actor.workspaceId, scenarioKey: input.scenarioId, toolCode: input.toolCode, consentMode: input.consentMode, enabled: input.enabled }, update: { consentMode: input.consentMode, enabled: input.enabled, version: { increment: 1 } } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'AI_TOOL_POLICY_CHANGED', resourceType: 'AiToolPolicy', resourceId: row.id, after: input, requestId });
      return row;
    });
  }
  async myGrants(actor: Principal) { return this.db.aiToolGrant.findMany({ where: { workspaceId: actor.workspaceId, userId: actor.userId, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } }); }
  /** Revocation blocks new and pending (uncommitted) calls relying on the grant (05 AC05). */
  async revokeGrant(actor: Principal, id: string, requestId: string) {
    return this.db.$transaction(async tx => {
      const grant = await tx.aiToolGrant.findFirst({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId } }); if (!grant) throw notFound('Grant');
      if (grant.userId !== actor.userId) requirePermission(actor, 'ai.tool.manage');
      await tx.aiToolGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date(), version: { increment: 1 } } });
      await tx.aiToolCall.updateMany({ where: { grantId: grant.id, status: { in: ['PROPOSED', 'WAITING_APPROVAL'] } }, data: { status: 'DENIED', errorCode: 'GRANT_REVOKED' } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'AI_TOOL_GRANT_REVOKED', resourceType: 'AiToolGrant', resourceId: grant.id, requestId });
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'AI_TOOL_GRANT_REVOKED', aggregateType: 'AiToolGrant', aggregateId: grant.id, actorId: actor.userId, payload: { toolCode: grant.toolCode } });
      return { id: grant.id, revoked: true };
    });
  }
  async budget(actor: Principal) { requirePermission(actor, 'ai.usage.readWorkspace'); return this.db.aiWorkspaceBudget.findUnique({ where: { workspaceId: actor.workspaceId } }); }
  async setBudget(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'ai.budgets.manage');
    const input = z.strictObject({ currency: z.string().regex(/^([A-Z]{3}|CREDIT)$/), cap: z.string().regex(/^\d+(\.\d{1,4})?$/).nullable(), alerts: z.string().regex(/^\d+(\.\d{1,4})?$/).nullable().default(null), period: z.literal('MONTHLY').default('MONTHLY'), expectedVersion: z.number().int().min(0) }).parse(raw);
    return this.db.$transaction(async tx => {
      const current = await tx.aiWorkspaceBudget.findUnique({ where: { workspaceId: actor.workspaceId } });
      assertVersion(current?.version ?? 0, input.expectedVersion);
      const data = { currency: input.currency, hardCapAmount: input.cap ? new Prisma.Decimal(input.cap) : null, softAlertAmount: input.alerts ? new Prisma.Decimal(input.alerts) : null, resetPolicy: input.period };
      const row = current ? await tx.aiWorkspaceBudget.update({ where: { workspaceId: actor.workspaceId }, data: { ...data, version: { increment: 1 } } }) : await tx.aiWorkspaceBudget.create({ data: { workspaceId: actor.workspaceId, ...data } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'AI_BUDGET_CHANGED', resourceType: 'AiWorkspaceBudget', resourceId: actor.workspaceId, after: input, requestId });
      return row;
    });
  }
}
