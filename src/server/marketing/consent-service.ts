import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { parse, uuid } from '../process-platform/dto';
import { evidence, requirePermission, type Principal, type Tx } from '../process-platform/context';
import { checkRateLimit } from '../rate-limit';
import { entitled, inTx, listQuery, newToken, paged, sha256, systemEvent } from '../suite/kernel';
import { channel, destinationOf, eligibility } from './support';

const purpose = z.enum(['MARKETING', 'NEWSLETTER', 'PROMOTIONAL', 'TRANSACTIONAL', 'ADVERTISING']);
const subject = z.strictObject({ destination: z.string().min(3).max(254).optional(), destinationHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), subjectRef: z.string().regex(/^(CONTACT|AUDIENCE):[0-9a-f-]{36}$/).optional() })
  .refine(v => v.destination || v.destinationHash, 'A destination is required');

/** Consent, suppression and opt-out (spec Marketing/03). Consent history is append-only; suppression always wins. */
export class MarketingConsentService {
  constructor(private readonly db: PrismaClient) {}
  private hashOf(input: { destination?: string; destinationHash?: string }, ch: z.infer<typeof channel>) { return input.destinationHash ?? destinationOf(ch, input.destination!).hash; }

  async record(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ subject, channel, purpose, lawfulBasis: z.enum(['CONSENT', 'LEGITIMATE_INTEREST', 'CONTRACT', 'LEGAL_OBLIGATION']), source: z.enum(['WEB_FORM', 'CHECKOUT', 'PAPER', 'API', 'DOUBLE_OPT_IN', 'IMPORT_EVIDENCE']),
      evidenceFileId: uuid.optional(), jurisdiction: z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,8})?$|^DEFAULT$/), effectiveAt: z.iso.datetime({ offset: true }).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.consent.manage'); entitled(actor, 'marketing');
      if (['PAPER', 'IMPORT_EVIDENCE'].includes(input.source) && !input.evidenceFileId) throw new AppError('VALIDATION_FAILED', 'Verified evidence is required for this source.', 400, { fields: [{ field: 'evidenceFileId', reason: 'REQUIRED' }] });
      if (input.evidenceFileId && !await tx.driveFile.findFirst({ where: { workspaceId: actor.workspaceId, id: input.evidenceFileId } })) throw new AppError('NOT_FOUND', 'Evidence file was not found.', 404);
      if (input.subject.subjectRef?.startsWith('CONTACT:') && !await tx.crmContact.findFirst({ where: { workspaceId: actor.workspaceId, id: input.subject.subjectRef.slice(8) } })) throw new AppError('NOT_FOUND', 'Subject was not found.', 404);
      const hash = this.hashOf(input.subject, input.channel);
      const row = await tx.marketingConsentRecord.create({ data: { workspaceId: actor.workspaceId, subjectRef: input.subject.subjectRef, destinationHash: hash, channel: input.channel, purpose: input.purpose, lawfulBasis: input.lawfulBasis,
        source: input.source, evidenceFileId: input.evidenceFileId, jurisdiction: input.jurisdiction, state: 'GRANTED', effectiveAt: input.effectiveAt ? new Date(input.effectiveAt) : new Date(), recordedByUserId: actor.userId } });
      await evidence(tx, actor, 'MARKETING_CONSENT', row.id, 'CONSENT_GRANTED', { channel: row.channel, purpose: row.purpose, jurisdiction: row.jurisdiction });
      return { id: row.id, destinationHash: hash, state: row.state, effectiveAt: row.effectiveAt };
    });
  }
  async withdraw(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ subject, channel, purpose, reason: z.string().trim().max(500).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.consent.manage');
      return MarketingConsentService.withdrawInTx(tx, actor.workspaceId, this.hashOf(input.subject, input.channel), input.channel, input.purpose, 'STAFF', actor);
    });
  }
  static async withdrawInTx(tx: Tx, workspaceId: string, hash: string, ch: string, purposeValue: string, source: string, actor?: Principal) {
    const row = await tx.marketingConsentRecord.create({ data: { workspaceId, destinationHash: hash, channel: ch, purpose: purposeValue, lawfulBasis: 'CONSENT', source, jurisdiction: 'DEFAULT', state: 'WITHDRAWN', effectiveAt: new Date(), recordedByUserId: actor?.userId } });
    await tx.marketingSuppression.create({ data: { workspaceId, destinationHash: hash, channel: ch, reason: 'UNSUBSCRIBE', createdByUserId: actor?.userId } });
    if (actor) await evidence(tx, actor, 'MARKETING_CONSENT', row.id, 'CONSENT_WITHDRAWN', { channel: ch, purpose: purposeValue });
    else await systemEvent(tx, workspaceId, 'MARKETING_CONSENT', row.id, 'CONSENT_WITHDRAWN', { channel: ch, purpose: purposeValue, source });
    await MarketingConsentService.cancelPending(tx, workspaceId, hash, ch);
    return { id: row.id, state: 'WITHDRAWN' };
  }
  /** Unsent queued deliveries for a newly suppressed destination become SUPPRESSED (accepted sends are never retracted). */
  static async cancelPending(tx: Tx, workspaceId: string, hash: string, ch: string) {
    await tx.marketingDelivery.updateMany({ where: { workspaceId, destinationHash: hash, channel: ch === 'ALL' ? undefined : ch, state: { in: ['QUEUED', 'DEFERRED', 'FAILED_RETRYABLE'] } }, data: { state: 'SUPPRESSED', lastErrorCode: 'RECIPIENT_SUPPRESSED' } });
  }
  async history(actor: Principal, raw: unknown) {
    const q = parse(listQuery.extend({ destination: z.string().max(254).optional(), destinationHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), channel: channel.optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.consent.manage');
      const hash = q.destinationHash ?? (q.destination && q.channel ? destinationOf(q.channel, q.destination).hash : undefined);
      const where = { workspaceId: actor.workspaceId, ...(hash ? { destinationHash: hash } : {}), ...(q.channel ? { channel: q.channel } : {}) };
      const [rows, total] = await Promise.all([tx.marketingConsentRecord.findMany({ where, orderBy: [{ effectiveAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit }), tx.marketingConsentRecord.count({ where })]);
      return paged(rows, total, q.page, q.limit);
    });
  }
  async suppress(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ subject, channel: z.union([channel, z.literal('ALL')]), reason: z.enum(['MANUAL', 'POLICY', 'COMPLAINT', 'HARD_BOUNCE']), expiresAt: z.iso.datetime({ offset: true }).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.consent.manage');
      const hash = input.subject.destinationHash ?? destinationOf(input.channel === 'ALL' ? 'EMAIL' : input.channel, input.subject.destination!).hash;
      const row = await tx.marketingSuppression.create({ data: { workspaceId: actor.workspaceId, destinationHash: hash, channel: input.channel, reason: input.reason, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, createdByUserId: actor.userId } });
      await MarketingConsentService.cancelPending(tx, actor.workspaceId, hash, input.channel);
      await evidence(tx, actor, 'MARKETING_SUPPRESSION', row.id, 'RECIPIENT_SUPPRESSED', { channel: row.channel, reason: row.reason });
      return row;
    });
  }
  async suppressions(actor: Principal, raw: unknown) {
    const q = parse(listQuery.extend({ channel: z.string().optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.consent.manage');
      const where = { workspaceId: actor.workspaceId, liftedAt: null, ...(q.channel ? { channel: q.channel } : {}) };
      const [rows, total] = await Promise.all([tx.marketingSuppression.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit }), tx.marketingSuppression.count({ where })]);
      return paged(rows, total, q.page, q.limit); // destinations are only hashes; never reversible here
    });
  }
  async policy(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ jurisdiction: z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,8})?$|^DEFAULT$/), channel, purpose, consentRequired: z.boolean(),
      quietHours: z.strictObject({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/), timezone: z.string().optional() }).optional(),
      frequencyCap: z.strictObject({ maxMessages: z.number().int().min(1).max(1000), windowHours: z.number().int().min(1).max(8760) }).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.consent.manage');
      const key = { workspaceId_jurisdiction_channel_purpose: { workspaceId: actor.workspaceId, jurisdiction: input.jurisdiction, channel: input.channel, purpose: input.purpose } };
      const row = await tx.marketingConsentPolicy.upsert({ where: key, create: { workspaceId: actor.workspaceId, ...input, quietHours: input.quietHours ?? {}, frequencyCap: input.frequencyCap ?? {} },
        update: { consentRequired: input.consentRequired, quietHours: input.quietHours ?? {}, frequencyCap: input.frequencyCap ?? {}, rulesVersion: { increment: 1 } } });
      await evidence(tx, actor, 'MARKETING_CONSENT_POLICY', row.id, 'CONSENT_POLICY_CHANGED', { jurisdiction: row.jurisdiction, channel: row.channel, purpose: row.purpose, rulesVersion: row.rulesVersion });
      return row;
    });
  }
  async preview(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ subject, channel, purpose, jurisdiction: z.string().default('DEFAULT') }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.consent.manage');
      const hash = this.hashOf(input.subject, input.channel);
      return { destinationHash: hash, eligibility: await eligibility(tx, actor.workspaceId, { destinationHash: hash, channel: input.channel, purpose: input.purpose, jurisdiction: input.jurisdiction }) };
    });
  }
  /** One-click unsubscribe; works without CRM access. Token is single-scope, hashed and rate limited. */
  async unsubscribe(raw: unknown, client: string) {
    const input = parse(z.strictObject({ token: z.string().min(20).max(200) }), raw);
    checkRateLimit(client, { scope: 'marketing.unsubscribe', limit: 30, windowMs: 600000 });
    return this.db.$transaction(async tx => {
      const row = await tx.marketingOptoutToken.findUnique({ where: { tokenHash: sha256(input.token) } });
      if (!row) throw new AppError('NOT_FOUND', 'Unsubscribe link is invalid.', 404);
      if (row.expiresAt <= new Date()) throw new AppError('RESOURCE_EXPIRED', 'Unsubscribe link expired.', 410);
      if (!row.usedAt) {
        await tx.marketingOptoutToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
        await MarketingConsentService.withdrawInTx(tx, row.workspaceId, row.destinationHash, row.channel, 'MARKETING', 'UNSUBSCRIBE_LINK');
      }
      return { unsubscribed: true };
    });
  }
  static async issueOptout(tx: Tx, workspaceId: string, hash: string, ch: string, campaignId: string) {
    const token = newToken('uns_');
    await tx.marketingOptoutToken.create({ data: { workspaceId, destinationHash: hash, channel: ch, campaignId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 365 * 86400000) } });
    return token;
  }
}
