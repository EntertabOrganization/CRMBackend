import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../errors';
import { parse, uuid } from '../process-platform/dto';
import { evidence, requirePermission, type Principal, type Tx } from '../process-platform/context';
import { assertNoExecutable, assertVersion, entitled, expectedVersion, inTx, newToken, notFound, safeEqual, sha256 } from '../suite/kernel';
import { marketingSender, providerChannels, recordProviderCall, resolveSecret } from '../suite/providers';
import { channel, destinationOf } from './support';

const secretRef = z.string().regex(/^env:[A-Z][A-Z0-9_]{1,80}$/, 'Use a secret manager reference such as env:NAME');
const VARIABLES = new Set(['firstName', 'lastName', 'displayName', 'unsubscribeUrl', 'storeName', 'companyName']);
export function templateVariables(text: string) { return [...text.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g)].map(m => m[1]); }
export function render(text: string, values: Record<string, string | undefined>, fallbacks: Record<string, string>) {
  return text.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g, (_m, key: string) => {
    const value = values[key] ?? fallbacks[key];
    if (value === undefined) throw new AppError('RECIPIENT_INELIGIBLE', 'Required personalization value is missing.', 422, { variable: key });
    return value.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]!)); // never interpolate HTML from CRM fields
  });
}
const LIMITS: Record<string, number> = { SMS: 1600, WHATSAPP: 1024, VOICE: 3000, EMAIL: 500000 };

/** Providers, sender identities and immutable template versions (specs Marketing/04, 05). */
export class MarketingChannelService {
  constructor(private readonly db: PrismaClient) {}

  async connect(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ provider: z.enum(['SANDBOX', 'SMTP', 'SES', 'TWILIO', 'META_WHATSAPP']), channel, ownership: z.enum(['PLATFORM', 'WORKSPACE']), credentialSecretRef: secretRef, webhookSecretRef: secretRef.optional(),
      region: z.string().max(40).optional(), quotas: z.strictObject({ perMinute: z.number().int().min(1).max(100000).optional(), perDay: z.number().int().min(1).max(10000000).optional() }).default({}) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.provider.manage'); entitled(actor, 'marketing');
      if (!providerChannels[input.provider].includes(input.channel)) throw new AppError('PROVIDER_CAPABILITY_UNAVAILABLE', `${input.provider} does not support ${input.channel}; no silent fallback is made.`, 409);
      if (input.ownership === 'PLATFORM' && actor.entitlements?.marketingPlatformSending === false) throw new AppError('PERMISSION_DENIED', 'Platform-managed sending is not included in the subscription.', 403);
      const sender = marketingSender(input.provider, input.channel);
      const row = await tx.marketingProviderConnection.create({ data: { workspaceId: actor.workspaceId, provider: input.provider, channel: input.channel, ownership: input.ownership, credentialSecretRef: input.credentialSecretRef,
        credentialMask: input.credentialSecretRef.replace(/^(env:.{0,3}).*$/, '$1***'), webhookSecretRef: input.webhookSecretRef, region: input.region, quotas: input.quotas, capabilities: [...sender.capabilities], status: 'PENDING' } });
      await evidence(tx, actor, 'MARKETING_PROVIDER', row.id, 'PROVIDER_CONNECTED', { provider: row.provider, channel: row.channel, ownership: row.ownership });
      return this.view(row);
    });
  }
  view(row: { credentialSecretRef: string; webhookSecretRef: string | null } & Record<string, unknown>) { const { credentialSecretRef, webhookSecretRef, ...safe } = row; void credentialSecretRef; void webhookSecretRef; return safe; }
  async list(actor: Principal) {
    return inTx(this.db, actor, async (tx, actor) => { requirePermission(actor, 'marketing.provider.manage'); return (await tx.marketingProviderConnection.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: 'desc' } })).map(r => this.view(r)); });
  }
  private async connection(tx: Tx, actor: Principal, id: string) {
    const row = await tx.marketingProviderConnection.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
    if (!row) throw notFound('Provider connection'); return row;
  }
  /** Health probe resolves credentials through the secret layer; missing secrets mark the connection DEGRADED. */
  async health(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.provider.manage');
      const row = await this.connection(tx, actor, id);
      let health = 'HEALTHY';
      if (row.provider !== 'SANDBOX') try { resolveSecret(row.credentialSecretRef); } catch { health = 'CREDENTIALS_UNAVAILABLE'; }
      const status = health === 'HEALTHY' ? (row.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE') : 'DEGRADED';
      if (status !== row.status || health !== row.health) {
        await tx.marketingProviderConnection.update({ where: { id: row.id }, data: { status, health, lastHealthAt: new Date(), version: { increment: 1 } } });
        await evidence(tx, actor, 'MARKETING_PROVIDER', row.id, 'PROVIDER_HEALTH_CHANGED', { from: row.health, to: health });
        // Revoked/unavailable credentials pause unattempted deliveries instead of failing them.
        if (status === 'DEGRADED') await tx.marketingDelivery.updateMany({ where: { workspaceId: actor.workspaceId, providerConnectionId: row.id, state: { in: ['QUEUED', 'FAILED_RETRYABLE'] } }, data: { state: 'DEFERRED', lastErrorCode: 'PROVIDER_CREDENTIALS_UNAVAILABLE' } });
        if (status === 'ACTIVE') await tx.marketingDelivery.updateMany({ where: { workspaceId: actor.workspaceId, providerConnectionId: row.id, state: 'DEFERRED', lastErrorCode: 'PROVIDER_CREDENTIALS_UNAVAILABLE' }, data: { state: 'QUEUED', nextAttemptAt: new Date() } });
      }
      return { id: row.id, provider: row.provider, channel: row.channel, status, health, checkedAt: new Date(), liveVerification: row.provider === 'SANDBOX' ? 'SANDBOX_ONLY' : 'REQUIRES_STAGING_SMOKE' };
    });
  }
  async disable(actor: Principal, id: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.provider.manage');
      const row = await this.connection(tx, actor, id);
      await tx.marketingProviderConnection.update({ where: { id: row.id }, data: { status: 'DISABLED', version: { increment: 1 } } });
      await tx.marketingDelivery.updateMany({ where: { workspaceId: actor.workspaceId, providerConnectionId: row.id, state: { in: ['QUEUED', 'FAILED_RETRYABLE'] } }, data: { state: 'DEFERRED', lastErrorCode: 'PROVIDER_CREDENTIALS_UNAVAILABLE' } });
      await evidence(tx, actor, 'MARKETING_PROVIDER', row.id, 'PROVIDER_HEALTH_CHANGED', { to: 'DISABLED' });
      return { id: row.id, status: 'DISABLED' };
    });
  }

  async createSender(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ channel, displayName: z.string().trim().min(1).max(120), address: z.string().trim().min(3).max(254), providerConnectionId: uuid }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.sender.manage');
      const connection = await this.connection(tx, actor, input.providerConnectionId);
      if (connection.channel !== input.channel) throw new AppError('PROVIDER_CAPABILITY_UNAVAILABLE', 'Sender channel must match the provider connection.', 409);
      if (input.channel !== 'WHATSAPP') destinationOf(input.channel, input.address);
      const token = newToken('sv_');
      const row = await tx.marketingSenderIdentity.create({ data: { workspaceId: actor.workspaceId, channel: input.channel, displayName: input.displayName, address: input.address.toLowerCase(), providerConnectionId: connection.id, verificationTokenHash: sha256(token) } });
      await evidence(tx, actor, 'MARKETING_SENDER', row.id, 'SENDER_CREATED', { channel: row.channel });
      // The verification challenge is delivered to the sender address (email) or validated by the provider (SMS/WhatsApp).
      await recordProviderCall(tx, { workspaceId: actor.workspaceId, module: 'marketing', provider: connection.provider, operation: 'SENDER_VERIFICATION', idempotencyKey: 'sender-verify:' + row.id, outcome: 'QUEUED', payload: { senderId: row.id } });
      return { ...row, verificationTokenHash: undefined, verificationChallenge: connection.provider === 'SANDBOX' ? token : undefined };
    });
  }
  async verifySender(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ challenge: z.string().min(10).max(200) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.sender.manage');
      const row = await tx.marketingSenderIdentity.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
      if (!row) throw notFound('Sender');
      if (row.status === 'VERIFIED') return { id: row.id, status: row.status };
      if (row.status === 'REVOKED' || !row.verificationTokenHash || !safeEqual(row.verificationTokenHash, sha256(input.challenge))) throw new AppError('PERMISSION_DENIED', 'Sender ownership could not be verified.', 403);
      const updated = await tx.marketingSenderIdentity.update({ where: { id: row.id }, data: { status: 'VERIFIED', verifiedAt: new Date(), verificationTokenHash: null, version: { increment: 1 } } });
      await evidence(tx, actor, 'MARKETING_SENDER', row.id, 'SENDER_VERIFIED', {});
      return { id: updated.id, status: updated.status, verifiedAt: updated.verifiedAt };
    });
  }
  async patchSender(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion, displayName: z.string().trim().min(1).max(120).optional(), status: z.literal('REVOKED').optional() }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.sender.manage');
      const row = await tx.marketingSenderIdentity.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
      if (!row) throw notFound('Sender'); assertVersion(row.version, input.expectedVersion);
      const updated = await tx.marketingSenderIdentity.update({ where: { id: row.id }, data: { displayName: input.displayName, status: input.status, version: { increment: 1 } } });
      if (input.status === 'REVOKED') {
        await tx.marketingDelivery.updateMany({ where: { workspaceId: actor.workspaceId, senderIdentityId: row.id, state: { in: ['QUEUED', 'FAILED_RETRYABLE'] } }, data: { state: 'DEFERRED', lastErrorCode: 'SENDER_REVOKED' } });
        await evidence(tx, actor, 'MARKETING_SENDER', row.id, 'SENDER_REVOKED', {});
      } else await evidence(tx, actor, 'MARKETING_SENDER', row.id, 'SENDER_CHANGED', {});
      return updated;
    });
  }
  async senders(actor: Principal) {
    return inTx(this.db, actor, async (tx, actor) => { requirePermission(actor, 'marketing.sender.manage'); return tx.marketingSenderIdentity.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: 'desc' }, select: { id: true, channel: true, displayName: true, address: true, status: true, providerConnectionId: true, verifiedAt: true, version: true } }); });
  }
  /** POST /marketing/providers/:id/test sends to an owned test destination; marked TEST and excluded from metrics. */
  async providerTest(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ senderId: uuid, destination: z.string().min(3).max(254) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.provider.manage'); requirePermission(actor, 'marketing.template.test');
      const connection = await this.connection(tx, actor, id);
      const sender = await tx.marketingSenderIdentity.findFirst({ where: { workspaceId: actor.workspaceId, id: input.senderId, providerConnectionId: connection.id, status: 'VERIFIED' } });
      if (!sender) throw new AppError('INVALID_STATE_TRANSITION', 'A verified sender of this connection is required.', 409);
      const destination = destinationOf(connection.channel as 'EMAIL', input.destination);
      const ctx = { workspaceId: actor.workspaceId, connectionId: connection.id, correlationId: connection.id, idempotencyKey: 'provider-test:' + connection.id + ':' + Date.now(), secretRef: connection.credentialSecretRef };
      const result = await marketingSender(connection.provider, connection.channel as 'EMAIL').send(ctx, { deliveryId: ctx.idempotencyKey, destination: destination.normalized, senderAddress: sender.address, subject: 'TrueCRM provider test', body: 'Provider connectivity test (TEST).' });
      await recordProviderCall(tx, { workspaceId: actor.workspaceId, module: 'marketing', provider: connection.provider, operation: 'TEST_SEND', idempotencyKey: ctx.idempotencyKey, outcome: result.accepted ? 'ACCEPTED' : result.errorCode ?? 'FAILED', payload: { test: true } });
      return { accepted: result.accepted, errorCode: result.errorCode ?? null, test: true };
    });
  }

  // ------------------------------------------------------------------ templates
  async createTemplate(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ channel, name: z.string().trim().min(1).max(160) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.template.edit');
      const row = await tx.marketingTemplate.create({ data: { workspaceId: actor.workspaceId, channel: input.channel, name: input.name, createdByUserId: actor.userId } });
      await evidence(tx, actor, 'MARKETING_TEMPLATE', row.id, 'TEMPLATE_CREATED', { channel: row.channel }); return row;
    });
  }
  async templates(actor: Principal) {
    return inTx(this.db, actor, async (tx, actor) => { requirePermission(actor, 'marketing.template.edit'); return tx.marketingTemplate.findMany({ where: { workspaceId: actor.workspaceId, status: { not: 'ARCHIVED' } }, orderBy: { createdAt: 'desc' } }); });
  }
  async createVersion(actor: Principal, templateId: string, raw: unknown) {
    const input = parse(z.strictObject({ subject: z.string().max(300).optional(), bodyMarkup: z.string().max(500000).optional(), bodyText: z.string().min(1).max(500000), providerTemplate: z.string().regex(/^[a-z0-9_]{1,512}$/).optional(),
      variableSchema: z.record(z.string(), z.strictObject({ required: z.boolean().default(true), fallback: z.string().max(200).optional() })).default({}) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.template.edit');
      const template = await tx.marketingTemplate.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, templateId) } });
      if (!template) throw notFound('Template');
      if (input.bodyMarkup) assertNoExecutable(input.bodyMarkup, 'bodyMarkup');
      if (input.bodyText.length > LIMITS[template.channel]) throw new AppError('VALIDATION_FAILED', 'Body exceeds the channel limit.', 400, { fields: [{ field: 'bodyText', reason: 'CHANNEL_LIMIT' }] });
      if (template.channel === 'WHATSAPP' && !input.providerTemplate) throw new AppError('VALIDATION_FAILED', 'WhatsApp requires an approved provider template name.', 400, { fields: [{ field: 'providerTemplate', reason: 'REQUIRED' }] });
      const used = new Set([...templateVariables(input.bodyText), ...templateVariables(input.subject ?? ''), ...templateVariables(input.bodyMarkup ?? '')]);
      const unknown = [...used].filter(v => !VARIABLES.has(v));
      if (unknown.length) throw new AppError('VALIDATION_FAILED', 'Unknown personalization token.', 400, { fields: unknown.map(v => ({ field: 'variables.' + v, reason: 'UNKNOWN_VARIABLE' })) });
      const last = await tx.marketingTemplateVersion.findFirst({ where: { templateId }, orderBy: { versionNo: 'desc' } });
      const checksum = sha256(JSON.stringify([input.subject ?? '', input.bodyMarkup ?? '', input.bodyText, input.providerTemplate ?? '']));
      const row = await tx.marketingTemplateVersion.create({ data: { workspaceId: actor.workspaceId, templateId, versionNo: (last?.versionNo ?? 0) + 1, subject: input.subject, bodyMarkup: input.bodyMarkup, bodyText: input.bodyText, providerTemplate: input.providerTemplate, variableSchema: input.variableSchema, checksum, createdByUserId: actor.userId, status: 'REVIEW' } });
      await tx.marketingTemplate.update({ where: { id: templateId }, data: { latestVersionId: row.id, status: 'REVIEW', version: { increment: 1 } } });
      await evidence(tx, actor, 'MARKETING_TEMPLATE', templateId, 'TEMPLATE_VERSION_CREATED', { versionNo: row.versionNo, checksum });
      return row;
    });
  }
  async approveVersion(actor: Principal, templateId: string, versionNo: string) {
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.template.approve');
      const row = await tx.marketingTemplateVersion.findFirst({ where: { workspaceId: actor.workspaceId, templateId: parse(uuid, templateId), versionNo: Number(versionNo) } });
      if (!row) throw notFound('Template version');
      if (row.status === 'APPROVED') return row;
      const updated = await tx.marketingTemplateVersion.update({ where: { id: row.id }, data: { status: 'APPROVED', approvedByUserId: actor.userId, approvedAt: new Date() } });
      await tx.marketingTemplate.update({ where: { id: templateId }, data: { status: 'APPROVED', version: { increment: 1 } } });
      await evidence(tx, actor, 'MARKETING_TEMPLATE', templateId, 'TEMPLATE_APPROVED', { versionNo: row.versionNo, checksum: row.checksum });
      return updated;
    });
  }
  async preview(actor: Principal, templateId: string, raw: unknown) {
    const input = parse(z.strictObject({ versionNo: z.number().int().positive().optional(), sample: z.record(z.string(), z.string().max(200)).default({}) }), raw);
    return inTx(this.db, actor, async (tx, actor) => {
      requirePermission(actor, 'marketing.template.edit');
      const row = await tx.marketingTemplateVersion.findFirst({ where: { workspaceId: actor.workspaceId, templateId: parse(uuid, templateId), ...(input.versionNo ? { versionNo: input.versionNo } : {}) }, orderBy: { versionNo: 'desc' } });
      if (!row) throw notFound('Template version');
      const fallbacks = Object.fromEntries(Object.entries(row.variableSchema as Record<string, { fallback?: string }>).filter(([, v]) => v.fallback !== undefined).map(([k, v]) => [k, v.fallback!]));
      const sample = { unsubscribeUrl: 'https://example.invalid/unsubscribe', ...input.sample };
      return { versionNo: row.versionNo, subject: row.subject ? render(row.subject, sample, fallbacks) : null, bodyText: render(row.bodyText, sample, fallbacks) };
    });
  }
}
