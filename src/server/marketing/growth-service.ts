import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError, isAppError } from '../errors';
import { decimal, parse, uuid } from '../process-platform/dto';
import { evidence, lock, requirePermission, resolvePrincipal, type Principal } from '../process-platform/context';
import { checkRateLimit } from '../rate-limit';
import { allocate, assertAllocation, decrypt, inTx, newToken, notFound, safeUrl, sha256, systemEvent } from '../suite/kernel';
import { adAudienceAdapter } from '../suite/providers';
import { WorkflowExecutionService } from '../workflows/execution-service';
import { eligibility, loadCampaign, loadSegment, resolveSegment } from './support';

/** Engagement/metrics (08), experiments & journeys (09), ad audiences & repeat sales (10). */
export class MarketingGrowthService {
  constructor(private readonly db: PrismaClient, readonly workflows = new WorkflowExecutionService(db)) {}

  // ------------------------------------------------------------------ engagement
  async metrics(actor: Principal, campaignId: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.analytics.read');
      const c = await loadCampaign(tx, actor, parse(uuid, campaignId), 'marketing.campaign.read');
      const snapshot = c.audienceSnapshotId ? await tx.marketingAudienceSnapshot.findUnique({ where: { id: c.audienceSnapshotId } }) : null;
      const eligibilityGroups = c.audienceSnapshotId ? await tx.marketingAudienceRecipient.groupBy({ by: ['eligibilityState'], where: { snapshotId: c.audienceSnapshotId }, _count: { _all: true } }) : [];
      const states = await tx.marketingDelivery.groupBy({ by: ['state'], where: { campaignId, isTest: false }, _count: { _all: true } });
      const engagement = await tx.marketingEngagementEvent.groupBy({ by: ['type', 'isUnique', 'suspectedBot'], where: { campaignId }, _count: { _all: true } });
      const count = (type: string, unique?: boolean) => engagement.filter(e => e.type === type && !e.suspectedBot && (unique === undefined || e.isUnique === unique)).reduce((s, e) => s + e._count._all, 0);
      const byState = Object.fromEntries(states.map(s => [s.state, s._count._all]));
      const eligible = eligibilityGroups.find(g => g.eligibilityState === 'ELIGIBLE')?._count._all ?? 0, targeted = snapshot?.targetCount ?? 0;
      const attempted = ['ACCEPTED', 'DELIVERED', 'BOUNCED', 'FAILED', 'SENDING'].reduce((s, k) => s + (byState[k] ?? 0), 0);
      const skippedAtSend = (byState.SUPPRESSED ?? 0) + (byState.CANCELLED ?? 0), pending = (byState.QUEUED ?? 0) + (byState.DEFERRED ?? 0) + (byState.FAILED_RETRYABLE ?? 0);
      return { campaignId, channel: c.channel, targeted, eligible, ineligible: targeted - eligible, ineligibleByReason: Object.fromEntries(eligibilityGroups.filter(g => g.eligibilityState !== 'ELIGIBLE').map(g => [g.eligibilityState, g._count._all])),
        attempted, skippedAtSend, pending, accepted: (byState.ACCEPTED ?? 0) + (byState.DELIVERED ?? 0), delivered: byState.DELIVERED ?? 0, bounced: byState.BOUNCED ?? 0, failed: byState.FAILED ?? 0,
        opened: { unique: count('OPEN', true), total: count('OPEN'), confidence: 'ESTIMATED — privacy features make opens an imprecise signal, not proof of reading' },
        clicked: { unique: count('CLICK', true), total: count('CLICK') }, replied: count('REPLY'), converted: count('CONVERSION'),
        reconciliation: { targetedEqualsEligiblePlusIneligible: targeted === eligible + (targeted - eligible), eligibleEqualsAttemptedPlusSkippedPlusPending: eligible === attempted + skippedAtSend + pending },
        basis: { timezone: 'UTC', attributionOwner: 'SALES_INTELLIGENCE', freshness: 'LIVE_FROM_LEDGER', generatedAt: new Date() } };
    });
  }
  async events(actor: Principal, campaignId: string, raw: unknown) {
    const q = parse(z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).passthrough(), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.analytics.read');
      await loadCampaign(tx, actor, parse(uuid, campaignId), 'marketing.campaign.read');
      const rows = await tx.marketingEngagementEvent.findMany({ where: { workspaceId: actor.workspaceId, campaignId, ...(q.cursor ? { id: { gt: q.cursor } } : {}) }, orderBy: { id: 'asc' }, take: q.limit,
        select: { id: true, type: true, occurredAt: true, source: true, confidence: true, isUnique: true, suspectedBot: true } });
      return { data: rows, meta: { nextCursor: rows.length === q.limit ? rows[rows.length - 1].id : null } };
    });
  }
  async createTrackingLink(actor: Principal, campaignId: string, raw: unknown) {
    const input = parse(z.strictObject({ destinationUrl: z.url().max(2000), consentCategory: z.enum(['ANALYTICS', 'MARKETING']).default('MARKETING'), variantId: z.string().max(64).default('') }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      const c = await loadCampaign(tx, actor, parse(uuid, campaignId), 'marketing.campaign.edit');
      const url = safeUrl(input.destinationUrl, false), token = newToken('trk_');
      const row = await tx.marketingTrackingLink.create({ data: { workspaceId: actor.workspaceId, campaignId: c.id, variantId: input.variantId, destinationUrl: url, tokenHash: sha256(token), consentCategory: input.consentCategory } });
      return { id: row.id, token, trackingPath: '/api/v1/public/marketing/track/' + token };
    });
  }
  /** Controlled redirect: only pre-registered, validated destinations (no open redirect); click counted once per recipient. */
  async track(token: string, query: Record<string, string>, client: string, userAgent: string) {
    checkRateLimit(client, { scope: 'marketing.track', limit: 300, windowMs: 60000 });
    return this.db.$transaction(async tx => {
      const link = await tx.marketingTrackingLink.findUnique({ where: { tokenHash: sha256(token) } });
      if (!link) throw notFound('Link');
      const recipientKey = typeof query.r === 'string' && /^[a-f0-9]{64}$/.test(query.r) ? query.r : null;
      const bot = /bot|crawler|spider|preview|scanner|safelinks|proofpoint|mimecast/i.test(userAgent);
      if (recipientKey && query.consent !== 'denied') {
        const uniqueKey = sha256(['click', link.id, recipientKey].join('|')), first = !await tx.marketingEngagementEvent.findUnique({ where: { uniqueKey } });
        await tx.marketingEngagementEvent.create({ data: { workspaceId: link.workspaceId, campaignId: link.campaignId, recipientKey, type: 'CLICK', occurredAt: new Date(), source: 'TRACKING_LINK', confidence: 'REPORTED',
          uniqueKey: first ? uniqueKey : sha256(uniqueKey + ':' + Date.now() + Math.random()), isUnique: first, suspectedBot: bot } });
      }
      return { redirectTo: link.destinationUrl };
    });
  }
  /** Conversion facts are imported from Sales Intelligence attribution (owner); Marketing never computes revenue attribution. */
  async importConversion(actor: Principal, campaignId: string, raw: unknown) {
    const input = parse(z.strictObject({ recipientKey: z.string().regex(/^[a-f0-9]{64}$/), externalReference: z.string().min(1).max(200), amount: decimal, currency: z.string().regex(/^[A-Z]{3}$/), attributionModel: z.string().min(1).max(60), modelVersion: z.string().min(1).max(40), occurredAt: z.iso.datetime({ offset: true }) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.analytics.export');
      const c = await loadCampaign(tx, actor, parse(uuid, campaignId), 'marketing.campaign.read');
      const uniqueKey = sha256(['conversion', c.id, input.externalReference].join('|'));
      if (await tx.marketingEngagementEvent.findUnique({ where: { uniqueKey } })) return { duplicate: true };
      await tx.marketingEngagementEvent.create({ data: { workspaceId: actor.workspaceId, campaignId: c.id, recipientKey: input.recipientKey, type: 'CONVERSION', occurredAt: new Date(input.occurredAt), source: 'SALES_INTELLIGENCE:' + input.attributionModel + '@' + input.modelVersion, confidence: 'ATTRIBUTED', uniqueKey } });
      await evidence(tx, actor, 'MARKETING_CAMPAIGN', c.id, 'CAMPAIGN_CONVERSION_ATTRIBUTED', { model: input.attributionModel, modelVersion: input.modelVersion, currency: input.currency, amount: input.amount });
      return { recorded: true };
    });
  }
  async conversionsReport(actor: Principal, raw: unknown) {
    const q = parse(z.object({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() }).passthrough(), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.analytics.read');
      const range = { gte: q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400000), lt: q.to ? new Date(q.to) : new Date() };
      const rows = await tx.marketingEngagementEvent.groupBy({ by: ['campaignId', 'source'], where: { workspaceId: actor.workspaceId, type: 'CONVERSION', occurredAt: range }, _count: { _all: true } });
      const visible = []; for (const r of rows) try { await loadCampaign(tx, actor, r.campaignId, 'marketing.campaign.read'); visible.push({ campaignId: r.campaignId, attribution: r.source, conversions: r._count._all }); } catch { /* scope */ }
      return { basis: { from: range.gte, to: range.lt, timezone: 'UTC', owner: 'SALES_INTELLIGENCE' }, data: visible };
    });
  }

  // ------------------------------------------------------------------ experiments
  async createExperiment(actor: Principal, campaignId: string, raw: unknown) {
    const input = parse(z.strictObject({ metric: z.enum(['OPEN', 'CLICK', 'CONVERSION', 'REPLY']), minSample: z.number().int().min(10).max(10000000), seed: z.string().min(4).max(64).optional(),
      variants: z.array(z.strictObject({ label: z.string().regex(/^[A-Z][A-Z0-9_]{0,15}$/), templateVersionId: uuid, percentage: z.number().min(0.01).max(100) })).min(2).max(10) }), raw);
    assertAllocation(input.variants.map(v => v.percentage));
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.experiment.manage');
      const c = await loadCampaign(tx, actor, parse(uuid, campaignId), 'marketing.campaign.edit');
      if (!['DRAFT', 'IN_REVIEW', 'APPROVED'].includes(c.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Experiments are defined before launch.', 409);
      for (const v of input.variants) {
        const version = await tx.marketingTemplateVersion.findFirst({ where: { workspaceId: actor.workspaceId, id: v.templateVersionId, status: 'APPROVED' } });
        if (!version) throw new AppError('INVALID_STATE_TRANSITION', 'Every variant must use an approved template version.', 409);
      }
      if (await tx.marketingExperiment.findUnique({ where: { campaignId } })) throw new AppError('INVALID_STATE_TRANSITION', 'Campaign already has an experiment.', 409);
      const experiment = await tx.marketingExperiment.create({ data: { workspaceId: actor.workspaceId, campaignId, metric: input.metric, minSample: input.minSample, seed: input.seed ?? newToken().slice(0, 16) } });
      for (const v of input.variants) await tx.marketingVariant.create({ data: { workspaceId: actor.workspaceId, experimentId: experiment.id, label: v.label, templateVersionId: v.templateVersionId, percentage: v.percentage } });
      // Variants are campaign content: adding them is a material change requiring (re)approval.
      if (c.status !== 'DRAFT') await tx.marketingCampaign.update({ where: { id: c.id }, data: { status: 'DRAFT', approvedRevision: null, revision: { increment: 1 }, version: { increment: 1 } } });
      await evidence(tx, actor, 'MARKETING_CAMPAIGN', campaignId, 'EXPERIMENT_CREATED', { experimentId: experiment.id, variants: input.variants.length });
      return { ...experiment, variants: input.variants };
    });
  }
  async experimentResults(actor: Principal, campaignId: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.analytics.read');
      await loadCampaign(tx, actor, parse(uuid, campaignId), 'marketing.campaign.read');
      const experiment = await tx.marketingExperiment.findUnique({ where: { campaignId } });
      if (!experiment) throw notFound('Experiment');
      const variants = await tx.marketingVariant.findMany({ where: { experimentId: experiment.id } });
      const results = [];
      for (const v of variants) {
        const deliveries = await tx.marketingDelivery.findMany({ where: { campaignId, variantId: v.id, isTest: false }, select: { recipientKey: true, state: true } });
        const keys = deliveries.map(d => d.recipientKey);
        const hits = await tx.marketingEngagementEvent.count({ where: { campaignId, type: experiment.metric, isUnique: true, suspectedBot: false, recipientKey: { in: keys } } });
        results.push({ variantId: v.id, label: v.label, allocation: Number(v.percentage), assigned: deliveries.length, conversions: hits, rate: deliveries.length ? hits / deliveries.length : 0, sampleReached: deliveries.length >= experiment.minSample });
      }
      return { experimentId: experiment.id, status: experiment.status, metric: experiment.metric, minSample: experiment.minSample, winningVariantId: experiment.winningVariantId, results };
    });
  }
  /** Winner selection is a human decision; the winning version must still pass approval gates for future sends. */
  async selectWinner(actor: Principal, campaignId: string, raw: unknown) {
    const input = parse(z.strictObject({ variantId: uuid, reason: z.string().trim().min(1).max(500) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.experiment.manage'); requirePermission(actor, 'marketing.campaign.approve');
      await loadCampaign(tx, actor, parse(uuid, campaignId), 'marketing.campaign.read');
      const experiment = await tx.marketingExperiment.findUnique({ where: { campaignId } });
      if (!experiment || experiment.status !== 'RUNNING') throw new AppError('INVALID_STATE_TRANSITION', 'Experiment is not running.', 409);
      const variant = await tx.marketingVariant.findFirst({ where: { experimentId: experiment.id, id: input.variantId } });
      if (!variant) throw notFound('Variant');
      const version = await tx.marketingTemplateVersion.findFirst({ where: { id: variant.templateVersionId, status: 'APPROVED' } });
      if (!version) throw new AppError('INVALID_STATE_TRANSITION', 'Winning content must be approved.', 409);
      const updated = await tx.marketingExperiment.update({ where: { id: experiment.id }, data: { status: 'COMPLETED', winningVariantId: variant.id, version: { increment: 1 } } });
      await evidence(tx, actor, 'MARKETING_CAMPAIGN', campaignId, 'EXPERIMENT_WINNER_SELECTED', { variantId: variant.id, reason: input.reason });
      return updated;
    });
  }
  static assignment(seed: string, recipientKey: string, variants: { id: string; percentage: number }[]) { return allocate(variants.map(v => ({ ...v, percent: v.percentage })), seed, recipientKey).id; }

  // ------------------------------------------------------------------ journeys (Workflow engine)
  async createJourney(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ name: z.string().trim().min(1).max(160), workflowDefinitionId: uuid, reentryPolicy: z.enum(['PROHIBIT_ACTIVE', 'ALLOW']).default('PROHIBIT_ACTIVE') }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.journey.manage'); requirePermission(actor, 'WORKFLOW.PUBLISH');
      const definition = await this.workflows.definitions.definition(tx, actor, input.workflowDefinitionId, 'WORKFLOW.VIEW');
      if (definition.status !== 'ACTIVE' || !definition.currentVersionId) throw new AppError('INVALID_STATE_TRANSITION', 'Journey requires a published Workflow version.', 409);
      if (definition.boundEntityType !== 'CONTACT') throw new AppError('VALIDATION_FAILED', 'Marketing journeys run on CONTACT-bound Workflows.', 400);
      const row = await tx.marketingJourney.create({ data: { workspaceId: actor.workspaceId, name: input.name, workflowDefinitionId: definition.id, workflowVersionId: definition.currentVersionId, reentryPolicy: input.reentryPolicy, status: 'ACTIVE', createdByUserId: actor.userId } });
      await evidence(tx, actor, 'MARKETING_JOURNEY', row.id, 'JOURNEY_CREATED', { workflowVersionId: row.workflowVersionId });
      return row;
    });
  }
  /** Enrollment starts the shared Workflow runtime (pinned version). Engine failure leaves the enrollment FAILED, never "successful". */
  async enroll(actor: Principal, journeyId: string, raw: unknown, key: string | null) {
    const input = parse(z.strictObject({ contactId: uuid, sourceEventId: z.string().max(200).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.journey.manage');
      await lock(tx, actor.workspaceId, 'marketing:journey:' + journeyId + ':' + input.contactId);
      const journey = await tx.marketingJourney.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, journeyId) } });
      if (!journey) throw notFound('Journey');
      if (journey.status !== 'ACTIVE') throw new AppError('INVALID_STATE_TRANSITION', 'Journey is not active.', 409);
      const subjectKey = 'CONTACT:' + input.contactId;
      if (journey.reentryPolicy === 'PROHIBIT_ACTIVE' && await tx.marketingJourneyEnrollment.findFirst({ where: { journeyId, subjectKey, status: { in: ['PENDING', 'ACTIVE'] } } }))
        throw new AppError('INVALID_STATE_TRANSITION', 'Subject already has an active enrollment.', 409);
      const enrollment = await tx.marketingJourneyEnrollment.create({ data: { workspaceId: actor.workspaceId, journeyId, subjectKey, subjectType: 'CONTACT', subjectId: input.contactId, sourceEventId: input.sourceEventId } });
      try {
        const started = await this.workflows.startInTransaction(tx, actor, journey.workflowDefinitionId, { entityType: 'CONTACT', entityId: input.contactId, parameters: {} }, key ?? 'journey:' + enrollment.id) as { executionId: string };
        await tx.marketingJourneyEnrollment.update({ where: { id: enrollment.id }, data: { status: 'ACTIVE', workflowExecutionId: started.executionId } });
        await evidence(tx, actor, 'MARKETING_JOURNEY', journeyId, 'JOURNEY_ENROLLED', { enrollmentId: enrollment.id, executionId: started.executionId });
        return { enrollmentId: enrollment.id, status: 'ACTIVE', workflowExecutionId: started.executionId };
      } catch (error) {
        if (!isAppError(error)) throw error;
        if (['PERMISSION_DENIED', 'INVALID_ARGUMENT'].includes(error.code)) throw error;
        throw new AppError('DEPENDENCY_UNAVAILABLE', 'Workflow engine could not start the journey; enrollment was not completed.', 503, { cause: error.code });
      }
    });
  }
  async pauseJourney(actor: Principal, journeyId: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.journey.manage');
      const journey = await tx.marketingJourney.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, journeyId) } });
      if (!journey) throw notFound('Journey');
      const updated = await tx.marketingJourney.update({ where: { id: journey.id }, data: { status: journey.status === 'PAUSED' ? 'ACTIVE' : 'PAUSED', version: { increment: 1 } } });
      await evidence(tx, actor, 'MARKETING_JOURNEY', journeyId, updated.status === 'PAUSED' ? 'JOURNEY_PAUSED' : 'JOURNEY_RESUMED', {});
      return updated;
    });
  }

  // ------------------------------------------------------------------ advertising
  async adConnection(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ platform: z.enum(['META', 'GOOGLE']), credentialSecretRef: z.string().regex(/^env:[A-Z][A-Z0-9_]{1,80}$/), externalAccountId: z.string().min(1).max(64), sandbox: z.boolean().default(false) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.ads.manage');
      const row = await tx.marketingAdConnection.create({ data: { workspaceId: actor.workspaceId, ...input, credentialMask: input.credentialSecretRef.slice(0, 7) + '***' } });
      await evidence(tx, actor, 'MARKETING_AD_CONNECTION', row.id, 'AD_CONNECTION_CREATED', { platform: row.platform, sandbox: row.sandbox });
      const { credentialSecretRef: _s, ...safe } = row; void _s; return safe;
    });
  }
  async adAudience(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ connectionId: uuid, segmentId: uuid }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.ads.manage');
      const connection = await tx.marketingAdConnection.findFirst({ where: { workspaceId: actor.workspaceId, id: input.connectionId } });
      if (!connection) throw notFound('Ad connection');
      const segment = await loadSegment(tx, actor, input.segmentId, 'marketing.segment.read');
      if (segment.channel !== 'EMAIL') throw new AppError('VALIDATION_FAILED', 'Customer-match audiences use hashed email identifiers.', 400);
      return tx.marketingAdAudience.create({ data: { workspaceId: actor.workspaceId, connectionId: connection.id, segmentId: segment.id, platform: connection.platform } });
    });
  }
  async requestSync(actor: Principal, audienceId: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.ads.manage');
      const audience = await tx.marketingAdAudience.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, audienceId) } });
      if (!audience) throw notFound('Ad audience');
      const segment = await loadSegment(tx, actor, audience.segmentId, 'marketing.segment.read');
      const job = await tx.marketingAdSyncJob.create({ data: { workspaceId: actor.workspaceId, audienceId: audience.id, sourceRevision: segment.revision } });
      await tx.marketingAdAudience.update({ where: { id: audience.id }, data: { syncState: 'PENDING' } });
      await evidence(tx, actor, 'MARKETING_AD_AUDIENCE', audience.id, 'AD_AUDIENCE_SYNC_REQUESTED', { jobId: job.id });
      return job;
    });
  }
  async audienceStatus(actor: Principal, audienceId: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.ads.manage');
      const audience = await tx.marketingAdAudience.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, audienceId) } });
      if (!audience) throw notFound('Ad audience');
      const jobs = await tx.marketingAdSyncJob.findMany({ where: { audienceId: audience.id }, orderBy: { createdAt: 'desc' }, take: 10 });
      return { id: audience.id, platform: audience.platform, externalAudienceId: audience.externalAudienceId, syncState: audience.syncState, lastSyncAt: audience.lastSyncAt, syncedCount: (audience.syncedHashes as string[]).length, jobs };
    });
  }
  /** Worker: uploads only subjects with ADVERTISING consent and no suppression; withdrawn subjects are removed. Quota errors retry. */
  async tickAdSync(limit = 5) {
    const jobs = await this.db.marketingAdSyncJob.findMany({ where: { status: { in: ['PENDING', 'PARTIAL'] }, nextAttemptAt: { lte: new Date() } }, take: limit, orderBy: { createdAt: 'asc' } });
    for (const job of jobs) {
      const audience = await this.db.marketingAdAudience.findUniqueOrThrow({ where: { id: job.audienceId } });
      const connection = await this.db.marketingAdConnection.findUniqueOrThrow({ where: { id: audience.connectionId } });
      const segment = await this.db.marketingSegment.findUniqueOrThrow({ where: { id: audience.segmentId } });
      try {
        const desired = await this.db.$transaction(async tx => {
          const owner = await resolvePrincipal(tx, segment.workspaceId, segment.ownerUserId);
          const members = await resolveSegment(tx, owner, segment), out: string[] = [];
          for (const [hash, member] of members) if (await eligibility(tx, segment.workspaceId, { destinationHash: hash, channel: 'EMAIL', purpose: 'ADVERTISING', jurisdiction: 'DEFAULT' }) === 'ELIGIBLE')
            out.push(sha256(member.destination.trim().toLowerCase())); // provider-required SHA-256 of normalized email
          return out;
        }, { timeout: 120000 });
        const previous = new Set(audience.syncedHashes as string[]), next = new Set(desired);
        const add = desired.filter(h => !previous.has(h)), remove = [...previous].filter(h => !next.has(h));
        const result = await adAudienceAdapter(connection.platform as 'META' | 'GOOGLE', connection.sandbox).upsertAudience({ workspaceId: connection.workspaceId, connectionId: connection.id, correlationId: job.id, idempotencyKey: job.id, secretRef: connection.credentialSecretRef },
          { externalId: audience.externalAudienceId, name: 'TrueCRM ' + segment.name, addHashes: add, removeHashes: remove });
        await this.db.$transaction(async tx => {
          await tx.marketingAdAudience.update({ where: { id: audience.id }, data: { externalAudienceId: result.externalId, syncedHashes: desired, lastSyncAt: new Date(), syncState: result.partial ? 'PARTIAL' : 'COMPLETED', version: { increment: 1 } } });
          await tx.marketingAdSyncJob.update({ where: { id: job.id }, data: { status: result.partial ? 'PARTIAL' : 'COMPLETED', addedCount: add.length, removedCount: remove.length, rejectedCount: result.rejectedCount, attempts: { increment: 1 }, completedAt: new Date() } });
          await systemEvent(tx, job.workspaceId, 'MARKETING_AD_AUDIENCE', audience.id, 'AD_AUDIENCE_SYNCED', { added: add.length, removed: remove.length });
        });
      } catch (error) {
        const code = isAppError(error) ? error.code : 'AD_SYNC_FAILED', retry = job.attempts < 5;
        await this.db.$transaction(async tx => {
          await tx.marketingAdSyncJob.update({ where: { id: job.id }, data: { status: retry ? 'PARTIAL' : 'FAILED', errorCode: code, attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + Math.min(3600000, 60000 * 2 ** job.attempts)) } });
          await tx.marketingAdAudience.update({ where: { id: audience.id }, data: { syncState: retry ? 'PARTIAL' : 'FAILED' } });
        });
      }
    }
    return { processed: jobs.length };
  }
  async importMetrics(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ connectionId: uuid, from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      rows: z.array(z.strictObject({ externalCampaignId: z.string().min(1).max(64), currency: z.string().regex(/^[A-Z]{3}$/), spend: decimal, impressions: z.number().int().min(0), clicks: z.number().int().min(0) })).max(5000).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.ads.manage');
      const connection = await tx.marketingAdConnection.findFirst({ where: { workspaceId: actor.workspaceId, id: input.connectionId } });
      if (!connection) throw notFound('Ad connection');
      const rows = input.rows ?? (await adAudienceAdapter(connection.platform as 'META' | 'GOOGLE', connection.sandbox).pullMetrics({ workspaceId: actor.workspaceId, connectionId: connection.id, correlationId: connection.id, idempotencyKey: input.from + input.to, secretRef: connection.credentialSecretRef }, { from: input.from, to: input.to }))
        .map(r => ({ externalCampaignId: r.campaignId, currency: r.currency, spend: r.spend, impressions: r.impressions, clicks: r.clicks }));
      let imported = 0, duplicates = 0;
      for (const row of rows) {
        const checksum = sha256(JSON.stringify(row));
        const key = { workspaceId: actor.workspaceId, platform: connection.platform, externalCampaignId: row.externalCampaignId, periodFrom: new Date(input.from + 'T00:00:00Z'), periodTo: new Date(input.to + 'T00:00:00Z'), checksum };
        if (await tx.marketingAdMetricImport.findUnique({ where: { workspaceId_platform_externalCampaignId_periodFrom_periodTo_checksum: key } })) { duplicates++; continue; }
        await tx.marketingAdMetricImport.create({ data: { ...key, connectionId: connection.id, currency: row.currency, spend: row.spend, impressions: row.impressions, clicks: row.clicks } });
        imported++;
      }
      await evidence(tx, actor, 'MARKETING_AD_CONNECTION', connection.id, 'AD_METRICS_IMPORTED', { imported, duplicates, from: input.from, to: input.to });
      return { imported, duplicates, attributionOwner: 'SALES_INTELLIGENCE' };
    });
  }
  async repeatSaleRule(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ triggerEvent: z.enum(['ORDER_COMPLETED', 'ORDER_PAID', 'DEAL_WON']), segmentId: uuid, journeyId: uuid }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.journey.manage');
      await loadSegment(tx, actor, input.segmentId, 'marketing.segment.read');
      if (!await tx.marketingJourney.findFirst({ where: { workspaceId: actor.workspaceId, id: input.journeyId, status: 'ACTIVE' } })) throw notFound('Journey');
      const row = await tx.marketingRepeatSaleRule.create({ data: { workspaceId: actor.workspaceId, ...input } });
      await evidence(tx, actor, 'MARKETING_REPEAT_SALE', row.id, 'REPEAT_SALE_RULE_CREATED', { triggerEvent: row.triggerEvent });
      return row;
    });
  }
  /** Consumes durable Commerce/CRM outbox events and enrolls matching contacts (dedupe by source event id). */
  async tickRepeatSales(limit = 50) {
    const rules = await this.db.marketingRepeatSaleRule.findMany({ where: { status: 'ACTIVE' } });
    let triggered = 0;
    for (const rule of rules) {
      const events = await this.db.outboxEvent.findMany({ where: { workspaceId: rule.workspaceId, eventType: rule.triggerEvent, occurredAt: { gte: rule.createdAt } }, orderBy: { occurredAt: 'asc' }, take: limit });
      for (const event of events) {
        if (await this.db.marketingJourneyEnrollment.findFirst({ where: { journeyId: rule.journeyId, sourceEventId: event.id } })) continue;
        const contactId = event.entityType === 'CONTACT' ? event.entityId : (await this.db.commerceCrmBinding.findFirst({ where: { workspaceId: rule.workspaceId, orderId: event.entityId, entityType: 'CONTACT' } }))?.targetId;
        if (!contactId) continue;
        const journey = await this.db.marketingJourney.findUniqueOrThrow({ where: { id: rule.journeyId } });
        try {
          const owner = await this.db.$transaction(tx => resolvePrincipal(tx, rule.workspaceId, journey.createdByUserId));
          const inSegment = await this.db.$transaction(async tx => [...(await resolveSegment(tx, owner, await tx.marketingSegment.findUniqueOrThrow({ where: { id: rule.segmentId } }))).values()].some(m => m.ref === 'CONTACT:' + contactId), { timeout: 120000 });
          if (!inSegment) continue;
          await this.enroll(owner, journey.id, { contactId, sourceEventId: event.id }, 'repeat:' + event.id);
          await this.db.$transaction(tx => systemEvent(tx, rule.workspaceId, 'MARKETING_REPEAT_SALE', rule.id, 'REPEAT_SALE_JOURNEY_TRIGGERED', { sourceEventId: event.id }, false));
          triggered++;
        } catch { /* duplicate active enrollment or engine outage: retried on next tick */ }
      }
    }
    return { triggered };
  }
  static decryptForTest = decrypt;
}
