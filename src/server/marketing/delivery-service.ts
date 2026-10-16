import { randomUUID } from 'node:crypto';
import type { MarketingDelivery, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { parse, uuid } from '../process-platform/dto';
import { evidence, lock, requirePermission, type Principal } from '../process-platform/context';
import { checkRateLimit } from '../rate-limit';
import { decrypt, inTx, listQuery, notFound, paged, sha256, systemEvent } from '../suite/kernel';
import { marketingSender, recordProviderCall, resolveSecret } from '../suite/providers';
import { eligibility, loadCampaign, type Channel } from './support';
import { render } from './channel-service';
import { MarketingConsentService } from './consent-service';

const MAX_ATTEMPTS = 5;
const TERMINAL = ['DELIVERED', 'BOUNCED', 'FAILED', 'SUPPRESSED', 'CANCELLED', 'INELIGIBLE'];
const ORDER: Record<string, number> = { QUEUED: 0, DEFERRED: 0, FAILED_RETRYABLE: 0, SENDING: 1, ACCEPTED: 2, DELIVERED: 3, BOUNCED: 3, FAILED: 3 };

/**
 * Per-recipient delivery worker (spec Marketing/07). Exactly-once business effect: unique delivery key, leased claim,
 * eligibility re-check immediately before send, provider lookup before any retry after an uncertain outcome.
 */
export class MarketingDeliveryService {
  constructor(private readonly db: PrismaClient) {}

  private async claim(id: string) {
    return this.db.$transaction(async tx => {
      const row = await tx.marketingDelivery.findUnique({ where: { id } });
      if (!row) return null;
      await lock(tx, row.workspaceId, 'marketing:delivery:' + id);
      const current = await tx.marketingDelivery.findUniqueOrThrow({ where: { id } }), now = new Date();
      const claimable = ['QUEUED', 'FAILED_RETRYABLE', 'DEFERRED'].includes(current.state) && current.nextAttemptAt <= now || current.state === 'SENDING' && current.leaseExpiresAt !== null && current.leaseExpiresAt <= now;
      if (!claimable || current.isTest) return null;
      const token = randomUUID();
      return tx.marketingDelivery.update({ where: { id }, data: { leaseToken: token, leaseExpiresAt: new Date(Date.now() + 120000) } });
    });
  }

  async process(id: string): Promise<string> {
    const row = await this.claim(id); if (!row) return 'SKIPPED';
    const campaign = await this.db.marketingCampaign.findUniqueOrThrow({ where: { id: row.campaignId } });
    const finish = (data: Partial<MarketingDelivery>, event?: string, payload: Record<string, unknown> = {}) => this.db.$transaction(async tx => {
      const current = await tx.marketingDelivery.findUniqueOrThrow({ where: { id } });
      if (current.leaseToken !== row.leaseToken) return 'LOST_LEASE';
      await tx.marketingDelivery.update({ where: { id }, data: { ...data, leaseToken: null, leaseExpiresAt: null } as object });
      if (event) await systemEvent(tx, row.workspaceId, 'MARKETING_DELIVERY', id, event, { campaignId: row.campaignId, ...payload }, false);
      return data.state ?? current.state;
    });
    if (campaign.status === 'CANCELLED') return finish({ state: 'CANCELLED' });
    if (campaign.status !== 'RUNNING') return finish({ nextAttemptAt: new Date(Date.now() + 60000) }); // paused: unclaimed work waits
    const [sender, connection, version, recipient] = await Promise.all([this.db.marketingSenderIdentity.findUnique({ where: { id: row.senderIdentityId } }), this.db.marketingProviderConnection.findUnique({ where: { id: row.providerConnectionId } }),
      this.db.marketingTemplateVersion.findUnique({ where: { id: row.templateVersionId } }), row.recipientId ? this.db.marketingAudienceRecipient.findUnique({ where: { id: row.recipientId } }) : null]);
    if (!sender || sender.status !== 'VERIFIED') return finish({ state: 'DEFERRED', lastErrorCode: 'SENDER_REVOKED', nextAttemptAt: new Date(Date.now() + 300000) });
    if (!connection || connection.status === 'DISABLED' || connection.status === 'DEGRADED') return finish({ state: 'DEFERRED', lastErrorCode: 'PROVIDER_CREDENTIALS_UNAVAILABLE', nextAttemptAt: new Date(Date.now() + 300000) });
    if (!version || !recipient) return finish({ state: 'FAILED', lastErrorCode: 'CONTENT_UNAVAILABLE' }, 'DELIVERY_FAILED');
    // Timeout-after-accept: if a previous attempt may have reached the provider, reconcile before sending again.
    const sendAdapter = marketingSender(connection.provider, row.channel as Channel);
    const ctx = { workspaceId: row.workspaceId, connectionId: connection.id, correlationId: row.campaignId, idempotencyKey: 'delivery:' + row.id, secretRef: connection.credentialSecretRef };
    if (row.state === 'SENDING' || row.attemptCount > 0) {
      const known = await sendAdapter.lookupDelivery(ctx, row.id).catch(() => ({ state: 'UNKNOWN' as const, externalMessageId: undefined }));
      if (known.state === 'ACCEPTED' || known.state === 'DELIVERED') return finish({ state: known.state, providerMessageId: known.externalMessageId ?? row.providerMessageId, sentAt: row.sentAt ?? new Date() }, 'MESSAGE_ACCEPTED', { reconciled: true });
      if (await this.db.suiteProviderCall.findFirst({ where: { idempotencyKey: ctx.idempotencyKey, outcome: 'ACCEPTED' } })) return finish({ state: 'ACCEPTED' }, 'MESSAGE_ACCEPTED', { reconciled: true });
    }
    // Eligibility immediately before send (suppression, consent, quiet hours, frequency caps).
    const state = await this.db.$transaction(tx => eligibility(tx, row.workspaceId, { destinationHash: row.destinationHash, channel: row.channel, purpose: campaign.purpose, jurisdiction: campaign.jurisdiction, timezone: campaign.timezone, campaignId: campaign.id }));
    if (state === 'SUPPRESSED' || state === 'UNKNOWN_CONSENT' || state === 'POLICY_MISSING' || state === 'INVALID_DESTINATION') return finish({ state: 'SUPPRESSED', lastErrorCode: state }, 'DELIVERY_STATUS_CHANGED', { state: 'SUPPRESSED', reason: state });
    if (state === 'QUIET_HOURS' || state === 'FREQUENCY_BLOCKED') return finish({ state: 'DEFERRED', lastErrorCode: state, nextAttemptAt: new Date(Date.now() + 1800000) });
    const quotas = connection.quotas as { perMinute?: number };
    if (quotas.perMinute && await this.db.marketingDelivery.count({ where: { providerConnectionId: connection.id, sentAt: { gte: new Date(Date.now() - 60000) } } }) >= quotas.perMinute)
      return finish({ state: 'DEFERRED', lastErrorCode: 'RATE_LIMITED', nextAttemptAt: new Date(Date.now() + 60000) });
    const attemptNo = row.attemptCount + 1;
    await this.db.marketingDelivery.update({ where: { id }, data: { state: 'SENDING', attemptCount: attemptNo } });
    const destination = decrypt(recipient.destinationSealed)!;
    const optout = await this.db.$transaction(tx => MarketingConsentService.issueOptout(tx, row.workspaceId, row.destinationHash, row.channel, row.campaignId));
    const contactName = recipient.sourceRef.startsWith('CONTACT:') ? await this.db.crmContact.findUnique({ where: { id: recipient.sourceRef.slice(8) } }) : null;
    const fallbacks = Object.fromEntries(Object.entries(version.variableSchema as Record<string, { fallback?: string }>).filter(([, v]) => v.fallback !== undefined).map(([k, v]) => [k, v.fallback!]));
    let body: string, subject: string | null;
    try {
      const values = { firstName: contactName?.firstName, lastName: contactName?.lastName, displayName: contactName?.displayName, unsubscribeUrl: (process.env.PUBLIC_BASE_URL ?? '') + '/api/v1/public/marketing/unsubscribe?token=' + optout };
      body = render(version.bodyText, values, fallbacks); subject = version.subject ? render(version.subject, values, fallbacks) : null;
    } catch { return finish({ state: 'FAILED', lastErrorCode: 'MISSING_REQUIRED_VARIABLE' }, 'DELIVERY_FAILED'); }
    let result: { accepted: boolean; retryable: boolean; externalMessageId?: string; errorCode?: string };
    try { result = await sendAdapter.send(ctx, { deliveryId: row.id, destination, senderAddress: sender.address, subject, body, templateName: version.providerTemplate }); }
    catch { result = { accepted: false, retryable: true, errorCode: 'PROVIDER_TIMEOUT' }; }
    await this.db.$transaction(async tx => {
      await tx.marketingDeliveryAttempt.create({ data: { workspaceId: row.workspaceId, deliveryId: row.id, attemptNo, providerRequestId: ctx.idempotencyKey + ':' + attemptNo, providerMessageId: result.externalMessageId, responseCode: result.accepted ? 'ACCEPTED' : result.errorCode ?? 'FAILED' } });
      if (result.accepted) await recordProviderCall(tx, { workspaceId: row.workspaceId, module: 'marketing', provider: connection.provider, operation: 'SEND', idempotencyKey: ctx.idempotencyKey, campaignId: row.campaignId, recipientKey: row.recipientKey, reference: result.externalMessageId, outcome: 'ACCEPTED', payload: { attemptNo } });
      await systemEvent(tx, row.workspaceId, 'MARKETING_DELIVERY', id, 'MESSAGE_SEND_ATTEMPTED', { campaignId: row.campaignId, attemptNo }, false);
    });
    if (result.accepted) return finish({ state: 'ACCEPTED', providerMessageId: result.externalMessageId, sentAt: new Date(), lastErrorCode: null }, 'MESSAGE_ACCEPTED');
    if (result.errorCode === 'PROVIDER_TIMEOUT') return finish({ state: 'SENDING', lastErrorCode: 'PROVIDER_TIMEOUT', nextAttemptAt: new Date(Date.now() + 60000) }); // reconciled on next claim
    if (!result.retryable) {
      if (result.errorCode === 'INVALID_DESTINATION') await this.db.$transaction(tx => tx.marketingSuppression.create({ data: { workspaceId: row.workspaceId, destinationHash: row.destinationHash, channel: row.channel, reason: 'HARD_BOUNCE' } }));
      return finish({ state: 'FAILED', lastErrorCode: result.errorCode }, 'DELIVERY_FAILED', { errorCode: result.errorCode });
    }
    if (attemptNo >= MAX_ATTEMPTS) return finish({ state: 'FAILED', lastErrorCode: result.errorCode }, 'DELIVERY_FAILED', { errorCode: result.errorCode, deadLetter: true });
    const backoff = Math.min(3600000, 30000 * 2 ** attemptNo) + Math.floor(Math.random() * 5000);
    return finish({ state: result.errorCode === 'PROVIDER_QUOTA' ? 'DEFERRED' : 'FAILED_RETRYABLE', lastErrorCode: result.errorCode, nextAttemptAt: new Date(Date.now() + backoff) });
  }

  async tick(limit = 50) {
    const now = new Date();
    const rows = await this.db.marketingDelivery.findMany({ where: { isTest: false, OR: [{ state: { in: ['QUEUED', 'FAILED_RETRYABLE', 'DEFERRED'] }, nextAttemptAt: { lte: now } }, { state: 'SENDING', leaseExpiresAt: { lte: now } }] }, orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: limit });
    let processed = 0;
    for (const row of rows) { try { if ((await this.process(row.id)) !== 'SKIPPED') processed++; } catch { /* retried on next tick */ } }
    // Complete campaigns whose deliveries are all terminal.
    const running = await this.db.marketingCampaign.findMany({ where: { status: 'RUNNING' }, take: 50 });
    for (const c of running) if (!await this.db.marketingDelivery.count({ where: { campaignId: c.id, isTest: false, state: { notIn: [...TERMINAL, 'ACCEPTED'] } } }))
      await this.db.$transaction(async tx => { await tx.marketingCampaign.update({ where: { id: c.id }, data: { status: 'COMPLETED', completedAt: new Date(), version: { increment: 1 } } }); await systemEvent(tx, c.workspaceId, 'MARKETING_CAMPAIGN', c.id, 'CAMPAIGN_COMPLETED', {}); });
    return { processed };
  }

  async deliveries(actor: Principal, campaignId: string, raw: unknown) {
    const q = parse(listQuery.extend({ state: z.string().optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      await loadCampaign(tx, actor, parse(uuid, campaignId), 'marketing.campaign.read');
      const where = { workspaceId: actor.workspaceId, campaignId, ...(q.state ? { state: q.state } : {}) };
      const [rows, total] = await Promise.all([tx.marketingDelivery.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit,
        select: { id: true, recipientKey: true, channel: true, variantId: true, state: true, attemptCount: true, lastErrorCode: true, sentAt: true, isTest: true } }), tx.marketingDelivery.count({ where })]);
      return paged(rows, total, q.page, q.limit);
    });
  }
  async logs(actor: Principal, deliveryId: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const row = await tx.marketingDelivery.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, deliveryId) } });
      if (!row) throw notFound('Delivery');
      await loadCampaign(tx, actor, row.campaignId, 'marketing.campaign.read');
      const [attempts, events] = await Promise.all([tx.marketingDeliveryAttempt.findMany({ where: { deliveryId: row.id }, orderBy: { attemptNo: 'asc' } }), tx.marketingProviderEvent.findMany({ where: { deliveryId: row.id }, orderBy: { occurredAt: 'asc' } })]);
      return { delivery: { id: row.id, state: row.state, attemptCount: row.attemptCount, lastErrorCode: row.lastErrorCode }, attempts, providerEvents: events };
    });
  }
  async retryFailed(actor: Principal, campaignId: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.delivery.retry');
      const c = await loadCampaign(tx, actor, parse(uuid, campaignId), 'marketing.campaign.read');
      if (!['RUNNING', 'COMPLETED'].includes(c.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Campaign is not active.', 409);
      // Permanent errors (opt-out, complaint, invalid address) are never retried.
      const result = await tx.marketingDelivery.updateMany({ where: { workspaceId: actor.workspaceId, campaignId, state: 'FAILED', attemptCount: { lt: MAX_ATTEMPTS * 2 }, lastErrorCode: { in: ['PROVIDER_UNAVAILABLE', 'PROVIDER_QUOTA', 'PROVIDER_TIMEOUT'] } }, data: { state: 'QUEUED', nextAttemptAt: new Date() } });
      if (result.count && c.status === 'COMPLETED') await tx.marketingCampaign.update({ where: { id: campaignId }, data: { status: 'RUNNING', version: { increment: 1 } } });
      await evidence(tx, actor, 'MARKETING_CAMPAIGN', campaignId, 'DELIVERY_RETRY_REQUESTED', { count: result.count });
      return { requeued: result.count };
    });
  }

  /** Verified provider webhook: (connectionId, providerEventId) dedupe; statuses never regress terminal states. */
  async webhook(provider: string, headers: Headers, rawBody: string) {
    const connectionId = headers.get('x-connection-id') ?? '';
    if (!uuid.safeParse(connectionId).success) throw new AppError('UNAUTHENTICATED', 'Provider event proof is invalid.', 401);
    checkRateLimit(connectionId, { scope: 'marketing.provider-webhook', limit: 6000, windowMs: 60000 });
    const connection = await this.db.marketingProviderConnection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.provider !== provider.toUpperCase() || !connection.webhookSecretRef) throw new AppError('UNAUTHENTICATED', 'Provider event proof is invalid.', 401);
    let secret: string; try { secret = resolveSecret(connection.webhookSecretRef); } catch { throw new AppError('UNAUTHENTICATED', 'Provider event proof is invalid.', 401); }
    if (!marketingSender(connection.provider, connection.channel as Channel).verifyWebhook(headers, rawBody, secret)) throw new AppError('UNAUTHENTICATED', 'Provider event signature is invalid.', 401);
    const event = parse(z.object({ eventId: z.string().min(1).max(200), messageId: z.string().max(200).optional(), deliveryId: uuid.optional(), status: z.enum(['DELIVERED', 'BOUNCED', 'SOFT_BOUNCED', 'COMPLAINED', 'FAILED', 'OPENED', 'CLICKED', 'REPLIED']), occurredAt: z.iso.datetime({ offset: true }), url: z.string().max(2000).optional(), botSuspected: z.boolean().optional() }), JSON.parse(rawBody));
    return this.db.$transaction(async tx => {
      await lock(tx, connection.workspaceId, 'marketing:provider-event:' + connectionId + ':' + event.eventId);
      if (await tx.marketingProviderEvent.findUnique({ where: { connectionId_providerEventId: { connectionId, providerEventId: event.eventId } } })) return { accepted: true, duplicate: true };
      const delivery = await tx.marketingDelivery.findFirst({ where: { workspaceId: connection.workspaceId, providerConnectionId: connectionId, ...(event.deliveryId ? { id: event.deliveryId } : { providerMessageId: event.messageId ?? '__none__' }) } });
      await tx.marketingProviderEvent.create({ data: { workspaceId: connection.workspaceId, connectionId, providerEventId: event.eventId, deliveryId: delivery?.id, status: event.status, occurredAt: new Date(event.occurredAt) } });
      if (!delivery) return { accepted: true, matched: false };
      const occurredAt = new Date(event.occurredAt);
      if (['DELIVERED', 'BOUNCED', 'FAILED'].includes(event.status)) {
        const next = event.status;
        if ((ORDER[next] ?? 0) > (ORDER[delivery.state] ?? 0) || delivery.state === 'ACCEPTED' || delivery.state === 'SENDING') {
          await tx.marketingDelivery.update({ where: { id: delivery.id }, data: { state: next, sentAt: delivery.sentAt ?? occurredAt } });
          await systemEvent(tx, delivery.workspaceId, 'MARKETING_DELIVERY', delivery.id, 'DELIVERY_STATUS_CHANGED', { campaignId: delivery.campaignId, state: next }, false);
        }
        if (next === 'BOUNCED') await tx.marketingSuppression.create({ data: { workspaceId: delivery.workspaceId, destinationHash: delivery.destinationHash, channel: delivery.channel, reason: 'HARD_BOUNCE' } });
      }
      if (event.status === 'COMPLAINED') {
        await tx.marketingSuppression.create({ data: { workspaceId: delivery.workspaceId, destinationHash: delivery.destinationHash, channel: 'ALL', reason: 'COMPLAINT' } });
        await MarketingConsentService.cancelPending(tx, delivery.workspaceId, delivery.destinationHash, 'ALL');
        await systemEvent(tx, delivery.workspaceId, 'MARKETING_SUPPRESSION', delivery.id, 'RECIPIENT_SUPPRESSED', { reason: 'COMPLAINT' });
      }
      const engagement = { OPENED: 'OPEN', CLICKED: 'CLICK', REPLIED: 'REPLY', COMPLAINED: 'COMPLAINT', BOUNCED: 'BOUNCE' }[event.status as string];
      if (engagement && !delivery.isTest) {
        const uniqueKey = sha256([delivery.id, engagement, engagement === 'CLICK' ? event.url ?? '' : ''].join('|'));
        const first = !await tx.marketingEngagementEvent.findUnique({ where: { uniqueKey } });
        await tx.marketingEngagementEvent.create({ data: { workspaceId: delivery.workspaceId, campaignId: delivery.campaignId, deliveryId: delivery.id, recipientKey: delivery.recipientKey, providerEventId: event.eventId, type: engagement, occurredAt,
          source: 'PROVIDER', confidence: engagement === 'OPEN' ? 'ESTIMATED' : 'REPORTED', uniqueKey: first ? uniqueKey : sha256(uniqueKey + ':' + event.eventId), isUnique: first, suspectedBot: Boolean(event.botSuspected) } });
      }
      return { accepted: true, matched: true };
    });
  }
}
