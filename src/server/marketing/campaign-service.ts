import type { MarketingCampaign, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { parse, uuid } from '../process-platform/dto';
import { command, evidence, lock, requirePermission, type Principal, type Tx } from '../process-platform/context';
import { assertVersion, encrypt, entitled, expectedVersion, ianaZone, inTx, listQuery, notFound, paged, sha256, transition, zonedInstant } from '../suite/kernel';
import { recordProviderCall, marketingSender } from '../suite/providers';
import { channel, eligibility, loadCampaign, loadSegment, resolveSegment, destinationOf, type Channel } from './support';
import { render, templateVariables } from './channel-service';

const machine: Record<string, readonly string[]> = { DRAFT: ['IN_REVIEW', 'APPROVED', 'CANCELLED'], IN_REVIEW: ['APPROVED', 'DRAFT', 'CANCELLED'], APPROVED: ['SCHEDULED', 'RUNNING', 'DRAFT', 'CANCELLED'],
  SCHEDULED: ['RUNNING', 'PAUSED', 'CANCELLED', 'DRAFT'], RUNNING: ['PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED'], PAUSED: ['RUNNING', 'SCHEDULED', 'CANCELLED'], COMPLETED: [], CANCELLED: [], FAILED: [] };
const MATERIAL = ['channel', 'segmentId', 'senderIdentityId', 'templateVersionId', 'purpose', 'jurisdiction'] as const;
type ApprovalPolicy = { alwaysRequired?: boolean; recipientThreshold?: number; highRiskChannels?: string[]; separationOfDuties?: boolean };

/** Campaign lifecycle, approvals, scheduling, snapshot freeze and launch (specs Marketing/01, 05, 06). */
export class MarketingCampaignService {
  constructor(private readonly db: PrismaClient) {}
  private contentHash(c: Pick<MarketingCampaign, typeof MATERIAL[number]>) { return sha256(JSON.stringify(MATERIAL.map(k => c[k] ?? null))); }

  async create(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ name: z.string().trim().min(1).max(160), channel, segmentId: uuid, senderIdentityId: uuid.optional(), templateVersionId: uuid.optional(), purpose: z.enum(['MARKETING', 'NEWSLETTER', 'PROMOTIONAL']).default('MARKETING'),
      jurisdiction: z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,8})?$|^DEFAULT$/).default('DEFAULT'), timezone: ianaZone.default('UTC'), priority: z.number().int().min(1).max(1000).default(100) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.campaign.create'); entitled(actor, 'marketing');
      const segment = await loadSegment(tx, actor, input.segmentId, 'marketing.segment.read');
      if (segment.channel !== input.channel) throw new AppError('VALIDATION_FAILED', 'Segment channel must match the campaign channel.', 400);
      await this.references(tx, actor, input);
      const data = { workspaceId: actor.workspaceId, ...input, senderIdentityId: input.senderIdentityId ?? null, templateVersionId: input.templateVersionId ?? null, createdByUserId: actor.userId };
      const row = await tx.marketingCampaign.create({ data: { ...data, contentHash: this.contentHash(data) } });
      await evidence(tx, actor, 'MARKETING_CAMPAIGN', row.id, 'CAMPAIGN_CREATED', { channel: row.channel, revision: row.revision });
      return row;
    });
  }
  private async references(tx: Tx, actor: Principal, input: { channel: string; senderIdentityId?: string | null; templateVersionId?: string | null }) {
    if (input.senderIdentityId && !await tx.marketingSenderIdentity.findFirst({ where: { workspaceId: actor.workspaceId, id: input.senderIdentityId, channel: input.channel } })) throw notFound('Sender');
    if (input.templateVersionId) {
      const version = await tx.marketingTemplateVersion.findFirst({ where: { workspaceId: actor.workspaceId, id: input.templateVersionId } });
      const template = version && await tx.marketingTemplate.findFirst({ where: { workspaceId: actor.workspaceId, id: version.templateId, channel: input.channel } });
      if (!template) throw notFound('Template version');
    }
  }
  async list(actor: Principal, raw: unknown) {
    const q = parse(listQuery, raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.campaign.read');
      const rows = await tx.marketingCampaign.findMany({ where: { workspaceId: actor.workspaceId, ...(q.status ? { status: q.status } : {}), ...(q.search ? { name: { contains: q.search, mode: 'insensitive' } } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
      const visible = []; for (const r of rows) try { visible.push(await loadCampaign(tx, actor, r.id, 'marketing.campaign.read')); } catch { /* scope */ }
      return paged(visible.slice((q.page - 1) * q.limit, q.page * q.limit), visible.length, q.page, q.limit);
    });
  }
  async get(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const row = await loadCampaign(tx, actor, parse(uuid, id), 'marketing.campaign.read');
      const approvals = await tx.marketingCampaignApproval.findMany({ where: { workspaceId: actor.workspaceId, campaignId: id }, orderBy: { createdAt: 'asc' } });
      const schedule = await tx.marketingCampaignSchedule.findFirst({ where: { workspaceId: actor.workspaceId, campaignId: id }, orderBy: { runAt: 'desc' } });
      return { ...row, approvals, schedule };
    });
  }
  /** Material edits (content/audience/sender) send an approved campaign back to DRAFT with a new revision. */
  async patch(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion: expectedVersion.optional(), name: z.string().trim().min(1).max(160).optional(), segmentId: uuid.optional(), senderIdentityId: uuid.nullable().optional(), templateVersionId: uuid.nullable().optional(),
      purpose: z.enum(['MARKETING', 'NEWSLETTER', 'PROMOTIONAL']).optional(), jurisdiction: z.string().optional(), timezone: ianaZone.optional(), priority: z.number().int().min(1).max(1000).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      await lock(tx, actor.workspaceId, 'marketing:campaign:' + id);
      const row = await loadCampaign(tx, actor, parse(uuid, id), 'marketing.campaign.edit');
      if (input.expectedVersion !== undefined) assertVersion(row.version, input.expectedVersion);
      if (['RUNNING', 'COMPLETED', 'CANCELLED', 'FAILED'].includes(row.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Launched campaigns are immutable; create a new campaign.', 409);
      if (input.segmentId) { const s = await loadSegment(tx, actor, input.segmentId, 'marketing.segment.read'); if (s.channel !== row.channel) throw new AppError('VALIDATION_FAILED', 'Segment channel must match.', 400); }
      await this.references(tx, actor, { channel: row.channel, senderIdentityId: input.senderIdentityId, templateVersionId: input.templateVersionId });
      const { expectedVersion: _v, ...changes } = input; void _v;
      const next = { ...row, ...changes }, hash = this.contentHash(next as MarketingCampaign), material = hash !== row.contentHash;
      const status = material && ['IN_REVIEW', 'APPROVED', 'SCHEDULED', 'PAUSED'].includes(row.status) ? 'DRAFT' : row.status;
      const updated = await tx.marketingCampaign.update({ where: { id }, data: { ...changes, contentHash: hash, status, ...(material ? { revision: { increment: 1 }, approvedRevision: null, audienceSnapshotId: null, scheduledAt: null } : {}), version: { increment: 1 } } });
      if (material) {
        await tx.marketingCampaignApproval.updateMany({ where: { workspaceId: actor.workspaceId, campaignId: id, state: { in: ['REQUESTED', 'APPROVED', 'AUTO_APPROVED'] } }, data: { state: 'INVALIDATED' } });
        await tx.marketingCampaignSchedule.updateMany({ where: { workspaceId: actor.workspaceId, campaignId: id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      }
      await evidence(tx, actor, 'MARKETING_CAMPAIGN', id, material ? 'CAMPAIGN_MATERIALLY_CHANGED' : 'CAMPAIGN_CHANGED', { revision: updated.revision, statusBefore: row.status, statusAfter: status, approvalInvalidated: material && row.status !== 'DRAFT' });
      return updated;
    });
  }

  /** READY gate: verified sender, approved template version with known variables, active segment, configured consent policy. */
  private async readiness(tx: Tx, actor: Principal, c: MarketingCampaign) {
    if (!c.senderIdentityId || !c.templateVersionId) throw new AppError('POLICY_NOT_CONFIGURED', 'Sender and approved template version are required.', 409);
    const sender = await tx.marketingSenderIdentity.findFirst({ where: { workspaceId: actor.workspaceId, id: c.senderIdentityId } });
    if (!sender || sender.status !== 'VERIFIED' || sender.channel !== c.channel) throw new AppError('SENDER_NOT_VERIFIED', 'A verified sender for this channel is required.', 409);
    const connection = await tx.marketingProviderConnection.findFirst({ where: { workspaceId: actor.workspaceId, id: sender.providerConnectionId } });
    if (!connection || connection.status === 'DISABLED') throw new AppError('DEPENDENCY_UNAVAILABLE', 'Provider connection is unavailable.', 503);
    const version = await tx.marketingTemplateVersion.findFirst({ where: { workspaceId: actor.workspaceId, id: c.templateVersionId } });
    if (!version || version.status !== 'APPROVED') throw new AppError('INVALID_STATE_TRANSITION', 'Template version must be approved.', 409);
    const unknown = [...templateVariables(version.bodyText), ...templateVariables(version.subject ?? '')].filter(v => !['firstName', 'lastName', 'displayName', 'unsubscribeUrl', 'storeName', 'companyName'].includes(v));
    if (unknown.length) throw new AppError('VALIDATION_FAILED', 'Unknown personalization token prevents launch.', 400, { fields: unknown.map(v => ({ field: v, reason: 'UNKNOWN_VARIABLE' })) });
    const segment = await loadSegment(tx, actor, c.segmentId, 'marketing.segment.read');
    if (segment.status !== 'ACTIVE') throw new AppError('INVALID_STATE_TRANSITION', 'Segment is not active.', 409);
    if (!await tx.marketingConsentPolicy.findFirst({ where: { workspaceId: actor.workspaceId, channel: c.channel, purpose: c.purpose, jurisdiction: { in: [c.jurisdiction, 'DEFAULT'] } } }))
      throw new AppError('POLICY_NOT_CONFIGURED', 'Consent policy for this channel/purpose/jurisdiction must be configured.', 409);
    return { sender, connection, version, segment };
  }
  private async approvalPolicy(tx: Tx, workspaceId: string) {
    const ws = await tx.workspace.findUnique({ where: { id: workspaceId } });
    return { alwaysRequired: true, recipientThreshold: 0, highRiskChannels: ['SMS', 'WHATSAPP', 'VOICE'], separationOfDuties: true, ...((ws?.settings as { marketing?: { approval?: ApprovalPolicy } })?.marketing?.approval ?? {}) } as Required<ApprovalPolicy>;
  }

  async preview(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const c = await loadCampaign(tx, actor, parse(uuid, id), 'marketing.campaign.read');
      const segment = await loadSegment(tx, actor, c.segmentId, 'marketing.segment.read');
      const members = await resolveSegment(tx, actor, segment); const counts: Record<string, number> = {};
      for (const hash of members.keys()) { const e = await eligibility(tx, actor.workspaceId, { destinationHash: hash, channel: c.channel, purpose: c.purpose, jurisdiction: c.jurisdiction, timezone: c.timezone }); counts[e] = (counts[e] ?? 0) + 1; }
      const connection = c.senderIdentityId ? await tx.marketingSenderIdentity.findFirst({ where: { id: c.senderIdentityId } }) : null;
      return { campaignId: id, revision: c.revision, targeted: members.size, eligibility: counts, estimatedCost: { units: counts.ELIGIBLE ?? 0, channel: c.channel, ownership: connection ? 'SEE_PROVIDER_CONNECTION' : 'UNKNOWN' } };
    });
  }
  async submitApproval(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      await lock(tx, actor.workspaceId, 'marketing:campaign:' + id);
      const c = await loadCampaign(tx, actor, parse(uuid, id), 'marketing.campaign.edit'); assertVersion(c.version, input.expectedVersion);
      transition(machine, c.status, 'IN_REVIEW');
      await this.readiness(tx, actor, c);
      const estimate = (await resolveSegment(tx, actor, await loadSegment(tx, actor, c.segmentId, 'marketing.segment.read'))).size;
      const policy = await this.approvalPolicy(tx, actor.workspaceId);
      const high = policy.highRiskChannels.includes(c.channel) || estimate >= Math.max(policy.recipientThreshold, 1) && policy.recipientThreshold > 0;
      const required = policy.alwaysRequired || high;
      const approval = await tx.marketingCampaignApproval.create({ data: { workspaceId: actor.workspaceId, campaignId: id, revision: c.revision, requesterUserId: actor.userId, state: required ? 'REQUESTED' : 'AUTO_APPROVED', riskLevel: high ? 'HIGH' : 'STANDARD', decidedAt: required ? null : new Date() } });
      const updated = await tx.marketingCampaign.update({ where: { id }, data: { status: required ? 'IN_REVIEW' : 'APPROVED', approvedRevision: required ? null : c.revision, estimatedRecipients: estimate, version: { increment: 1 } } });
      await evidence(tx, actor, 'MARKETING_CAMPAIGN', id, 'CAMPAIGN_APPROVAL_REQUESTED', { approvalId: approval.id, revision: c.revision, riskLevel: approval.riskLevel, autoApproved: !required });
      if (!required) await evidence(tx, actor, 'MARKETING_CAMPAIGN', id, 'CAMPAIGN_APPROVED', { revision: c.revision, auto: true });
      return updated;
    });
  }
  async approve(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion, revision: z.number().int().positive(), decision: z.enum(['APPROVE', 'REJECT']).default('APPROVE'), reason: z.string().trim().max(500).optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      await lock(tx, actor.workspaceId, 'marketing:campaign:' + id);
      const c = await loadCampaign(tx, actor, parse(uuid, id), 'marketing.campaign.approve'); assertVersion(c.version, input.expectedVersion);
      if (c.status !== 'IN_REVIEW' || c.revision !== input.revision) throw new AppError('INVALID_STATE_TRANSITION', 'Approval must target the current revision under review.', 409);
      const pending = await tx.marketingCampaignApproval.findFirst({ where: { workspaceId: actor.workspaceId, campaignId: id, revision: c.revision, state: 'REQUESTED' } });
      if (!pending) throw new AppError('INVALID_STATE_TRANSITION', 'No pending approval.', 409);
      const policy = await this.approvalPolicy(tx, actor.workspaceId);
      if (policy.separationOfDuties && pending.requesterUserId === actor.userId) throw new AppError('PERMISSION_DENIED', 'Requester cannot approve their own campaign.', 403);
      if (input.decision === 'APPROVE') await this.readiness(tx, actor, c);
      await tx.marketingCampaignApproval.update({ where: { id: pending.id }, data: { state: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', approverUserId: actor.userId, reason: input.reason, decidedAt: new Date() } });
      const updated = await tx.marketingCampaign.update({ where: { id }, data: { status: input.decision === 'APPROVE' ? 'APPROVED' : 'DRAFT', approvedRevision: input.decision === 'APPROVE' ? c.revision : null, version: { increment: 1 } } });
      await evidence(tx, actor, 'MARKETING_CAMPAIGN', id, input.decision === 'APPROVE' ? 'CAMPAIGN_APPROVED' : 'CAMPAIGN_REJECTED', { revision: c.revision });
      return updated;
    });
  }
  async schedule(actor: Principal, id: string, raw: unknown, key: string | null) {
    const input = parse(z.strictObject({ expectedVersion, approvedRevision: z.number().int().positive(), scheduledLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/), timezone: ianaZone, costAcknowledged: z.literal(true) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      await lock(tx, actor.workspaceId, 'marketing:campaign:' + id); requirePermission(actor, 'marketing.campaign.publish');
      return command(tx, actor, 'marketing.campaign.schedule:' + id, key, input, async () => {
        const c = await loadCampaign(tx, actor, parse(uuid, id), 'marketing.campaign.publish'); assertVersion(c.version, input.expectedVersion);
        if (c.approvedRevision !== input.approvedRevision || c.revision !== input.approvedRevision) throw new AppError('INVALID_STATE_TRANSITION', 'Approved revision is not current.', 409);
        transition(machine, c.status, 'SCHEDULED'); await this.readiness(tx, actor, c);
        const [date, time] = input.scheduledLocal.split('T'), runAt = zonedInstant(date, time, input.timezone);
        if (runAt <= new Date()) throw new AppError('VALIDATION_FAILED', 'Scheduled time must be in the future.', 400, { fields: [{ field: 'scheduledLocal', reason: 'PAST' }] });
        // One schedule row per (campaign, revision, instant): a DST-ambiguous local time maps to a single UTC run.
        await tx.marketingCampaignSchedule.create({ data: { workspaceId: actor.workspaceId, campaignId: id, revision: c.revision, runAt, executionKey: `${id}:${c.revision}:${runAt.toISOString()}` } });
        const updated = await tx.marketingCampaign.update({ where: { id }, data: { status: 'SCHEDULED', scheduledAt: runAt, scheduledLocal: input.scheduledLocal, timezone: input.timezone, version: { increment: 1 } } });
        await evidence(tx, actor, 'MARKETING_CAMPAIGN', id, 'CAMPAIGN_SCHEDULED', { runAt: runAt.toISOString(), timezone: input.timezone, revision: c.revision });
        return updated;
      });
    });
  }
  /** Freezes the audience snapshot (immutable after FROZEN) and creates per-recipient deliveries for eligible recipients. */
  async freeze(tx: Tx, actor: Principal, c: MarketingCampaign) {
    if (c.audienceSnapshotId) return tx.marketingAudienceSnapshot.findUniqueOrThrow({ where: { id: c.audienceSnapshotId } });
    const segment = await loadSegment(tx, actor, c.segmentId, 'marketing.segment.read');
    const snapshot = await tx.marketingAudienceSnapshot.create({ data: { workspaceId: actor.workspaceId, campaignId: c.id, segmentId: segment.id, segmentRevision: segment.revision } });
    try {
      const members = await resolveSegment(tx, actor, segment);
      for (const [hash, member] of [...members].sort(([a], [b]) => a.localeCompare(b))) {
        const state = await eligibility(tx, actor.workspaceId, { destinationHash: hash, channel: c.channel, purpose: c.purpose, jurisdiction: c.jurisdiction, timezone: c.timezone, campaignId: c.id });
        await tx.marketingAudienceRecipient.create({ data: { workspaceId: actor.workspaceId, snapshotId: snapshot.id, campaignId: c.id, recipientKey: sha256(c.id + ':' + hash), destinationHash: hash, destinationSealed: encrypt(member.destination), channel: c.channel, sourceRef: member.ref, eligibilityState: state === 'QUIET_HOURS' || state === 'FREQUENCY_BLOCKED' ? 'ELIGIBLE' : state } });
      }
      const frozen = await tx.marketingAudienceSnapshot.update({ where: { id: snapshot.id }, data: { status: 'FROZEN', targetCount: members.size, checksum: sha256([...members.keys()].sort().join('|')) } });
      await tx.marketingCampaign.update({ where: { id: c.id }, data: { audienceSnapshotId: snapshot.id } });
      await evidence(tx, actor, 'MARKETING_CAMPAIGN', c.id, 'AUDIENCE_SNAPSHOT_FROZEN', { snapshotId: snapshot.id, targetCount: members.size });
      return frozen;
    } catch (error) {
      await evidence(tx, actor, 'MARKETING_CAMPAIGN', c.id, 'AUDIENCE_SNAPSHOT_FAILED', { snapshotId: snapshot.id }); throw error;
    }
  }
  async audienceSnapshot(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      await lock(tx, actor.workspaceId, 'marketing:campaign:' + id);
      const c = await loadCampaign(tx, actor, parse(uuid, id), 'marketing.campaign.publish');
      if (!['APPROVED', 'SCHEDULED'].includes(c.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Snapshots freeze for approved campaigns.', 409);
      return this.freeze(tx, actor, c);
    });
  }
  async audiencePreview(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      const c = await loadCampaign(tx, actor, parse(uuid, id), 'marketing.campaign.read');
      if (!c.audienceSnapshotId) return { frozen: false, ...(await this.preview(actor, id)) };
      const groups = await tx.marketingAudienceRecipient.groupBy({ by: ['eligibilityState'], where: { workspaceId: actor.workspaceId, snapshotId: c.audienceSnapshotId }, _count: { _all: true } });
      const snapshot = await tx.marketingAudienceSnapshot.findUniqueOrThrow({ where: { id: c.audienceSnapshotId } });
      return { frozen: true, snapshotId: snapshot.id, targetCount: snapshot.targetCount, checksum: snapshot.checksum, eligibility: Object.fromEntries(groups.map(g => [g.eligibilityState, g._count._all])) };
    });
  }
  async launchInTx(tx: Tx, actor: Principal, c: MarketingCampaign) {
    transition(machine, c.status, 'RUNNING');
    const { sender, connection, version } = await this.readiness(tx, actor, c);
    const snapshot = await this.freeze(tx, actor, c);
    const recipients = await tx.marketingAudienceRecipient.findMany({ where: { workspaceId: actor.workspaceId, snapshotId: snapshot.id } });
    const experiment = await tx.marketingExperiment.findUnique({ where: { campaignId: c.id } });
    const variants = experiment && experiment.status !== 'STOPPED' ? await tx.marketingVariant.findMany({ where: { experimentId: experiment.id } }) : [];
    const { allocate } = await import('../suite/kernel');
    let queued = 0;
    for (const r of recipients.filter(r => r.eligibilityState === 'ELIGIBLE')) {
      const variant = variants.length ? allocate(variants.map(v => ({ ...v, percent: Number(v.percentage) })), experiment!.seed, r.recipientKey) : null;
      await tx.marketingDelivery.upsert({ where: { campaignId_recipientKey_channel_variantId: { campaignId: c.id, recipientKey: r.recipientKey, channel: c.channel, variantId: variant?.id ?? '' } },
        create: { workspaceId: actor.workspaceId, campaignId: c.id, recipientId: r.id, recipientKey: r.recipientKey, destinationHash: r.destinationHash, channel: c.channel, variantId: variant?.id ?? '', templateVersionId: variant?.templateVersionId ?? version.id, senderIdentityId: sender.id, providerConnectionId: connection.id }, update: {} });
      if (variant) await tx.marketingVariant.update({ where: { id: variant.id }, data: { assignedRecipients: { increment: 1 } } });
      queued++;
    }
    if (experiment && experiment.status === 'DRAFT') await tx.marketingExperiment.update({ where: { id: experiment.id }, data: { status: 'RUNNING' } });
    const updated = await tx.marketingCampaign.update({ where: { id: c.id }, data: { status: 'RUNNING', launchedAt: new Date(), version: { increment: 1 } } });
    await evidence(tx, actor, 'MARKETING_CAMPAIGN', c.id, 'CAMPAIGN_LAUNCHED', { revision: c.revision, targeted: recipients.length, queued });
    return { ...updated, targeted: recipients.length, queued };
  }
  async launch(actor: Principal, id: string, raw: unknown, key: string | null) {
    const input = parse(z.strictObject({ expectedVersion, approvedRevision: z.number().int().positive() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      await lock(tx, actor.workspaceId, 'marketing:campaign:' + id); requirePermission(actor, 'marketing.campaign.publish');
      return command(tx, actor, 'marketing.campaign.launch:' + id, key, input, async () => {
        const c = await loadCampaign(tx, actor, parse(uuid, id), 'marketing.campaign.publish'); assertVersion(c.version, input.expectedVersion);
        if (c.approvedRevision !== input.approvedRevision || c.revision !== input.approvedRevision) throw new AppError('INVALID_STATE_TRANSITION', 'Approved revision is not current.', 409);
        if (typeof actor.entitlements?.marketingMonthlySendLimit === 'number') {
          const since = new Date(); since.setUTCDate(1); since.setUTCHours(0, 0, 0, 0);
          if (await tx.marketingDelivery.count({ where: { workspaceId: actor.workspaceId, isTest: false, sentAt: { gte: since } } }) >= actor.entitlements.marketingMonthlySendLimit) throw new AppError('RATE_LIMITED', 'Monthly sending quota reached.', 429);
        }
        await tx.marketingCampaignSchedule.updateMany({ where: { workspaceId: actor.workspaceId, campaignId: id, status: 'PENDING' }, data: { status: 'SUPERSEDED' } });
        return this.launchInTx(tx, actor, c);
      });
    });
  }
  async pause(actor: Principal, id: string) { return this.simple(actor, id, 'marketing.campaign.pause', 'PAUSED', 'CAMPAIGN_PAUSED'); }
  async resume(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      await lock(tx, actor.workspaceId, 'marketing:campaign:' + id);
      const c = await loadCampaign(tx, actor, parse(uuid, id), 'marketing.campaign.pause');
      const to = c.launchedAt ? 'RUNNING' : 'SCHEDULED'; transition(machine, c.status, to);
      await this.readiness(tx, actor, c); // consent/suppression are re-evaluated again per send by the worker
      const updated = await tx.marketingCampaign.update({ where: { id }, data: { status: to, version: { increment: 1 } } });
      await evidence(tx, actor, 'MARKETING_CAMPAIGN', id, 'CAMPAIGN_RESUMED', { to }); return updated;
    });
  }
  async cancel(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      await lock(tx, actor.workspaceId, 'marketing:campaign:' + id);
      const c = await loadCampaign(tx, actor, parse(uuid, id), 'marketing.campaign.cancel'); transition(machine, c.status, 'CANCELLED');
      const cancelled = await tx.marketingDelivery.updateMany({ where: { workspaceId: actor.workspaceId, campaignId: id, state: { in: ['QUEUED', 'DEFERRED', 'FAILED_RETRYABLE'] } }, data: { state: 'CANCELLED' } });
      await tx.marketingCampaignSchedule.updateMany({ where: { workspaceId: actor.workspaceId, campaignId: id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      const updated = await tx.marketingCampaign.update({ where: { id }, data: { status: 'CANCELLED', version: { increment: 1 } } });
      await evidence(tx, actor, 'MARKETING_CAMPAIGN', id, 'CAMPAIGN_CANCELLED', { cancelledDeliveries: cancelled.count }); return updated;
    });
  }
  private async simple(actor: Principal, id: string, permission: string, to: string, event: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      await lock(tx, actor.workspaceId, 'marketing:campaign:' + id);
      const c = await loadCampaign(tx, actor, parse(uuid, id), permission); transition(machine, c.status, to);
      const updated = await tx.marketingCampaign.update({ where: { id }, data: { status: to, version: { increment: 1 } } });
      await evidence(tx, actor, 'MARKETING_CAMPAIGN', id, event, {}); return updated;
    });
  }
  /** Test sends: TEST-marked, rate limited, only to the actor's own email or a verified sender address; excluded from metrics. */
  async testSend(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ destination: z.string().min(3).max(254), templateVersionId: uuid.optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.template.test');
      const c = await loadCampaign(tx, actor, parse(uuid, id), 'marketing.campaign.read');
      const recent = await tx.marketingDelivery.count({ where: { workspaceId: actor.workspaceId, isTest: true, campaignId: id, updatedAt: { gte: new Date(Date.now() - 3600000) } } });
      if (recent >= 20) throw new AppError('RATE_LIMITED', 'Test send limit reached.', 429);
      const destination = destinationOf(c.channel as Channel, input.destination);
      const user = await tx.user.findUniqueOrThrow({ where: { id: actor.userId } });
      const owned = c.channel === 'EMAIL' && user.email.toLowerCase() === destination.normalized || await tx.marketingSenderIdentity.findFirst({ where: { workspaceId: actor.workspaceId, address: destination.normalized, status: 'VERIFIED' } });
      if (!owned) throw new AppError('PERMISSION_DENIED', 'Test destinations must be owned by the requester.', 403);
      if (!c.senderIdentityId) throw new AppError('POLICY_NOT_CONFIGURED', 'Sender is required.', 409);
      const sender = await tx.marketingSenderIdentity.findFirst({ where: { workspaceId: actor.workspaceId, id: c.senderIdentityId, status: 'VERIFIED' } });
      if (!sender) throw new AppError('SENDER_NOT_VERIFIED', 'A verified sender is required.', 409);
      const connection = await tx.marketingProviderConnection.findFirstOrThrow({ where: { id: sender.providerConnectionId } });
      const versionId = input.templateVersionId ?? c.templateVersionId; const version = versionId ? await tx.marketingTemplateVersion.findFirst({ where: { workspaceId: actor.workspaceId, id: versionId } }) : null;
      if (!version) throw notFound('Template version');
      const testKey = sha256('test:' + id + ':' + destination.hash + ':' + Date.now());
      const delivery = await tx.marketingDelivery.create({ data: { workspaceId: actor.workspaceId, campaignId: id, recipientKey: 'TEST:' + testKey, destinationHash: destination.hash, channel: c.channel, templateVersionId: version.id, senderIdentityId: sender.id, providerConnectionId: connection.id, isTest: true, state: 'SENDING', attemptCount: 1 } });
      const body = render(version.bodyText, { firstName: 'Test', lastName: 'Recipient', displayName: 'Test Recipient', unsubscribeUrl: 'TEST' }, {});
      const result = await marketingSender(connection.provider, c.channel as Channel).send({ workspaceId: actor.workspaceId, connectionId: connection.id, correlationId: delivery.id, idempotencyKey: delivery.id, secretRef: connection.credentialSecretRef },
        { deliveryId: delivery.id, destination: destination.normalized, senderAddress: sender.address, subject: '[TEST] ' + (version.subject ?? ''), body, templateName: version.providerTemplate });
      await recordProviderCall(tx, { workspaceId: actor.workspaceId, module: 'marketing', provider: connection.provider, operation: 'TEST_SEND', idempotencyKey: 'delivery:' + delivery.id, campaignId: id, recipientKey: delivery.recipientKey, outcome: result.accepted ? 'ACCEPTED' : result.errorCode ?? 'FAILED', payload: { test: true } });
      await tx.marketingDelivery.update({ where: { id: delivery.id }, data: { state: result.accepted ? 'ACCEPTED' : 'FAILED', providerMessageId: result.externalMessageId, lastErrorCode: result.errorCode, sentAt: new Date() } });
      await evidence(tx, actor, 'MARKETING_CAMPAIGN', id, 'TEST_SEND_COMPLETED', { accepted: result.accepted, test: true });
      return { deliveryId: delivery.id, accepted: result.accepted, test: true };
    });
  }

  /** Scheduler: claims due schedule rows with a lease; executionKey uniqueness guarantees a single run. */
  async tickSchedules(limit = 10) {
    const due = await this.db.marketingCampaignSchedule.findMany({ where: { status: 'PENDING', runAt: { lte: new Date() } }, orderBy: { runAt: 'asc' }, take: limit });
    let launched = 0;
    for (const row of due) try {
      await this.db.$transaction(async tx => {
        await lock(tx, row.workspaceId, 'marketing:campaign:' + row.campaignId);
        const current = await tx.marketingCampaignSchedule.findUniqueOrThrow({ where: { id: row.id } });
        if (current.status !== 'PENDING') return;
        const c = await tx.marketingCampaign.findUniqueOrThrow({ where: { id: row.campaignId } });
        if (c.status !== 'SCHEDULED' || c.revision !== row.revision || c.approvedRevision !== row.revision) { await tx.marketingCampaignSchedule.update({ where: { id: row.id }, data: { status: 'SKIPPED' } }); return; }
        const { resolvePrincipal } = await import('../process-platform/context');
        const owner = await resolvePrincipal(tx, row.workspaceId, c.createdByUserId);
        await this.launchInTx(tx, owner, c);
        await tx.marketingCampaignSchedule.update({ where: { id: row.id }, data: { status: 'EXECUTED', executedAt: new Date() } });
        launched++;
      }, { timeout: 120000 });
    } catch {
      await this.db.marketingCampaignSchedule.update({ where: { id: row.id }, data: { status: 'FAILED' } }).catch(() => null);
      await this.db.marketingCampaign.updateMany({ where: { id: row.campaignId, status: 'SCHEDULED' }, data: { status: 'FAILED' } }).catch(() => null);
    }
    return { launched };
  }
}
