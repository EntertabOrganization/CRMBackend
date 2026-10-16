import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, resolvePrincipal, type Principal } from '../process-platform/context';
import { enqueueJob, registerJob } from '../platform/events-service';
import { audit, emitEvent, notFound } from '../platform/kernel';
import { decrypt, encrypt, entitled } from '../suite/kernel';
import { readCleanFile } from '../suite/files-port';
import { runStateUnit } from '../response';
import { FileArtifactService } from '../collab/files/artifact-service';
import { UsageService } from '../billing/usage-service';
import { scenarioEnabled, workspaceAiSettings } from './config-service';
import { adapterFor, connectionSecret } from './providers';
import { CONTENT_SCENARIOS, EXTRACTION_TARGETS, SCENARIOS } from './registry';
import { AiRunService, eligibleCandidates, priceOf } from './run-service';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const MEDIA_ESTIMATE_TOKENS = 4000, MAX_AUDIO_BYTES = 25 * 1024 * 1024;

async function mediaRun(db: PrismaClient, actor: Principal, scenarioCode: 'media.transcribe' | 'media.image', idempotencyKey: string, payload: Record<string, unknown>) {
  const scenario = SCENARIOS[scenarioCode];
  requirePermission(actor, 'ai.scenario.execute'); requirePermission(actor, scenario.requiredPermission); entitled(actor, 'ai');
  if (!scenarioEnabled(await workspaceAiSettings(db, actor.workspaceId), scenarioCode, actor.roleId)) throw new AppError('PERMISSION_DENIED', 'This AI scenario is not enabled.', 403);
  const candidates = await eligibleCandidates(db, actor.workspaceId, scenario, 'INTERNAL');
  if (!candidates.length) throw new AppError('BUSINESS_RULE_VIOLATION', 'No approved model route supports this capability.', 422, { reason: 'NO_ELIGIBLE_ROUTE' });
  const cand = candidates[0], est = priceOf(cand, MEDIA_ESTIMATE_TOKENS, MEDIA_ESTIMATE_TOKENS);
  const inputHash = sha(JSON.stringify({ scenarioCode, payload }));
  return db.$transaction(async tx => {
    const prior = await tx.aiRun.findUnique({ where: { workspaceId_requesterId_scenarioCode_idempotencyKey: { workspaceId: actor.workspaceId, requesterId: actor.userId, scenarioCode, idempotencyKey } } });
    if (prior) { if (prior.inputHash !== inputHash) throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key was used with a different request.', 409); return { run: prior, created: false }; }
    const run = await tx.aiRun.create({ data: { workspaceId: actor.workspaceId, requesterId: actor.userId, scenarioCode, scenarioVersion: scenario.version, routeId: cand.routeId, routeVersion: cand.routeVersion, inputHash, inputSealed: encrypt(JSON.stringify(payload)), idempotencyKey, costMode: cand.costMode, estimatedCredits: cand.costMode === 'PLATFORM' ? est.credits : D(0) } });
    if (cand.costMode === 'PLATFORM') {
      const reservation = await UsageService.reserve(tx, { workspaceId: actor.workspaceId, meterCode: 'ai.credits', units: est.credits.gt(0) ? est.credits : D('0.000001'), operationKey: 'ai-run:' + run.id, sourceModule: 'ai', scenario: scenarioCode, runId: run.id });
      await tx.aiRun.update({ where: { id: run.id }, data: { usageReservationId: reservation.id, estimatedCredits: reservation.estimate } });
    }
    await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'AI_RUN_QUEUED', aggregateType: 'AiRun', aggregateId: run.id, aggregateVersion: 1, actorId: actor.userId, payload: { scenario: scenarioCode } });
    return { run, created: true };
  });
}
async function settleMedia(db: PrismaClient, runId: string, status: 'SUCCEEDED' | 'FAILED', usage: { tokensIn: number; tokensOut: number; estimated: boolean } | null, errorCode: string | null = null) {
  const run = await db.aiRun.findUniqueOrThrow({ where: { id: runId } });
  const route = run.routeId ? await db.aiRoute.findUnique({ where: { id: run.routeId } }) : null;
  const model = route ? await db.aiModel.findUnique({ where: { id: route.modelId } }) : null;
  await db.$transaction(async tx => {
    if (usage && model && route) {
      const p = priceOf(model, usage.tokensIn, usage.tokensOut), key = `ai-run:${run.id}:media`;
      if (!await tx.aiUsageRecord.findUnique({ where: { billingEventKey: key } }))
        await tx.aiUsageRecord.create({ data: { workspaceId: run.workspaceId, runId: run.id, userId: run.requesterId, scenarioCode: run.scenarioCode, modelId: model.id, connectionId: route.connectionId, costMode: run.costMode ?? 'PLATFORM', inputTokens: usage.tokensIn, outputTokens: usage.tokensOut,
          estimated: usage.estimated, costAmount: p.cost, costCurrency: model.rateCurrency, credits: run.costMode === 'PLATFORM' ? p.credits : D(0), pricingVersion: model.catalogVersion, billingEventKey: key } });
      if (run.usageReservationId) await UsageService.settle(tx, run.usageReservationId, Prisma.Decimal.min(p.credits, run.estimatedCredits), key, 'ai.run:' + run.id);
    } else if (run.usageReservationId) await UsageService.release(tx, run.usageReservationId, status);
    await tx.aiRun.update({ where: { id: run.id }, data: { status, errorCode, finishedAt: new Date(), version: { increment: 1 } } });
    await emitEvent(tx, { workspaceId: run.workspaceId, eventType: status === 'SUCCEEDED' ? 'AI_RUN_SUCCEEDED' : 'AI_RUN_FAILED', aggregateType: 'AiRun', aggregateId: run.id, actorType: 'SERVICE', payload: { scenario: run.scenarioCode, errorCode } });
  });
}
async function mediaConnection(db: PrismaClient, runId: string) {
  const run = await db.aiRun.findUniqueOrThrow({ where: { id: runId } });
  const route = await db.aiRoute.findUniqueOrThrow({ where: { id: run.routeId! } });
  const [conn, model] = await Promise.all([db.aiProviderConnection.findUniqueOrThrow({ where: { id: route.connectionId } }), db.aiModel.findUniqueOrThrow({ where: { id: route.modelId } })]);
  if (conn.status !== 'CONNECTED') throw new AppError('DEPENDENCY_UNAVAILABLE', 'Connection suspended.', 503);
  const provider = await db.aiProvider.findUniqueOrThrow({ where: { id: conn.providerId } });
  return { run, conn, model, adapter: adapterFor(provider.code) };
}

/** Transcription: source file must still be readable+scanned by the requester at execution (10 AC02); text sealed at rest. */
registerJob({ type: 'ai.transcribe', ownerModule: 'ai', maxAttempts: 2, async run(ctx) {
  const { prisma } = await import('../prisma-client');
  const claimed = await prisma.aiRun.updateMany({ where: { id: String(ctx.payload.runId), status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: new Date() } });
  if (!claimed.count) return { skipped: true };
  const { run, conn, model, adapter } = await mediaConnection(prisma, String(ctx.payload.runId));
  const input = JSON.parse(decrypt(run.inputSealed)!) as { fileId: string; language?: string; diarization?: boolean };
  try {
    const actor = await resolvePrincipal(prisma, run.workspaceId, run.requesterId);
    const { version, bytes } = await prisma.$transaction(tx => readCleanFile(tx, actor, input.fileId, MAX_AUDIO_BYTES));
    if (!/^(audio|video)\//.test(version.mimeType)) throw new AppError('VALIDATION_FAILED', 'Only audio/video files can be transcribed.', 400);
    if (!adapter.transcribe) throw new AppError('DEPENDENCY_UNAVAILABLE', 'The routed provider does not support transcription.', 503);
    const result = await adapter.transcribe(connectionSecret(conn), conn.endpoint, bytes, version.mimeType, input.language ?? null, { model: model.modelKey, diarization: !!input.diarization });
    if (input.diarization && !result.segments) throw new AppError('DEPENDENCY_UNAVAILABLE', 'The approved provider route did not return speaker segments.', 503);
    await prisma.aiTranscript.create({ data: { workspaceId: run.workspaceId, sourceFileId: input.fileId, runId: run.id, scenarioCode: run.scenarioCode, language: input.language ?? null, diarizationMeta: input.diarization ? { requested: true, supported: true, segmentsSealed: encrypt(JSON.stringify(result.segments)) } : Prisma.DbNull, textSealed: encrypt(result.text), createdBy: run.requesterId } });
    await settleMedia(prisma, run.id, 'SUCCEEDED', { tokensIn: Math.max(1, Math.ceil(result.durationSeconds * 25)), tokensOut: Math.ceil(result.text.length / 4), estimated: true });
  } catch (error) { await settleMedia(prisma, run.id, 'FAILED', null, error instanceof AppError ? error.code : 'TRANSCRIPTION_FAILED'); }
  return { done: true };
} });
/** Generated images go through Files scanning/storage; unsafe output is quarantined and never shareable (10 rule 3, AC05). */
registerJob({ type: 'ai.image', ownerModule: 'ai', maxAttempts: 2, async run(ctx) {
  const { prisma } = await import('../prisma-client');
  const claimed = await prisma.aiRun.updateMany({ where: { id: String(ctx.payload.runId), status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: new Date() } });
  if (!claimed.count) return { skipped: true };
  const { run, conn, adapter } = await mediaConnection(prisma, String(ctx.payload.runId));
  const input = JSON.parse(decrypt(run.inputSealed)!) as { brief: string };
  try {
    if (!adapter.generateImage) throw new AppError('DEPENDENCY_UNAVAILABLE', 'The routed provider does not support images.', 503);
    const actor = await resolvePrincipal(prisma, run.workspaceId, run.requesterId);
    const image = await adapter.generateImage(connectionSecret(conn), conn.endpoint, input.brief, 'ai-image:' + run.id);
    const files = new FileArtifactService();
    let fileId: string | null = null, safety = 'SCANNED';
    try {
      const prepared = await files.prepare(run.workspaceId, image.bytes, image.mimeType);
      fileId = await prisma.$transaction(tx => files.publish(tx, actor, prepared, `ai-image-${run.id.slice(0, 8)}.png`), { timeout: 60000 });
    } catch { safety = 'QUARANTINED'; }
    await prisma.aiArtifact.create({ data: { runId: run.id, workspaceId: run.workspaceId, fileId, artifactType: 'IMAGE', mediaType: image.mimeType, safetyState: safety, reviewState: safety === 'QUARANTINED' ? 'BLOCKED' : 'PENDING_REVIEW' } });
    await prisma.$transaction(tx => emitEvent(tx, { workspaceId: run.workspaceId, eventType: 'AI_ARTIFACT_GENERATED', aggregateType: 'AiRun', aggregateId: run.id, actorType: 'SERVICE', payload: { safety } }));
    await settleMedia(prisma, run.id, 'SUCCEEDED', { tokensIn: Math.ceil(input.brief.length / 4), tokensOut: 1000, estimated: true });
  } catch (error) { await settleMedia(prisma, run.id, 'FAILED', null, error instanceof AppError ? error.code : 'IMAGE_FAILED'); }
  return { done: true };
} });

/** Domain assistance & media (29/10): every output is a draft; owning domains apply changes through their own services. */
export class AiDomainService {
  constructor(private readonly db: PrismaClient, private readonly runs = new AiRunService(db)) {}

  async transcribe(actor: Principal, raw: unknown) {
    const input = z.strictObject({ fileId: z.uuid(), language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(), diarization: z.boolean().default(false), idempotencyKey: z.string().min(8).max(200) }).parse(raw);
    await this.db.$transaction(tx => readCleanFile(tx, actor, input.fileId, MAX_AUDIO_BYTES)); // unauthorized/unscanned files fail before any charge
    const { run, created } = await mediaRun(this.db, actor, 'media.transcribe', input.idempotencyKey, { fileId: input.fileId, language: input.language, diarization: input.diarization });
    if (created) await enqueueJob(this.db, { type: 'ai.transcribe', ownerModule: 'ai', workspaceId: actor.workspaceId, payload: { runId: run.id }, idempotencyKey: 'ai-transcribe:' + run.id });
    return { runId: run.id, status: run.status };
  }
  async transcript(actor: Principal, runId: string) {
    const t = await this.db.aiTranscript.findFirst({ where: { runId: z.uuid().parse(runId), workspaceId: actor.workspaceId } });
    if (!t || t.createdBy !== actor.userId && !actor.grants.has('ai.run.readScoped')) throw notFound('Transcript');
    await this.db.$transaction(tx => readCleanFile(tx, actor, t.sourceFileId, MAX_AUDIO_BYTES)); // source access re-checked
    const meta = t.diarizationMeta as { segmentsSealed?: string } | null;
    return { id: t.id, sourceFileId: t.sourceFileId, language: t.language, reviewStatus: t.reviewStatus, text: decrypt(t.textSealed), segments: meta?.segmentsSealed ? JSON.parse(decrypt(meta.segmentsSealed)!) : null };
  }
  /** Extraction proposes target fields from an authorized source; nothing is written until apply (10 AC01). */
  async extractFields(actor: Principal, raw: unknown) {
    const input = z.strictObject({ sourceType: z.enum(['transcript', 'knowledge.article', 'text']), sourceId: z.string().max(80).optional(), text: z.string().max(20000).optional(), targetType: z.enum(Object.keys(EXTRACTION_TARGETS) as [string, ...string[]]), targetId: z.uuid().optional(), schemaVersion: z.number().int().positive(), idempotencyKey: z.string().min(8).max(200) }).parse(raw);
    const target = EXTRACTION_TARGETS[input.targetType];
    if (input.schemaVersion !== target.schemaVersion) throw new AppError('VALIDATION_FAILED', 'Unsupported target schema version.', 400);
    let sourceText = '';
    if (input.sourceType === 'text') sourceText = input.text ?? '';
    else if (input.sourceType === 'transcript') sourceText = (await this.transcript(actor, z.uuid().parse(input.sourceId))).text ?? '';
    else { const { KnowledgeArticleService } = await import('../knowledge/article-service'); const a = await new KnowledgeArticleService(this.db).get(actor, z.uuid().parse(input.sourceId), {}); sourceText = JSON.stringify(a.revision?.content ?? {}); }
    if (!sourceText.trim()) throw new AppError('VALIDATION_FAILED', 'Source has no text.', 400);
    const run = await this.runs.create(actor, { scenarioId: 'crm.extract-fields', input: { prompt: `<untrusted_source>\n${sourceText.slice(0, 20000)}\n</untrusted_source>` }, idempotencyKey: input.idempotencyKey });
    const extraction = await this.db.aiExtraction.create({ data: { workspaceId: actor.workspaceId, runId: run.id, sourceRef: `${input.sourceType}:${input.sourceId ?? 'inline'}`, targetType: input.targetType, targetId: input.targetId ?? null, schemaVersion: input.schemaVersion, proposedFields: {}, validationStatus: 'PENDING_RUN', createdBy: actor.userId } });
    return { extractionId: extraction.id, runId: run.id, status: extraction.validationStatus };
  }
  async extraction(actor: Principal, id: string) {
    const ex = await this.db.aiExtraction.findFirst({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId, createdBy: actor.userId } }); if (!ex) throw notFound('Extraction');
    if (ex.validationStatus === 'PENDING_RUN') {
      const run = await this.db.aiRun.findUniqueOrThrow({ where: { id: ex.runId } });
      if (run.status === 'SUCCEEDED' && run.outputSealed) {
        const out = JSON.parse(decrypt(run.outputSealed)!) as { text: string };
        const parsed = (() => { try { return JSON.parse(out.text) as { fields?: unknown }; } catch { return null; } })();
        const ok = EXTRACTION_TARGETS[ex.targetType].schema.safeParse(parsed?.fields);
        const updated = await this.db.aiExtraction.update({ where: { id: ex.id }, data: { proposedFields: ok.success ? ok.data as Prisma.InputJsonValue : {}, validationStatus: ok.success ? 'VALID' : 'INVALID', state: ok.success ? 'PROPOSED' : 'REJECTED' } });
        if (ok.success) await this.db.$transaction(tx => emitEvent(tx, { workspaceId: ex.workspaceId, eventType: 'AI_EXTRACTION_PROPOSED', aggregateType: 'AiExtraction', aggregateId: ex.id, actorType: 'SERVICE', payload: { targetType: ex.targetType } }));
        return updated;
      }
      if (['FAILED', 'CANCELLED'].includes(run.status)) return this.db.aiExtraction.update({ where: { id: ex.id }, data: { validationStatus: 'INVALID', state: 'REJECTED' } });
    }
    return ex;
  }
  /** Apply = owning CRM service update with optimistic version (stale target → 409, 10 AC03); only approved validated fields. */
  async applyExtraction(actor: Principal, id: string, raw: unknown, requestId: string) {
    const input = z.strictObject({ expectedTargetVersion: z.number().int().positive(), approvedFields: z.array(z.string().max(60)).min(1).max(20), targetId: z.uuid().optional() }).parse(raw);
    const ex = await this.extraction(actor, id);
    if (ex.state !== 'PROPOSED' && ex.state !== 'REVIEWED') throw new AppError('INVALID_STATE_TRANSITION', `Extraction is ${ex.state}.`, 409);
    const target = EXTRACTION_TARGETS[ex.targetType]; requirePermission(actor, target.permission);
    const proposed = ex.proposedFields as Record<string, unknown>;
    if (input.approvedFields.some(f => !(f in proposed))) throw new AppError('VALIDATION_FAILED', 'Approved fields must come from the validated proposal.', 400);
    const targetId = input.targetId ?? ex.targetId; if (!targetId) throw new AppError('VALIDATION_FAILED', 'targetId is required.', 400);
    const changes = Object.fromEntries(input.approvedFields.map(f => [f, proposed[f]]));
    await runStateUnit(async () => {
      const { appContext } = await import('../app-context');
      const user = appContext.store.state.users.find(u => u.id === actor.userId); if (!user) throw new AppError('PERMISSION_DENIED', 'User is unavailable.', 403);
      appContext.crmCore.updateRecord(user, actor.workspaceId, 'CONTACT', targetId, { ...changes, expectedVersion: input.expectedTargetVersion }, 'ai-extraction:' + ex.id);
    });
    return this.db.$transaction(async tx => {
      const row = await tx.aiExtraction.update({ where: { id: ex.id }, data: { state: 'APPLIED', targetId, appliedBy: actor.userId, appliedAt: new Date() } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'AI_EXTRACTION_APPLIED', resourceType: 'AiExtraction', resourceId: ex.id, after: { targetType: ex.targetType, targetId, fields: input.approvedFields }, requestId });
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'AI_EXTRACTION_APPLIED', aggregateType: 'AiExtraction', aggregateId: ex.id, actorId: actor.userId, payload: { targetType: ex.targetType } });
      return row;
    });
  }
  /** Draft content for a target module; publishing/sending stays with that module's approval flow (10 AC04). */
  async generateContent(actor: Principal, raw: unknown) {
    const input = z.strictObject({ targetModule: z.enum(Object.keys(CONTENT_SCENARIOS) as [string, ...string[]]), type: z.string().trim().min(1).max(60), prompt: z.string().trim().min(1).max(10000), sourceIds: z.array(z.strictObject({ type: z.enum(['drive.file', 'crm.contact']), id: z.uuid() })).max(10).default([]), idempotencyKey: z.string().min(8).max(200) }).parse(raw);
    const run = await this.runs.create(actor, { scenarioId: CONTENT_SCENARIOS[input.targetModule], input: { prompt: `Content type: ${input.type}\n${input.prompt}` }, contextRefs: input.sourceIds, idempotencyKey: input.idempotencyKey });
    return { ...run, draft: true, note: 'Generated content is a draft; it is not sent or published.' };
  }
  async generateImage(actor: Principal, raw: unknown) {
    const input = z.strictObject({ brief: z.string().trim().min(3).max(2000), providerRouteId: z.uuid().optional(), idempotencyKey: z.string().min(8).max(200) }).parse(raw);
    const { run, created } = await mediaRun(this.db, actor, 'media.image', input.idempotencyKey, { brief: input.brief });
    if (created) await enqueueJob(this.db, { type: 'ai.image', ownerModule: 'ai', workspaceId: actor.workspaceId, payload: { runId: run.id }, idempotencyKey: 'ai-image:' + run.id });
    return { runId: run.id, status: run.status };
  }
  async artifacts(actor: Principal, runId: string) {
    const run = await this.db.aiRun.findFirst({ where: { id: z.uuid().parse(runId), workspaceId: actor.workspaceId, requesterId: actor.userId } }); if (!run) throw notFound('Run');
    return this.db.aiArtifact.findMany({ where: { runId: run.id, artifactType: { not: 'CONVERSATION_EXPORT' } }, select: { id: true, fileId: true, artifactType: true, mediaType: true, safetyState: true, reviewState: true, createdAt: true } });
  }
  /** Review: only scanned artifacts can be approved; quarantined ones stay blocked and unshareable. */
  async reviewArtifact(actor: Principal, id: string, raw: unknown) {
    const input = z.strictObject({ decision: z.enum(['APPROVE', 'REJECT']) }).parse(raw);
    const a = await this.db.aiArtifact.findFirst({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId } }); if (!a) throw notFound('Artifact');
    const run = await this.db.aiRun.findUniqueOrThrow({ where: { id: a.runId } }); if (run.requesterId !== actor.userId) throw notFound('Artifact');
    if (a.safetyState !== 'SCANNED' && input.decision === 'APPROVE') throw new AppError('BUSINESS_RULE_VIOLATION', 'Quarantined artifacts cannot be approved or shared.', 422);
    return this.db.aiArtifact.update({ where: { id: a.id }, data: { reviewState: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' } });
  }
}
