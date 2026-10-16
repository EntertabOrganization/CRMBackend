import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, type Principal } from '../process-platform/context';
import { enqueueJob, registerJob } from '../platform/events-service';
import { legalHoldActive } from '../platform/privacy-service';
import { audit, emitEvent, notFound, paged } from '../platform/kernel';
import { decrypt, encrypt } from '../suite/kernel';
import { CLASSIFICATIONS } from './config-service';
import { AiRunService } from './run-service';

const EXPORT_TTL_HOURS = 24;

/** Deletion runs asynchronously after legal-hold/policy checks; held threads get an explainable status (03 AC03). */
registerJob({ type: 'ai.conversation.purge', ownerModule: 'ai', maxAttempts: 5, async run(ctx) {
  const { prisma } = await import('../prisma-client');
  const conv = await prisma.aiConversation.findUnique({ where: { id: String(ctx.payload.conversationId) } });
  if (!conv || conv.status !== 'DELETED' || conv.deletionState !== 'PENDING') return { skipped: true };
  if (await legalHoldActive(prisma, conv.workspaceId, 'ai', conv.id) || await legalHoldActive(prisma, conv.workspaceId, 'ai', conv.ownerUserId)) {
    await prisma.aiConversation.update({ where: { id: conv.id }, data: { deletionState: 'HELD_LEGAL_HOLD' } }); return { held: true };
  }
  await prisma.$transaction(async tx => {
    // Message bodies removed; minimal security/credit evidence (runs + usage records) is retained.
    await tx.aiMessage.updateMany({ where: { conversationId: conv.id }, data: { bodySealed: null, redactionState: 'PURGED' } });
    await tx.aiRun.updateMany({ where: { conversationId: conv.id }, data: { inputSealed: null, outputSealed: null } });
    await tx.aiConversation.update({ where: { id: conv.id }, data: { deletionState: 'PURGED', title: '' } });
  });
  return { purged: true };
} });

/** Conversations, messages and retention (29/03). Owner-only by default; no implicit admin/platform access. */
export class AiConversationService {
  constructor(private readonly db: PrismaClient, private readonly runs = new AiRunService(db)) {}

  private async load(actor: Principal, id: string, scoped = false) {
    const conv = await this.db.aiConversation.findFirst({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId, status: { not: 'DELETED' } } });
    if (!conv || conv.ownerUserId !== actor.userId && !(scoped && actor.grants.has('ai.conversation.readScoped'))) throw notFound('Conversation'); // colleagues get 404 (03 AC02)
    return conv;
  }
  async create(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'ai.run.create');
    const input = z.strictObject({ assistantId: z.uuid().optional(), classification: z.enum(CLASSIFICATIONS).default('INTERNAL'), noHistory: z.boolean().default(false), title: z.string().trim().max(200).default('') }).parse(raw);
    return this.db.$transaction(async tx => {
      if (input.assistantId && !await tx.aiAssistant.findFirst({ where: { id: input.assistantId, workspaceId: actor.workspaceId, status: 'ACTIVE' } })) throw notFound('Assistant');
      const conv = await tx.aiConversation.create({ data: { workspaceId: actor.workspaceId, ownerUserId: actor.userId, assistantId: input.assistantId ?? null, classification: input.classification, noHistory: input.noHistory, title: input.noHistory ? '' : input.title } });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'AI_CONVERSATION_CREATED', resourceType: 'AiConversation', resourceId: conv.id, after: { noHistory: conv.noHistory, classification: conv.classification }, requestId });
      await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'AI_CONVERSATION_CREATED', aggregateType: 'AiConversation', aggregateId: conv.id, actorId: actor.userId, payload: {} });
      return conv;
    });
  }
  async list(actor: Principal, raw: unknown) {
    requirePermission(actor, 'ai.conversation.readOwn');
    const q = z.object({ ownerId: z.literal('me').default('me'), status: z.enum(['ACTIVE', 'ARCHIVED']).default('ACTIVE'), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict().parse(raw);
    const where = { workspaceId: actor.workspaceId, ownerUserId: actor.userId, status: q.status }; // tenant + owner scoped (03 AC05)
    const [rows, total] = await Promise.all([this.db.aiConversation.findMany({ where, orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit }), this.db.aiConversation.count({ where })]);
    return paged(rows, total, q.page, q.limit);
  }
  /** Cursor pagination ordered (occurredAt, id); no-history threads expose no readable transcript (03 AC01). */
  async messages(actor: Principal, id: string, raw: unknown) {
    const conv = await this.load(actor, id, true);
    const q = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(raw);
    const [at, cid] = q.cursor ? Buffer.from(q.cursor, 'base64url').toString().split('|') : [];
    const rows = await this.db.aiMessage.findMany({ where: { conversationId: conv.id, ...(at ? { OR: [{ occurredAt: { gt: new Date(at) } }, { occurredAt: new Date(at), id: { gt: cid } }] } : {}) }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }], take: q.limit + 1 });
    const page = rows.slice(0, q.limit), last = page.at(-1);
    return { data: page.map(m => ({ id: m.id, sender: m.sender, body: m.redactionState === 'STORED' ? decrypt(m.bodySealed) : null, redactionState: m.redactionState, runId: m.modelRunId, occurredAt: m.occurredAt })),
      meta: { nextCursor: rows.length > q.limit && last ? Buffer.from(`${last.occurredAt.toISOString()}|${last.id}`).toString('base64url') : null } };
  }
  /** Unique client key: a retried send returns the same message/run, never a second paid request (03 AC04). */
  async send(actor: Principal, id: string, raw: unknown) {
    const conv = await this.load(actor, id);
    if (conv.status !== 'ACTIVE') throw new AppError('INVALID_STATE_TRANSITION', 'Conversation is not active.', 409);
    const input = z.strictObject({ content: z.string().trim().min(1).max(20000), idempotencyKey: z.string().min(8).max(200), contextRefs: z.array(z.strictObject({ type: z.enum(['drive.file', 'crm.contact']), id: z.uuid() })).max(10).default([]) }).parse(raw);
    const existing = await this.db.aiMessage.findUnique({ where: { conversationId_clientMessageKey: { conversationId: conv.id, clientMessageKey: input.idempotencyKey } } });
    if (existing?.modelRunId) return { messageId: existing.id, run: await this.runs.get(actor, existing.modelRunId), replayed: true };
    const run = await this.runs.create(actor, { scenarioId: 'assistant.chat', input: { prompt: input.content }, contextRefs: input.contextRefs, idempotencyKey: 'conv:' + input.idempotencyKey, ...(conv.assistantId ? { assistantId: conv.assistantId } : {}), classification: conv.classification }, conv.id);
    const message = await this.db.$transaction(async tx => {
      const row = existing ?? await tx.aiMessage.create({ data: { conversationId: conv.id, workspaceId: conv.workspaceId, sender: 'USER', bodySealed: encrypt(input.content), redactionState: 'STORED', modelRunId: run.id, clientMessageKey: input.idempotencyKey } });
      await tx.aiConversation.update({ where: { id: conv.id }, data: { lastMessageAt: new Date() } });
      await emitEvent(tx, { workspaceId: conv.workspaceId, eventType: 'AI_MESSAGE_ACCEPTED', aggregateType: 'AiConversation', aggregateId: conv.id, actorId: actor.userId, payload: { runId: run.id } });
      return row;
    });
    return { messageId: message.id, run, replayed: false };
  }
  async archive(actor: Principal, id: string) {
    const conv = await this.load(actor, id);
    return this.db.aiConversation.update({ where: { id: conv.id }, data: { status: 'ARCHIVED' } });
  }
  async remove(actor: Principal, id: string, requestId: string) {
    requirePermission(actor, 'ai.conversation.deleteOwn');
    const conv = await this.load(actor, id);
    return this.db.$transaction(async tx => {
      await tx.aiConversation.update({ where: { id: conv.id }, data: { status: 'DELETED', deletionState: 'PENDING' } });
      await enqueueJob(tx, { type: 'ai.conversation.purge', ownerModule: 'ai', workspaceId: conv.workspaceId, payload: { conversationId: conv.id }, idempotencyKey: 'ai-conv-purge:' + conv.id });
      await audit(tx, { workspaceId: conv.workspaceId, actorId: actor.userId, action: 'AI_CONVERSATION_DELETION_REQUESTED', resourceType: 'AiConversation', resourceId: conv.id, requestId });
      await emitEvent(tx, { workspaceId: conv.workspaceId, eventType: 'AI_CONVERSATION_DELETION_REQUESTED', aggregateType: 'AiConversation', aggregateId: conv.id, actorId: actor.userId, payload: {} });
      return { id: conv.id, status: 'DELETED', deletionState: 'PENDING' };
    });
  }
  async deletionStatus(actor: Principal, id: string) {
    const conv = await this.db.aiConversation.findFirst({ where: { id: z.uuid().parse(id), workspaceId: actor.workspaceId, ownerUserId: actor.userId } });
    if (!conv) throw notFound('Conversation');
    return { id: conv.id, status: conv.status, deletionState: conv.deletionState, explanation: conv.deletionState === 'HELD_LEGAL_HOLD' ? 'A legal hold requires keeping this conversation; it will be purged once released.' : null };
  }
  /** Export = sealed, expiring transcript artifact owned by the requester. */
  async export(actor: Principal, id: string, requestId: string) {
    requirePermission(actor, 'ai.conversation.export');
    const conv = await this.load(actor, id);
    if (conv.noHistory) throw new AppError('BUSINESS_RULE_VIOLATION', 'No-history conversations have no transcript to export.', 422);
    const msgs = await this.db.aiMessage.findMany({ where: { conversationId: conv.id, redactionState: 'STORED' }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
    const transcript = msgs.map(m => ({ sender: m.sender, at: m.occurredAt, body: decrypt(m.bodySealed) }));
    return this.db.$transaction(async tx => {
      const firstRun = msgs.find(m => m.modelRunId)?.modelRunId;
      const artifact = await tx.aiArtifact.create({ data: { runId: firstRun ?? conv.id, workspaceId: conv.workspaceId, artifactType: 'CONVERSATION_EXPORT', mediaType: 'application/json', safetyState: 'CLEAN', reviewState: 'READY', contentSealed: encrypt(JSON.stringify({ conversationId: conv.id, expiresAt: new Date(Date.now() + EXPORT_TTL_HOURS * 3600000), transcript })) } });
      await audit(tx, { workspaceId: conv.workspaceId, actorId: actor.userId, action: 'AI_CONVERSATION_EXPORTED', resourceType: 'AiConversation', resourceId: conv.id, after: { artifactId: artifact.id, messages: msgs.length }, requestId });
      return { artifactId: artifact.id, messages: msgs.length };
    });
  }
  async downloadExport(actor: Principal, artifactId: string) {
    const a = await this.db.aiArtifact.findFirst({ where: { id: z.uuid().parse(artifactId), workspaceId: actor.workspaceId, artifactType: 'CONVERSATION_EXPORT' } }); if (!a?.contentSealed) throw notFound('Export');
    const data = JSON.parse(decrypt(a.contentSealed)!) as { conversationId: string; expiresAt: string };
    await this.load(actor, data.conversationId); // re-authorize
    if (new Date(data.expiresAt) <= new Date()) throw new AppError('INVALID_STATE_TRANSITION', 'Export expired.', 409);
    return data;
  }
}
