import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, resolvePrincipal, type Principal } from '../process-platform/context';
import { visibleIds } from '../platform/access';
import { enqueueJob, registerJob } from '../platform/events-service';
import { audit, emitEvent, notFound, paged, type Tx } from '../platform/kernel';
import { decrypt, encrypt, entitled } from '../suite/kernel';
import { readCleanFile } from '../suite/files-port';
import { assertServiceIdentity } from '../billing/support';
import { registerUsageCompletionCheck, UsageService } from '../billing/usage-service';
import { retrieveKnowledge } from '../knowledge/index-service';
import { CLASSIFICATIONS, scenarioEnabled, scopeKey, workspaceAiSettings } from './config-service';
import { adapterFor, connectionSecret, ProviderFailure, type ChatMessage } from './providers';
import { SCENARIOS, toolByCode, type Scenario } from './registry';

const sha = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const CREDITS_PER_UNIT = () => D(process.env.AI_CREDITS_PER_CURRENCY_UNIT ?? '1000');
const MAX_TRANSIENT_RETRIES = 2, TOOL_APPROVAL_HOURS = 24, ALWAYS_GRANT_DAYS = 30, HISTORY_MESSAGES = 20;
const rank = (c: string) => CLASSIFICATIONS.indexOf(c as (typeof CLASSIFICATIONS)[number]);
const RETRYABLE = new Set(['PROVIDER_UNAVAILABLE', 'PROVIDER_503', 'PROVIDER_429', 'PROVIDER_500', 'PROVIDER_502', 'PROVIDER_504', 'PROVIDER_UNREACHABLE', 'PROVIDER_NETWORK_TRANSIENT']);
type UsageInput = { candidate: Candidate; inputTokens: number; outputTokens: number; cachedTokens: number; estimated: boolean; attempt: number; stepId: string };
type Finish = (status: string, data: Prisma.AiRunUpdateInput, usage?: UsageInput) => Promise<unknown>;
type Candidate = { routeId: string; routeVersion: number; modelId: string; modelKey: string; providerCode: string; connectionId: string; region: string; costMode: 'PLATFORM' | 'BYOK'; inputRate: Prisma.Decimal; outputRate: Prisma.Decimal; rateCurrency: string; pricingVersion: number; maxCost: Prisma.Decimal | null };

// ------------------------------------------------------------------ 01 routing (intersection of capability, classification, region, status, cost)
export async function eligibleCandidates(db: PrismaClient | Tx, workspaceId: string, scenario: Scenario, classification: string): Promise<Candidate[]> {
  const routes = await db.aiRoute.findMany({ where: { scenarioCode: scenario.code, enabled: true, OR: [{ workspaceId }, { workspaceId: null }] }, orderBy: [{ priority: 'asc' }, { id: 'asc' }] });
  routes.sort((a, b) => (a.workspaceId ? 0 : 1) - (b.workspaceId ? 0 : 1) || a.priority - b.priority);
  const out: Candidate[] = [];
  for (const r of routes) {
    if (!(r.allowedClassifications as string[]).includes(classification)) continue;
    const pairs = [{ modelId: r.modelId, connectionId: r.connectionId }, ...(r.fallbackIds as Array<{ modelId: string; connectionId: string }>)];
    for (const p of pairs) {
      const [model, conn] = await Promise.all([db.aiModel.findUnique({ where: { id: p.modelId } }), db.aiProviderConnection.findUnique({ where: { id: p.connectionId } })]);
      if (!model?.active || !conn || conn.status !== 'CONNECTED' || (conn.workspaceId && conn.workspaceId !== workspaceId)) continue;
      // Fallback never lowers privacy: classification and region are re-checked per candidate (01 rule 4, AC01).
      if (!(conn.allowedClassifications as string[]).includes(classification)) continue;
      const regions = r.allowedRegions as string[]; if (regions.length && !regions.includes(conn.region)) continue;
      const needed = scenario.capability === 'chat' ? (scenario.output === 'JSON' ? 'json' : 'chat') : scenario.capability;
      if (!(model.capabilities as string[]).includes(needed)) continue;
      const provider = await db.aiProvider.findUniqueOrThrow({ where: { id: model.providerId } });
      out.push({ routeId: r.id, routeVersion: r.version, modelId: model.id, modelKey: model.modelKey, providerCode: provider.code, connectionId: conn.id, region: conn.region, costMode: conn.costResponsibility === 'WORKSPACE' ? 'BYOK' : 'PLATFORM',
        inputRate: model.inputRate, outputRate: model.outputRate, rateCurrency: model.rateCurrency, pricingVersion: model.catalogVersion, maxCost: r.maxCost });
    }
  }
  return out;
}
/** Cost in the model's rate currency (rates are per 1K tokens) and the platform credit equivalent (NUMERIC only). */
export function priceOf(c: Pick<Candidate, 'inputRate' | 'outputRate' | 'rateCurrency'>, inputTokens: number, outputTokens: number) {
  const cost = c.inputRate.mul(inputTokens).add(c.outputRate.mul(outputTokens)).div(1000).toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
  const credits = (c.rateCurrency === 'CREDIT' ? cost : cost.mul(CREDITS_PER_UNIT())).toDecimalPlaces(6, Prisma.Decimal.ROUND_UP);
  return { cost, credits };
}
const estimateTokens = (text: string) => Math.ceil(text.length / 4) + 50;

async function monthCost(tx: Tx, workspaceId: string) {
  const from = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const rows = await tx.aiUsageRecord.groupBy({ by: ['costCurrency'], where: { workspaceId, occurredAt: { gte: from } }, _sum: { costAmount: true, credits: true } });
  return rows;
}

// ------------------------------------------------------------------ 04 context builder
type Source = { n: number; sourceType: string; sourceId: string; version: string; anchor: string | null; title: string; text: string };
async function buildContext(db: PrismaClient, actor: Principal, run: { id: string; scenarioCode: string; classification: string }, query: string, refs: Array<{ type: string; id: string }>, profileId: string | null) {
  const scenario = SCENARIOS[run.scenarioCode];
  const profile = profileId ? await db.aiRetrievalProfile.findFirst({ where: { id: profileId, workspaceId: actor.workspaceId } }) : null;
  const allowed = new Set((profile?.sourceTypes as string[] | undefined) ?? ['KNOWLEDGE', 'FILES', 'CRM']);
  const maxChunks = profile?.maxChunks ?? 5, maxChars = (profile?.maxTokens ?? 2000) * 4;
  const sources: Source[] = []; let denied = 0;
  // Every source is re-authorized for the live principal; cross-workspace ids simply never match (04 rule 3).
  if (scenario.retrieval && allowed.has('KNOWLEDGE') && actor.grants.has('ai.retrieval.use')) {
    for (const r of await retrieveKnowledge(db, actor, query, { limit: maxChunks, maxClassification: run.classification }))
      sources.push({ n: sources.length + 1, sourceType: 'knowledge.article', sourceId: r.articleId, version: r.revisionId, anchor: r.anchor, title: r.title, text: r.snippet });
  }
  for (const ref of refs.slice(0, 10)) {
    if (ref.type === 'drive.file' && allowed.has('FILES')) {
      try {
        const { file, version, bytes } = await db.$transaction(tx => readCleanFile(tx, actor, ref.id, 2_000_000));
        if (!/^text\/|json|csv|markdown/.test(version.mimeType)) { denied++; continue; }
        sources.push({ n: sources.length + 1, sourceType: 'drive.file', sourceId: file.id, version: version.id, anchor: null, title: file.name, text: bytes.toString('utf8').slice(0, 8000) });
      } catch { denied++; }
    } else if (ref.type === 'crm.contact' && allowed.has('CRM')) {
      const ok = await db.$transaction(tx => visibleIds(tx, actor, 'crm.contact', [ref.id]));
      if (!ok.has(ref.id)) { denied++; continue; }
      const c = await db.crmContact.findFirst({ where: { id: ref.id, workspaceId: actor.workspaceId } });
      if (c) sources.push({ n: sources.length + 1, sourceType: 'crm.contact', sourceId: c.id, version: String(c.version), anchor: null, title: c.displayName, text: [c.displayName, c.city, c.countryCode].filter(Boolean).join(', ') });
    } else denied++;
  }
  // Truncate by budget without losing provenance (04 rule 6).
  let used = 0; const kept: Source[] = [];
  for (const s of sources) { if (used >= maxChars) break; const text = s.text.slice(0, Math.max(0, maxChars - used)); used += text.length; kept.push({ ...s, text }); }
  await db.$transaction(async tx => {
    const acl = await tx.cacheVersion.findUnique({ where: { namespace_scopeId: { namespace: 'knowledge.acl', scopeId: actor.workspaceId } } });
    await tx.aiRetrievalRun.create({ data: { runId: run.id, profileId: profile?.id ?? null, queryHash: sha(query), aclVersion: acl?.version ?? 0, resultCount: kept.length } });
    for (const s of kept) await tx.aiSourceCitation.create({ data: { runId: run.id, sourceType: s.sourceType, sourceId: s.sourceId, sourceVersion: s.version, anchor: s.anchor, excerptHash: sha(s.text), visibilitySnapshotVersion: acl?.version ?? 0 } });
    await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: denied ? 'AI_RETRIEVAL_POLICY_DENIED' : 'AI_RETRIEVAL_COMPLETED', aggregateType: 'AiRun', aggregateId: run.id, actorType: 'SERVICE', payload: { sources: kept.length, denied } });
  });
  return kept;
}

const TOOL_CALL = /<tool_call>([\s\S]*?)<\/tool_call>/g;
async function pinnedPrompt(db: PrismaClient | Tx, workspaceId: string, code: string) {
  const ws = await db.aiPromptTemplate.findFirst({ where: { scenarioCode: code, scopeKey: scopeKey(workspaceId), status: 'PUBLISHED' }, orderBy: { version: 'desc' } });
  return ws ?? db.aiPromptTemplate.findFirst({ where: { scenarioCode: code, scopeKey: 'global', status: 'PUBLISHED' }, orderBy: { version: 'desc' } });
}

/**
 * Executes one run attempt durably: claim QUEUED→RUNNING, rebuild authority/context, call candidates (transient retry + approved
 * fallback), validate output, propose tools, settle usage via Billing exactly once. Terminal runs stay terminal (06 AC05).
 */
async function executeRun(db: PrismaClient, runId: string) {
  const claimed = await db.aiRun.updateMany({ where: { id: runId, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: new Date(), version: { increment: 1 } } });
  if (!claimed.count) return { skipped: true };
  const run = await db.aiRun.findUniqueOrThrow({ where: { id: runId } });
  const scenario = SCENARIOS[run.scenarioCode];
  const finish: Finish = async (status, data, usage) =>
    db.$transaction(async tx => {
      if (usage) {
        const { cost, credits } = priceOf(usage.candidate, usage.inputTokens, usage.outputTokens);
        const key = `ai-run:${run.id}:${usage.attempt}`;
        if (!await tx.aiUsageRecord.findUnique({ where: { billingEventKey: key } })) {
          await tx.aiUsageRecord.create({ data: { workspaceId: run.workspaceId, runId: run.id, stepId: usage.stepId, userId: run.requesterId, scenarioCode: run.scenarioCode, modelId: usage.candidate.modelId, connectionId: usage.candidate.connectionId, costMode: usage.candidate.costMode,
            inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedTokens, estimated: usage.estimated, costAmount: cost, costCurrency: usage.candidate.rateCurrency,
            credits: usage.candidate.costMode === 'PLATFORM' ? credits : D(0), pricingVersion: usage.candidate.pricingVersion, billingEventKey: key } });
          await emitEvent(tx, { workspaceId: run.workspaceId, eventType: 'AI_USAGE_RECORDED', aggregateType: 'AiRun', aggregateId: run.id, actorType: 'SERVICE', payload: { credits: credits.toFixed(), costMode: usage.candidate.costMode, estimated: usage.estimated } });
        }
        // Billing is the credit authority: settle actual (capped at the reservation), release the remainder (07 rules 1, AC02/AC03).
        if (run.usageReservationId) await UsageService.settle(tx, run.usageReservationId, Prisma.Decimal.min(credits, run.estimatedCredits), key, 'ai.run:' + run.id);
      } else if (run.usageReservationId) await UsageService.release(tx, run.usageReservationId, status);
      const updated = await tx.aiRun.update({ where: { id: run.id }, data: { ...data, status, finishedAt: ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status) ? new Date() : null, version: { increment: 1 } } });
      const eventType = status === 'SUCCEEDED' ? 'AI_RUN_SUCCEEDED' : status === 'FAILED' ? 'AI_RUN_FAILED' : status === 'CANCELLED' ? 'AI_RUN_CANCELLED' : 'AI_RUN_WAITING_APPROVAL';
      await emitEvent(tx, { workspaceId: run.workspaceId, eventType, aggregateType: 'AiRun', aggregateId: run.id, aggregateVersion: updated.version, actorType: 'SERVICE', payload: { scenario: run.scenarioCode, errorCode: updated.errorCode } });
      return updated;
    });
  let actor: Principal;
  try {
    actor = await resolvePrincipal(db, run.workspaceId, run.requesterId);
    requirePermission(actor, 'ai.run.create'); requirePermission(actor, scenario.requiredPermission); entitled(actor, 'ai');
    if (!scenarioEnabled(await workspaceAiSettings(db, run.workspaceId), scenario.code, actor.roleId)) throw new AppError('PERMISSION_DENIED', 'Scenario is disabled.', 403);
  } catch (error) { return finish('FAILED', { errorCode: error instanceof AppError ? error.code : 'AUTHORIZATION_FAILED' }); }
  if (run.cancelRequestedAt) return finish('CANCELLED', {});
  const input = JSON.parse(decrypt(run.inputSealed) ?? '{}') as { prompt: string; contextRefs?: Array<{ type: string; id: string }> };
  const assistant = run.assistantId ? await db.aiAssistant.findFirst({ where: { id: run.assistantId, workspaceId: run.workspaceId, status: 'ACTIVE' } }) : null;
  const sources = await buildContext(db, actor, run, input.prompt, input.contextRefs ?? [], assistant?.retrievalProfileId ?? null);
  const prompt = run.promptVersionId ? await db.aiPromptTemplate.findUnique({ where: { id: run.promptVersionId } }) : null;
  const role = assistant?.behaviorRoleId ? await db.aiBehaviorRole.findUnique({ where: { id: assistant.behaviorRoleId } }) : null;
  const policies = scenario.allowTools ? await db.aiToolPolicy.findMany({ where: { workspaceId: run.workspaceId, enabled: true, scenarioKey: { in: ['*', scenario.code] } } }) : [];
  const allowedTools = policies.map(p => p.toolCode).filter(code => { const t = toolByCode(code); return t && actor.grants.has(t.requiredPermission) && (!assistant || (assistant.allowedTools as string[]).includes(code)); });
  const system = [prompt?.content ?? scenario.defaultPrompt, role ? `Tone and behavior (never permissions): ${role.behaviorInstructions}` : '',
    scenario.allowTools ? `<allowed_tools>${allowedTools.map(c => `${c}: ${toolByCode(c)!.description}`).join('; ') || 'none'}</allowed_tools>\nTo propose a tool, output <tool_call>{"tool":"<code>","arguments":{...}}</tool_call>. Proposals are reviewed before execution.` : '',
    scenario.output === 'JSON' ? 'Respond with JSON only.' : ''].filter(Boolean).join('\n\n');
  const history: ChatMessage[] = [];
  if (run.conversationId) {
    const msgs = await db.aiMessage.findMany({ where: { conversationId: run.conversationId, redactionState: 'STORED', modelRunId: { not: run.id } }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: HISTORY_MESSAGES });
    for (const m of msgs.reverse()) { const body = decrypt(m.bodySealed); if (body && m.sender !== 'TOOL') history.push({ role: m.sender === 'ASSISTANT' ? 'assistant' : 'user', content: body }); }
  }
  const sourceBlock = sources.map(s => `<untrusted_source n="${s.n}" type="${s.sourceType}" title="${s.title.replace(/"/g, "'")}">\n${s.text}\n</untrusted_source>`).join('\n');
  const messages: ChatMessage[] = [...history, { role: 'user', content: `${sourceBlock ? sourceBlock + '\n' : ''}<user_input>\n${input.prompt}\n</user_input>` }];
  await db.aiContextSnapshot.create({ data: { runId: run.id, authorizedSourceHashes: sources.map(s => ({ t: s.sourceType, id: s.sourceId, v: s.version, h: sha(s.text) })), modelRequestHash: sha({ system, messages }), expiresAt: new Date(Date.now() + 30 * 86400000) } }).catch(() => null);

  const candidates = await eligibleCandidates(db, run.workspaceId, scenario, run.classification);
  if (!candidates.length) return finish('FAILED', { errorCode: 'NO_ELIGIBLE_ROUTE' });
  let attempt = (await db.aiRunStep.count({ where: { runId: run.id } }));
  for (const [ci, cand] of candidates.entries()) {
    if (ci > 0) await db.$transaction(tx => emitEvent(tx, { workspaceId: run.workspaceId, eventType: 'AI_PROVIDER_FALLBACK_USED', aggregateType: 'AiRun', aggregateId: run.id, actorType: 'SERVICE', payload: { modelId: cand.modelId, region: cand.region } }));
    for (let retry = 0; retry <= MAX_TRANSIENT_RETRIES; retry++) {
      const fresh = await db.aiRun.findUniqueOrThrow({ where: { id: run.id } });
      if (fresh.cancelRequestedAt) return finish('CANCELLED', {});
      attempt++;
      const step = await db.aiRunStep.create({ data: { runId: run.id, stepKind: 'INFER', attemptNo: attempt, state: 'DISPATCHED', modelId: cand.modelId, connectionId: cand.connectionId, region: cand.region, usageReservationId: run.usageReservationId } });
      await db.aiRun.update({ where: { id: run.id }, data: { routeId: cand.routeId, routeVersion: cand.routeVersion, costMode: cand.costMode } });
      try {
        const conn = await db.aiProviderConnection.findUniqueOrThrow({ where: { id: cand.connectionId } });
        if (conn.status !== 'CONNECTED') throw new ProviderFailure('PERMANENT', 'CONNECTION_SUSPENDED', 'Connection suspended.');
        const result = await adapterFor(cand.providerCode).infer(connectionSecret(conn), conn.endpoint, { model: cand.modelKey, system, messages, maxTokens: run.maxOutputTokens, idempotencyKey: `${run.id}:${attempt}`, json: scenario.output === 'JSON' });
        await db.aiRunStep.update({ where: { id: step.id }, data: { state: 'SUCCEEDED', providerRequestId: result.requestId } });
        const usage = { candidate: cand, inputTokens: result.usage.inputTokens || estimateTokens(system + JSON.stringify(messages)), outputTokens: result.usage.outputTokens || estimateTokens(result.text), cachedTokens: result.usage.cachedTokens, estimated: !result.usage.inputTokens, attempt, stepId: step.id };
        return completeRun(db, actor, run, scenario, result.text, sources, allowedTools, assistant, usage, finish);
      } catch (error) {
        const f = error instanceof ProviderFailure ? error : new ProviderFailure('TRANSIENT', 'PROVIDER_UNAVAILABLE', 'Provider failed.');
        await db.aiRunStep.update({ where: { id: step.id }, data: { state: f.kind === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED', errorCode: f.code } });
        if (f.kind === 'UNKNOWN') {
          // Accepted-but-unknown: reconcile before any new request; never resend blindly (06 rule 3, AC03).
          const state = await adapterFor(cand.providerCode).reconcile(`${run.id}:${attempt}`).catch(() => 'UNKNOWN' as const);
          if (state === 'NOT_FOUND') continue;
          return finish('FAILED', { errorCode: 'PROVIDER_OUTCOME_UNKNOWN' }, { candidate: cand, inputTokens: estimateTokens(system + JSON.stringify(messages)), outputTokens: run.maxOutputTokens, cachedTokens: 0, estimated: true, attempt, stepId: step.id });
        }
        if (f.kind === 'PERMANENT') break; // next approved fallback candidate
        await new Promise(r => setTimeout(r, Math.min(8000, 250 * 2 ** retry)));
      }
    }
  }
  return finish('FAILED', { errorCode: 'PROVIDER_UNAVAILABLE' });
}

async function completeRun(db: PrismaClient, actor: Principal, run: Prisma.AiRunGetPayload<object>, scenario: Scenario, raw: string, sources: Source[], allowedTools: string[], assistant: { allowedTools: Prisma.JsonValue } | null,
  usage: UsageInput, finish: Finish) {
  const proposals = [...raw.matchAll(TOOL_CALL)].map(m => m[1]);
  const visible = raw.replace(TOOL_CALL, '').trim();
  // Structured output validated server-side; invalid output is never persisted as a business field (02 AC04).
  if (scenario.output === 'JSON') {
    let parsed: unknown = null; try { parsed = JSON.parse(visible); } catch { /* invalid */ }
    const ok = scenario.outputSchema ? scenario.outputSchema.safeParse(parsed).success : parsed !== null;
    if (!ok) return finish('FAILED', { errorCode: 'INVALID_AI_OUTPUT', outputValid: false }, usage);
  }
  const calls: Array<{ index: number; code: string; args: Record<string, unknown> }> = [];
  await db.$transaction(async tx => {
    for (const [index, p] of proposals.entries()) {
      let parsed: { tool?: string; arguments?: Record<string, unknown> } = {};
      try { parsed = JSON.parse(p); } catch { /* malformed */ }
      const tool = parsed.tool ? toolByCode(parsed.tool) : undefined;
      if (!tool || !allowedTools.includes(tool.code) || !scenario.allowTools) {
        // Untrusted text tried to reach a tool outside policy (prompt injection or model error) → security finding, no call (02 AC03/AC05).
        await tx.aiSecurityFinding.create({ data: { workspaceId: run.workspaceId, runId: run.id, category: 'POLICY_VIOLATION', severity: 'MEDIUM', details: { tool: String(parsed.tool ?? 'malformed').slice(0, 80), injectionSuspected: sources.length > 0 } } });
        await emitEvent(tx, { workspaceId: run.workspaceId, eventType: 'AI_SECURITY_FINDING_OPENED', aggregateType: 'AiRun', aggregateId: run.id, actorType: 'SERVICE', payload: { category: 'POLICY_VIOLATION' } });
        continue;
      }
      const args = tool.input.safeParse(parsed.arguments ?? {});
      if (!args.success) continue;
      calls.push({ index, code: tool.code, args: args.data as Record<string, unknown> });
    }
  });
  let waiting = false;
  for (const c of calls) { const status = await proposeToolCall(db, actor, run, c.index, c.code, c.args, assistant); if (status === 'WAITING_APPROVAL') waiting = true; }
  const output = { text: visible, citations: sources.map(s => ({ n: s.n, sourceType: s.sourceType, sourceId: s.sourceId, version: s.version, anchor: s.anchor })), toolCalls: calls.length };
  if (scenario.citationRequired && !sources.length) output.text = output.text || 'No authorized source answers this question.';
  if (run.conversationId) await db.$transaction(async tx => {
    const conv = await tx.aiConversation.findUniqueOrThrow({ where: { id: run.conversationId! } });
    await tx.aiMessage.create({ data: { conversationId: conv.id, workspaceId: run.workspaceId, sender: 'ASSISTANT', bodySealed: conv.noHistory ? null : encrypt(output.text), redactionState: conv.noHistory ? 'NOT_RETAINED' : 'STORED', modelRunId: run.id } });
    if (conv.noHistory) await tx.aiMessage.updateMany({ where: { conversationId: conv.id, modelRunId: run.id }, data: { bodySealed: null, redactionState: 'NOT_RETAINED' } });
    await tx.aiConversation.update({ where: { id: conv.id }, data: { lastMessageAt: new Date() } });
  });
  const cancelled = (await db.aiRun.findUniqueOrThrow({ where: { id: run.id } })).cancelRequestedAt;
  const noHistory = run.conversationId ? (await db.aiConversation.findUnique({ where: { id: run.conversationId } }))?.noHistory : false;
  return finish(cancelled ? 'CANCELLED' : waiting ? 'WAITING_APPROVAL' : 'SUCCEEDED', { outputSealed: noHistory ? null : encrypt(JSON.stringify(output)), outputValid: true, ...(noHistory ? { inputSealed: null } : {}) }, usage);
}

// ------------------------------------------------------------------ 05 tool calls
async function proposeToolCall(db: PrismaClient, actor: Principal, run: { id: string; workspaceId: string; scenarioCode: string }, index: number, code: string, args: Record<string, unknown>, _assistant: unknown) {
  const tool = toolByCode(code)!;
  const policy = await db.aiToolPolicy.findFirst({ where: { workspaceId: run.workspaceId, toolCode: code, enabled: true, scenarioKey: { in: [run.scenarioCode, '*'] } }, orderBy: { scenarioKey: 'desc' } });
  const argsHash = sha({ code, version: tool.version, args });
  const scopeHash = sha({ code, target: tool.target(args) });
  const grant = tool.risk === 'LOW_WRITE' && policy?.consentMode === 'ALLOW_ALWAYS' ? await db.aiToolGrant.findFirst({ where: { workspaceId: run.workspaceId, userId: actor.userId, toolCode: code, scopeHash, revokedAt: null, expiresAt: { gt: new Date() } } }) : null;
  const auto = tool.risk === 'READ' && (policy?.consentMode ?? 'NO_CONFIRM') === 'NO_CONFIRM' || !!grant;
  const call = await db.$transaction(async tx => {
    const row = await tx.aiToolCall.upsert({ where: { runId_callIndex: { runId: run.id, callIndex: index } }, update: {},
      create: { runId: run.id, workspaceId: run.workspaceId, callIndex: index, toolCode: code, toolVersion: tool.version, argumentsSealed: encrypt(JSON.stringify(args)), argsHash, targetRef: tool.target(args), status: auto ? 'PROPOSED' : 'WAITING_APPROVAL',
        grantId: grant?.id ?? null, correlationId: randomUUID(), expiresAt: new Date(Date.now() + TOOL_APPROVAL_HOURS * 3600000) } });
    await emitEvent(tx, { workspaceId: run.workspaceId, eventType: 'AI_TOOL_PROPOSED', aggregateType: 'AiToolCall', aggregateId: row.id, actorType: 'SERVICE', payload: { tool: code, risk: tool.risk, autoExecute: auto } });
    return row;
  });
  if (auto) { await executeToolCall(db, call.id, null); return 'EXECUTED'; }
  return 'WAITING_APPROVAL';
}
/**
 * Exactly-once execution: claim via conditional status update, re-check the ORIGINAL user's live permission/grant/entitlement,
 * then call the owning domain service (which owns audit/outbox). Duplicate deliveries find the call already claimed (05 AC04).
 */
export async function executeToolCall(db: PrismaClient, callId: string, approverId: string | null) {
  const claimed = await db.aiToolCall.updateMany({ where: { id: callId, status: { in: ['PROPOSED', 'WAITING_APPROVAL'] }, expiresAt: { gt: new Date() } }, data: { status: 'EXECUTING' } });
  const call = await db.aiToolCall.findUniqueOrThrow({ where: { id: callId } });
  if (!claimed.count) return call;
  const run = await db.aiRun.findUniqueOrThrow({ where: { id: call.runId } });
  const tool = toolByCode(call.toolCode)!;
  const fail = (code: string) => db.aiToolCall.update({ where: { id: call.id }, data: { status: code === 'GRANT_REVOKED' || code === 'PERMISSION_DENIED' ? 'DENIED' : 'FAILED', errorCode: code, executedAt: new Date() } });
  try {
    const actor = await resolvePrincipal(db, run.workspaceId, run.requesterId);
    requirePermission(actor, tool.requiredPermission); entitled(actor, 'ai');
    if (call.grantId) { const g = await db.aiToolGrant.findUnique({ where: { id: call.grantId } }); if (!g || g.revokedAt || g.expiresAt <= new Date()) return fail('GRANT_REVOKED'); }
    const args = JSON.parse(decrypt(call.argumentsSealed)!) as Record<string, unknown>;
    if (sha({ code: call.toolCode, version: tool.version, args }) !== call.argsHash) return fail('APPROVAL_STALE');
    const result = await tool.execute(db, actor, args, { requestId: call.correlationId, idempotencyKey: 'ai-tool:' + call.id });
    const safe = JSON.parse(JSON.stringify(result ?? null, (k, v) => /secret|token|password|key$/i.test(k) ? '[redacted]' : v)) as Prisma.InputJsonValue;
    const updated = await db.$transaction(async tx => {
      const row = await tx.aiToolCall.update({ where: { id: call.id }, data: { status: 'SUCCEEDED', result: safe ?? Prisma.DbNull, executedAt: new Date(), decisionActor: approverId ?? call.decisionActor } });
      await audit(tx, { workspaceId: run.workspaceId, actorId: run.requesterId, action: 'AI_TOOL_EXECUTED', resourceType: 'AiToolCall', resourceId: call.id, after: { tool: call.toolCode, target: call.targetRef, provenance: { runId: run.id, approvedBy: approverId } } });
      await emitEvent(tx, { workspaceId: run.workspaceId, eventType: 'AI_TOOL_EXECUTED', aggregateType: 'AiToolCall', aggregateId: call.id, actorId: run.requesterId, payload: { tool: call.toolCode, runId: run.id } });
      return row;
    });
    await settleWaitingRun(db, run.id);
    return updated;
  } catch (error) {
    const row = await fail(error instanceof AppError ? (error.status === 403 ? 'PERMISSION_DENIED' : error.code) : 'TOOL_FAILED');
    await settleWaitingRun(db, run.id);
    return row;
  }
}
async function settleWaitingRun(db: PrismaClient, runId: string) {
  const pending = await db.aiToolCall.count({ where: { runId, status: { in: ['PROPOSED', 'WAITING_APPROVAL', 'EXECUTING'] } } });
  if (!pending) await db.aiRun.updateMany({ where: { id: runId, status: 'WAITING_APPROVAL' }, data: { status: 'SUCCEEDED', finishedAt: new Date(), version: { increment: 1 } } });
}

registerJob({ type: 'ai.run.execute', ownerModule: 'ai', maxAttempts: 3, async run(ctx) { const { prisma } = await import('../prisma-client'); return executeRun(prisma, String(ctx.payload.runId)); } });
registerJob({ type: 'ai.tool.execute', ownerModule: 'ai', maxAttempts: 3, async run(ctx) { const { prisma } = await import('../prisma-client'); return executeToolCall(prisma, String(ctx.payload.callId), ctx.payload.approverId ? String(ctx.payload.approverId) : null); } });
/** Expired Billing reservations ask AI whether the run completed (reconcile-before-release, Billing 05 rule 3). */
registerUsageCompletionCheck('ai', async (db, operationKey) => {
  const runId = operationKey.replace(/^ai-run:/, '');
  const run = await db.aiRun.findUnique({ where: { id: runId } }); if (!run) return { state: 'NOT_FOUND' };
  if (['FAILED', 'CANCELLED'].includes(run.status)) {
    const used = await db.aiUsageRecord.aggregate({ where: { runId }, _sum: { credits: true } });
    return used._sum.credits?.gt(0) ? { state: 'COMPLETED', actual: used._sum.credits } : { state: 'FAILED' };
  }
  if (['SUCCEEDED', 'WAITING_APPROVAL'].includes(run.status)) return { state: 'COMPLETED', actual: (await db.aiUsageRecord.aggregate({ where: { runId }, _sum: { credits: true } }))._sum.credits ?? D(0) };
  return { state: 'UNKNOWN' };
});

/** Async runs, cancellation/retry (29/06), usage reports (29/07), approvals (29/05), citations (29/04) and internal endpoints. */
export class AiRunService {
  constructor(private readonly db: PrismaClient) {}

  /** Idempotent submit (same key+payload → same run; different payload → 409), reserve-before-dispatch, budget cap under lock. */
  async create(actor: Principal, raw: unknown, conversationId: string | null = null) {
    requirePermission(actor, 'ai.run.create'); entitled(actor, 'ai');
    const input = z.strictObject({ scenarioId: z.string().max(80), input: z.strictObject({ prompt: z.string().min(1).max(50000) }).passthrough(), contextRefs: z.array(z.strictObject({ type: z.enum(['drive.file', 'crm.contact']), id: z.uuid() })).max(10).default([]),
      idempotencyKey: z.string().min(8).max(200), assistantId: z.uuid().optional(), classification: z.enum(CLASSIFICATIONS).default('INTERNAL'), maxOutputTokens: z.number().int().min(16).max(16000).optional() }).parse(raw);
    const scenario = SCENARIOS[input.scenarioId]; if (!scenario || scenario.capability !== 'chat') throw notFound('Scenario');
    requirePermission(actor, scenario.requiredPermission);
    const settings = await workspaceAiSettings(this.db, actor.workspaceId);
    if (!scenarioEnabled(settings, scenario.code, actor.roleId)) throw new AppError('PERMISSION_DENIED', 'This AI scenario is not enabled for your role.', 403);
    const maxClass = String((settings.classificationRules as { maxClassification?: string }).maxClassification ?? 'INTERNAL');
    if (rank(input.classification) > rank(maxClass) || rank(input.classification) < rank(scenario.classification) && scenario.sensitive) throw new AppError('BUSINESS_RULE_VIOLATION', 'Classification is not allowed for this Workspace/scenario.', 422);
    const payload = { prompt: input.input.prompt, contextRefs: input.contextRefs };
    const inputHash = sha({ scenario: scenario.code, payload, assistantId: input.assistantId ?? null, conversationId });
    return this.db.$transaction(async tx => {
      const prior = await tx.aiRun.findUnique({ where: { workspaceId_requesterId_scenarioCode_idempotencyKey: { workspaceId: actor.workspaceId, requesterId: actor.userId, scenarioCode: scenario.code, idempotencyKey: input.idempotencyKey } } });
      if (prior) { if (prior.inputHash !== inputHash) throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used with a different request.', 409); return this.view(prior); }
      if (input.assistantId) {
        const a = await tx.aiAssistant.findFirst({ where: { id: input.assistantId, workspaceId: actor.workspaceId, status: 'ACTIVE' } });
        if (!a || !(a.allowedScenarios as string[]).includes(scenario.code)) throw new AppError('PERMISSION_DENIED', 'Assistant is not allowed to run this scenario.', 403);
      }
      const candidates = await eligibleCandidates(tx, actor.workspaceId, scenario, input.classification);
      if (!candidates.length) throw new AppError('BUSINESS_RULE_VIOLATION', 'No approved model route satisfies this scenario, classification and region policy.', 422, { reason: 'NO_ELIGIBLE_ROUTE' });
      const maxOut = input.maxOutputTokens ?? scenario.maxOutputTokens;
      const estIn = estimateTokens(input.input.prompt) + 2000; // context allowance
      // Reserve for the most expensive eligible candidate so a fallback can't overspend (06 AC04).
      const prices = candidates.map(c => ({ c, ...priceOf(c, estIn, maxOut) }));
      const worst = prices.reduce((m, p) => p.credits.gt(m.credits) ? p : m, prices[0]);
      if (worst.c.maxCost && worst.cost.gt(worst.c.maxCost)) throw new AppError('INSUFFICIENT_QUOTA', 'Estimated cost exceeds the route spend cap.', 422);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'ai-budget:' + actor.workspaceId}))`;
      const budget = await tx.aiWorkspaceBudget.findUnique({ where: { workspaceId: actor.workspaceId } });
      if (budget?.hardCapAmount) {
        const spent = (await monthCost(tx, actor.workspaceId)).find(r => r.costCurrency === budget.currency || budget.currency === 'CREDIT');
        const used = budget.currency === 'CREDIT' ? spent?._sum.credits ?? D(0) : spent?._sum.costAmount ?? D(0);
        const pending = await tx.aiRun.aggregate({ where: { workspaceId: actor.workspaceId, status: { in: ['QUEUED', 'RUNNING'] } }, _sum: { estimatedCredits: true } });
        const next = budget.currency === 'CREDIT' ? worst.credits : worst.cost;
        if (used.add(budget.currency === 'CREDIT' ? pending._sum.estimatedCredits ?? D(0) : D(0)).add(next).gt(budget.hardCapAmount)) {
          await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'AI_USAGE_CAP_REACHED', aggregateType: 'AiWorkspaceBudget', aggregateId: actor.workspaceId, actorType: 'SERVICE', payload: { cap: budget.hardCapAmount.toFixed() } });
          throw new AppError('INSUFFICIENT_QUOTA', 'The Workspace AI budget cap would be exceeded.', 422);
        }
      }
      const prompt = await pinnedPrompt(tx, actor.workspaceId, scenario.code);
      const run = await tx.aiRun.create({ data: { workspaceId: actor.workspaceId, requesterId: actor.userId, scenarioCode: scenario.code, scenarioVersion: scenario.version, promptVersionId: prompt?.id ?? null, assistantId: input.assistantId ?? null, conversationId,
        classification: input.classification, inputHash, inputSealed: encrypt(JSON.stringify(payload)), idempotencyKey: input.idempotencyKey, estimatedCredits: worst.c.costMode === 'PLATFORM' ? worst.credits : D(0), maxOutputTokens: maxOut, costMode: worst.c.costMode } });
      if (candidates.some(c => c.costMode === 'PLATFORM')) {
        // Billing is authoritative: concurrent runs can't overspend credits (row-locked grants) (07 AC01).
        const reservation = await UsageService.reserve(tx, { workspaceId: actor.workspaceId, meterCode: 'ai.credits', units: worst.credits.gt(0) ? worst.credits : D('0.000001'), operationKey: 'ai-run:' + run.id, sourceModule: 'ai', scenario: scenario.code, runId: run.id });
        await tx.aiRun.update({ where: { id: run.id }, data: { usageReservationId: reservation.id, estimatedCredits: reservation.estimate } });
      }
      await enqueueJob(tx, { type: 'ai.run.execute', ownerModule: 'ai', workspaceId: actor.workspaceId, payload: { runId: run.id }, idempotencyKey: 'ai-run:' + run.id });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'AI_RUN_QUEUED', resourceType: 'AiRun', resourceId: run.id, after: { scenario: scenario.code, inputHash, classification: input.classification } }); // prompt text never in audit
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'AI_RUN_QUEUED', aggregateType: 'AiRun', aggregateId: run.id, aggregateVersion: 1, actorId: actor.userId, payload: { scenario: scenario.code } });
      return this.view(await tx.aiRun.findUniqueOrThrow({ where: { id: run.id } }));
    });
  }
  view(run: Prisma.AiRunGetPayload<object>) {
    const output = run.outputSealed ? JSON.parse(decrypt(run.outputSealed) ?? 'null') : null;
    return { id: run.id, scenarioId: run.scenarioCode, status: run.status, errorCode: run.errorCode, costMode: run.costMode, estimatedCredits: run.estimatedCredits.toFixed(), createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt, version: run.version, result: output };
  }
  private async load(actor: Principal, id: string) {
    const run = await this.db.aiRun.findFirst({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId } });
    if (!run || run.requesterId !== actor.userId && !actor.grants.has('ai.run.readScoped')) throw notFound('Run');
    return run;
  }
  async get(actor: Principal, id: string) {
    const run = await this.load(actor, id);
    const [usage, calls] = await Promise.all([this.db.aiUsageRecord.findMany({ where: { runId: run.id }, select: { inputTokens: true, outputTokens: true, cachedTokens: true, credits: true, costAmount: true, costCurrency: true, costMode: true, estimated: true } }),
      this.db.aiToolCall.findMany({ where: { runId: run.id }, select: { id: true, toolCode: true, argsHash: true, targetRef: true, status: true, errorCode: true, expiresAt: true } })]);
    return { ...this.view(run), usage, toolCalls: calls };
  }
  async list(actor: Principal, raw: unknown) {
    requirePermission(actor, 'ai.run.readOwn');
    const q = z.object({ scenarioId: z.string().max(80).optional(), status: z.string().max(30).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict().parse(raw);
    const where = { workspaceId: actor.workspaceId, requesterId: actor.userId, ...(q.scenarioId ? { scenarioCode: q.scenarioId } : {}), ...(q.status ? { status: q.status } : {}) };
    const [rows, total] = await Promise.all([this.db.aiRun.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }), this.db.aiRun.count({ where })]);
    return paged(rows.map(r => ({ ...this.view(r), result: undefined })), total, q.page, q.limit);
  }
  /** Best-effort cancel: queued runs cancel now (reservation released); dispatched work keeps consumed usage (06 rule 4, AC02). */
  async cancel(actor: Principal, id: string) {
    requirePermission(actor, 'ai.run.cancelOwn');
    const run = await this.load(actor, id);
    if (run.requesterId !== actor.userId) throw notFound('Run');
    return this.db.$transaction(async tx => {
      const queued = await tx.aiRun.updateMany({ where: { id: run.id, status: 'QUEUED' }, data: { status: 'CANCELLED', cancelRequestedAt: new Date(), finishedAt: new Date(), version: { increment: 1 } } });
      if (queued.count) { if (run.usageReservationId) await UsageService.release(tx, run.usageReservationId, 'CANCELLED'); await emitEvent(tx, { workspaceId: run.workspaceId, eventType: 'AI_RUN_CANCELLED', aggregateType: 'AiRun', aggregateId: run.id, actorId: actor.userId, payload: {} }); return { id: run.id, status: 'CANCELLED' }; }
      const running = await tx.aiRun.updateMany({ where: { id: run.id, status: { in: ['RUNNING', 'WAITING_APPROVAL'] } }, data: { cancelRequestedAt: new Date() } });
      if (running.count && run.status === 'WAITING_APPROVAL') {
        await tx.aiToolCall.updateMany({ where: { runId: run.id, status: { in: ['PROPOSED', 'WAITING_APPROVAL'] } }, data: { status: 'DENIED', errorCode: 'RUN_CANCELLED' } });
        await tx.aiRun.update({ where: { id: run.id }, data: { status: 'CANCELLED', finishedAt: new Date(), version: { increment: 1 } } });
        return { id: run.id, status: 'CANCELLED' };
      }
      return { id: run.id, status: running.count ? 'CANCEL_REQUESTED' : run.status, note: running.count ? 'Work already dispatched to the provider may still complete and is billed.' : undefined };
    });
  }
  /** Retry only transient, reconciled failures; same original access is re-checked by the worker. */
  async retry(actor: Principal, id: string) {
    const run = await this.load(actor, id);
    if (run.requesterId !== actor.userId) requirePermission(actor, 'ai.run.retryAny');
    if (run.status !== 'FAILED' || !RETRYABLE.has(run.errorCode ?? '')) throw new AppError('INVALID_STATE_TRANSITION', 'Only transient provider failures can be retried.', 409);
    return this.db.$transaction(async tx => {
      const reservation = run.costMode === 'PLATFORM' ? await UsageService.reserve(tx, { workspaceId: run.workspaceId, meterCode: 'ai.credits', units: run.estimatedCredits.gt(0) ? run.estimatedCredits : D('0.000001'), operationKey: `ai-run:${run.id}:retry:${run.version}`, sourceModule: 'ai', scenario: run.scenarioCode, runId: run.id }) : null;
      await tx.aiRun.update({ where: { id: run.id }, data: { status: 'QUEUED', errorCode: null, finishedAt: null, usageReservationId: reservation?.id ?? null, version: { increment: 1 } } });
      await enqueueJob(tx, { type: 'ai.run.execute', ownerModule: 'ai', workspaceId: run.workspaceId, payload: { runId: run.id }, idempotencyKey: `ai-run:${run.id}:retry:${run.version}` });
      return { id: run.id, status: 'QUEUED' };
    });
  }
  /** Citations re-check current access for each source (04 rule 4, AC02). */
  async citations(actor: Principal, id: string) {
    const run = await this.load(actor, id);
    const rows = await this.db.aiSourceCitation.findMany({ where: { runId: run.id }, orderBy: { createdAt: 'asc' } });
    const out = [];
    for (const c of rows) {
      const type = c.sourceType === 'knowledge.article' ? 'knowledge.article' : c.sourceType;
      const ok = await this.db.$transaction(tx => visibleIds(tx, actor, type, [c.sourceId])).then(s => s.has(c.sourceId)).catch(() => false);
      out.push(ok ? { sourceType: c.sourceType, sourceId: c.sourceId, sourceVersion: c.sourceVersion, anchor: c.anchor, accessible: true } : { sourceType: c.sourceType, accessible: false });
    }
    return out;
  }
  // ------------------------------------------------------------------ 05 approvals
  /** Approval binds exact args hash; HIGH_WRITE can never be ALWAYS; changed args → 409 APPROVAL_STALE (05 AC01/AC02). */
  async approveTool(actor: Principal, runId: string, callId: string, raw: unknown) {
    requirePermission(actor, 'ai.tool.approve');
    const input = z.strictObject({ mode: z.enum(['ONCE', 'ALWAYS']), expectedArgumentsHash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(raw);
    const run = await this.load(actor, runId);
    if (run.requesterId !== actor.userId) throw new AppError('PERMISSION_DENIED', 'Only the requesting user can approve their own tool actions.', 403);
    const call = await this.db.aiToolCall.findFirst({ where: { id: z.uuid().parse(callId), runId: run.id } }); if (!call) throw notFound('Tool call');
    if (call.status !== 'WAITING_APPROVAL') throw new AppError('INVALID_STATE_TRANSITION', `Tool call is ${call.status}.`, 409);
    if (call.expiresAt <= new Date()) { await this.db.aiToolCall.update({ where: { id: call.id }, data: { status: 'DENIED', errorCode: 'APPROVAL_EXPIRED' } }); throw new AppError('INVALID_STATE_TRANSITION', 'Approval window expired.', 409); }
    if (call.argsHash !== input.expectedArgumentsHash) throw new AppError('APPROVAL_STALE', 'Tool arguments changed; review them again.', 409);
    const tool = toolByCode(call.toolCode)!;
    let grantId: string | null = null;
    if (input.mode === 'ALWAYS') {
      if (tool.risk === 'HIGH_WRITE') throw new AppError('BUSINESS_RULE_VIOLATION', 'High-risk actions need confirmation every time.', 422);
      const policy = await this.db.aiToolPolicy.findFirst({ where: { workspaceId: run.workspaceId, toolCode: call.toolCode, enabled: true, scenarioKey: { in: [run.scenarioCode, '*'] } } });
      if (policy?.consentMode !== 'ALLOW_ALWAYS') throw new AppError('BUSINESS_RULE_VIOLATION', 'Workspace policy does not allow standing approval for this tool.', 422);
      const args = JSON.parse(decrypt(call.argumentsSealed)!) as Record<string, unknown>;
      grantId = (await this.db.aiToolGrant.create({ data: { workspaceId: run.workspaceId, userId: actor.userId, toolCode: call.toolCode, scopeHash: sha({ code: call.toolCode, target: tool.target(args) }), expiresAt: new Date(Date.now() + ALWAYS_GRANT_DAYS * 86400000) } })).id;
    }
    await this.db.$transaction(async tx => {
      await tx.aiToolCall.update({ where: { id: call.id }, data: { decisionActor: actor.userId, decisionMode: input.mode, grantId: grantId ?? call.grantId } });
      await audit(tx, { workspaceId: run.workspaceId, actorId: actor.userId, action: 'AI_TOOL_APPROVED', resourceType: 'AiToolCall', resourceId: call.id, after: { mode: input.mode, tool: call.toolCode, argsHash: call.argsHash } });
      await emitEvent(tx, { workspaceId: run.workspaceId, eventType: 'AI_TOOL_APPROVED', aggregateType: 'AiToolCall', aggregateId: call.id, actorId: actor.userId, payload: { mode: input.mode } });
    });
    return executeToolCall(this.db, call.id, actor.userId);
  }
  async denyTool(actor: Principal, runId: string, callId: string, raw: unknown) {
    const input = z.strictObject({ reason: z.string().trim().max(500).optional() }).parse(raw ?? {});
    const run = await this.load(actor, runId);
    return this.db.$transaction(async tx => {
      const r = await tx.aiToolCall.updateMany({ where: { id: z.uuid().parse(callId), runId: run.id, status: { in: ['PROPOSED', 'WAITING_APPROVAL'] } }, data: { status: 'DENIED', decisionActor: actor.userId, errorCode: 'USER_DENIED' } });
      if (!r.count) throw new AppError('INVALID_STATE_TRANSITION', 'Tool call is not pending.', 409);
      await audit(tx, { workspaceId: run.workspaceId, actorId: actor.userId, action: 'AI_TOOL_DENIED', resourceType: 'AiToolCall', resourceId: callId, after: input });
      await emitEvent(tx, { workspaceId: run.workspaceId, eventType: 'AI_TOOL_DENIED', aggregateType: 'AiToolCall', aggregateId: callId, actorId: actor.userId, payload: {} });
      const pending = await tx.aiToolCall.count({ where: { runId: run.id, status: { in: ['PROPOSED', 'WAITING_APPROVAL', 'EXECUTING'] } } });
      if (!pending) await tx.aiRun.updateMany({ where: { id: run.id, status: 'WAITING_APPROVAL' }, data: { status: 'SUCCEEDED', finishedAt: new Date(), version: { increment: 1 } } });
      return { id: callId, status: 'DENIED' };
    });
  }
  // ------------------------------------------------------------------ 07 usage
  async usage(actor: Principal, raw: unknown) {
    const q = z.object({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(), groupBy: z.enum(['scenario', 'model', 'user']).default('scenario') }).strict().parse(raw);
    const workspaceWide = actor.grants.has('ai.usage.readWorkspace');
    if (!workspaceWide) requirePermission(actor, 'ai.usage.readOwn');
    const by = q.groupBy === 'scenario' ? 'scenarioCode' : q.groupBy === 'model' ? 'modelId' : 'userId';
    const rows = await this.db.aiUsageRecord.groupBy({ by: [by, 'costMode', 'costCurrency'], where: { workspaceId: actor.workspaceId, ...(workspaceWide ? {} : { userId: actor.userId }), occurredAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } },
      _sum: { inputTokens: true, outputTokens: true, cachedTokens: true, costAmount: true, credits: true }, _count: true });
    return rows.map(r => ({ key: (r as Record<string, unknown>)[by], costMode: r.costMode, currency: r.costCurrency, runs: r._count, inputTokens: r._sum.inputTokens ?? 0, outputTokens: r._sum.outputTokens ?? 0, cachedTokens: r._sum.cachedTokens ?? 0,
      cost: (r._sum.costAmount ?? D(0)).toFixed(), credits: (r._sum.credits ?? D(0)).toFixed() }));
  }
  async runUsage(actor: Principal, runId: string) {
    const run = await this.load(actor, runId);
    return this.db.aiUsageRecord.findMany({ where: { runId: run.id }, orderBy: { occurredAt: 'asc' } });
  }
  // ------------------------------------------------------------------ internal (service identity)
  async internalRoute(authorization: string | null, raw: unknown) {
    assertServiceIdentity(authorization);
    const input = z.strictObject({ scenarioId: z.string().max(80), workspaceId: z.uuid(), classification: z.enum(CLASSIFICATIONS), costLimit: z.string().regex(/^\d+(\.\d{1,6})?$/).optional() }).parse(raw);
    const scenario = SCENARIOS[input.scenarioId]; if (!scenario) throw notFound('Scenario');
    const c = (await eligibleCandidates(this.db, input.workspaceId, scenario, input.classification)).filter(x => !input.costLimit || !x.maxCost || x.maxCost.lte(D(input.costLimit)));
    return c.map(x => ({ routeId: x.routeId, modelId: x.modelId, provider: x.providerCode, region: x.region, costMode: x.costMode }));
  }
  async internalContext(authorization: string | null, raw: unknown) {
    assertServiceIdentity(authorization);
    const input = z.strictObject({ userContext: z.strictObject({ workspaceId: z.uuid(), userId: z.uuid() }), scenarioId: z.string().max(80), query: z.string().min(1).max(2000), retrievalProfileId: z.uuid().optional(), runId: z.uuid() }).parse(raw);
    const actor = await resolvePrincipal(this.db, input.userContext.workspaceId, input.userContext.userId);
    const run = await this.db.aiRun.findFirst({ where: { id: input.runId, workspaceId: actor.workspaceId, requesterId: actor.userId } }); if (!run) throw notFound('Run');
    const sources = await buildContext(this.db, actor, run, input.query, [], input.retrievalProfileId ?? null);
    return sources.map(s => ({ n: s.n, sourceType: s.sourceType, sourceId: s.sourceId, version: s.version, anchor: s.anchor, excerptHash: sha(s.text) }));
  }
  async internalEvaluate(authorization: string | null, raw: unknown) {
    assertServiceIdentity(authorization);
    const input = z.strictObject({ sourceIds: z.array(z.strictObject({ type: z.string().max(40), id: z.uuid() })).max(100), principal: z.strictObject({ workspaceId: z.uuid(), userId: z.uuid() }), classification: z.enum(CLASSIFICATIONS) }).parse(raw);
    const actor = await resolvePrincipal(this.db, input.principal.workspaceId, input.principal.userId);
    const out = [];
    for (const s of input.sourceIds) out.push({ ...s, allowed: (await this.db.$transaction(tx => visibleIds(tx, actor, s.type, [s.id]))).has(s.id) });
    return out;
  }
  async internalToolExecute(authorization: string | null, toolCode: string, raw: unknown) {
    assertServiceIdentity(authorization);
    const input = z.strictObject({ toolCallId: z.uuid(), workspaceId: z.uuid() }).parse(raw);
    const call = await this.db.aiToolCall.findFirst({ where: { id: input.toolCallId, workspaceId: input.workspaceId, toolCode } }); if (!call) throw notFound('Tool call');
    if (call.status === 'WAITING_APPROVAL') throw new AppError('BUSINESS_RULE_VIOLATION', 'This tool call still needs user approval.', 422);
    return executeToolCall(this.db, call.id, null);
  }
  async internalSettle(authorization: string | null, raw: unknown) {
    assertServiceIdentity(authorization);
    const input = z.strictObject({ runId: z.uuid() }).parse(raw);
    return this.db.aiUsageRecord.findMany({ where: { runId: input.runId } }); // settlement itself is owned by the run worker + Billing (idempotent event keys)
  }
}
