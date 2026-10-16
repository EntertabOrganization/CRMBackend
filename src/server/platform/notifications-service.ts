import { Prisma, type PrismaClient } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { requirePermission, type Principal } from '../process-platform/context';
import { encrypt } from '../suite/kernel';
import { visibleIds } from './access';
import { audit, emitEvent, notFound, pageQuery, paged, sha256, type Tx } from './kernel';

/** Topics delivered regardless of optional preferences (lawful mandatory notices). */
export const MANDATORY_TOPICS = new Set(['SECURITY', 'ACCESS_REVOCATION', 'BILLING_CRITICAL', 'LEGAL']);
const CHANNELS = ['IN_APP', 'EMAIL', 'PUSH'] as const;
const DEFAULT_ENABLED: Record<string, boolean> = { IN_APP: true, EMAIL: true, PUSH: false };
const STATUS_ORDER: Record<string, number> = { QUEUED: 0, SENT: 1, DELIVERED: 2, FAILED: 2 };
const zone = z.string().max(64).refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }, 'A valid IANA timezone is required');
const quietHours = z.strictObject({ start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timezone: zone });

export type EmitInput = { workspaceId: string; recipientIds: string[]; topic: string; title: string; message: string; link?: string | null;
  subject?: { type: string; id: string } | null; eventId: string; mandatory?: boolean; templateVersion?: number };

/** Notifications, preferences and delivery (30-Platform-Services/03). In-app row commits before any fanout. */
export class PlatformNotificationService {
  constructor(private readonly db: PrismaClient) {}

  /** Internal emit (domain owners only, inside their transaction). Dedupe = recipient + source event + topic. */
  static async emitInTx(tx: Tx, input: EmitInput) {
    const mandatory = input.mandatory ?? MANDATORY_TOPICS.has(input.topic), created: string[] = [];
    const members = await tx.workspaceMembership.findMany({ where: { workspaceId: input.workspaceId, userId: { in: input.recipientIds }, status: 'ACTIVE', isDeleted: false }, select: { userId: true } });
    for (const { userId } of members) { // no notification to users outside the Workspace
      const prefs = await tx.notificationPreference.findMany({ where: { workspaceId: input.workspaceId, userId, notificationType: input.topic } });
      const enabled = (channel: string) => mandatory ? channel !== 'PUSH' || (prefs.find(p => p.channel === 'PUSH')?.enabled ?? false) : (prefs.find(p => p.channel === channel)?.enabled ?? DEFAULT_ENABLED[channel]);
      if (!enabled('IN_APP') && !mandatory) continue;
      const idempotencyKey = sha256([userId, input.eventId, input.topic].join('|'));
      const existing = await tx.userNotification.findUnique({ where: { workspaceId_recipientUserId_idempotencyKey: { workspaceId: input.workspaceId, recipientUserId: userId, idempotencyKey } } });
      if (existing) continue;
      const row = await tx.userNotification.create({ data: { workspaceId: input.workspaceId, recipientUserId: userId, notificationType: input.topic, topic: input.topic, title: input.title.slice(0, 200), message: input.message.slice(0, 2000),
        link: input.link ?? null, idempotencyKey, subjectType: input.subject?.type ?? null, subjectId: input.subject?.id ?? null, mandatory, templateVersion: input.templateVersion ?? 1 } });
      created.push(row.id);
      const quiet = prefs.find(p => p.channel === 'EMAIL')?.quietHours as { start?: string; end?: string; timezone?: string } | undefined;
      for (const channel of ['EMAIL', 'PUSH'] as const) if (enabled(channel))
        await tx.notificationDelivery.create({ data: { workspaceId: input.workspaceId, notificationId: row.id, channel, dedupeKey: sha256(row.id + ':' + channel), nextAttemptAt: mandatory ? new Date() : PlatformNotificationService.afterQuietHours(quiet) } });
      await emitEvent(tx, { workspaceId: input.workspaceId, eventType: 'NOTIFICATION_CREATED', aggregateType: 'Notification', aggregateId: row.id, actorType: 'SERVICE', payload: { topic: input.topic, recipientId: userId } });
    }
    return created;
  }
  static afterQuietHours(quiet?: { start?: string; end?: string; timezone?: string }, now = new Date()) {
    if (!quiet?.start || !quiet.end || !quiet.timezone) return now;
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: quiet.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    const inside = quiet.start <= quiet.end ? local >= quiet.start && local < quiet.end : local >= quiet.start || local < quiet.end;
    if (!inside) return now;
    const [h, m] = quiet.end.split(':').map(Number), [lh, lm] = local.split(':').map(Number);
    let minutes = h * 60 + m - (lh * 60 + lm); if (minutes <= 0) minutes += 1440;
    return new Date(now.getTime() + minutes * 60000);
  }

  /** Inbox: previews are re-authorized; a subject the recipient can no longer read is shown without private detail. */
  async inbox(actor: Principal, raw: unknown) {
    const q = pageQuery.extend({ status: z.enum(['UNREAD', 'READ', 'ARCHIVED']).optional() }).parse(raw);
    const where = { workspaceId: actor.workspaceId, recipientUserId: actor.userId, ...(q.status ? { status: q.status } : { status: { not: 'ARCHIVED' } }) };
    const [rows, total] = await Promise.all([this.db.userNotification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.limit, take: q.limit }), this.db.userNotification.count({ where })]);
    const data = await this.db.$transaction(async tx => {
      const allowed = new Map<string, Set<string>>();
      for (const type of new Set(rows.filter(r => r.subjectType).map(r => r.subjectType!))) allowed.set(type, await visibleIds(tx, actor, type, rows.filter(r => r.subjectType === type).map(r => r.subjectId!)));
      return rows.map(r => {
        const hidden = r.subjectType && r.subjectId && !allowed.get(r.subjectType)?.has(r.subjectId);
        return { id: r.id, topic: r.topic ?? r.notificationType, status: r.status, mandatory: r.mandatory, createdAt: r.createdAt, readAt: r.readAt,
          title: hidden ? 'An item you followed is no longer available to you' : r.title, message: hidden ? '' : r.message, link: hidden ? null : r.link, subject: hidden ? null : r.subjectType ? { type: r.subjectType, id: r.subjectId } : null };
      });
    });
    return paged(data, total, q.page, q.limit);
  }
  async mark(actor: Principal, id: string, to: 'READ' | 'UNREAD' | 'ARCHIVED') {
    return this.db.$transaction(async tx => {
      const row = await tx.userNotification.findFirst({ where: { workspaceId: actor.workspaceId, recipientUserId: actor.userId, id: z.uuid().parse(id) } });
      if (!row) throw notFound('Notification');
      const allowed: Record<string, string[]> = { UNREAD: ['READ', 'ARCHIVED'], READ: ['UNREAD', 'ARCHIVED'], ARCHIVED: [] };
      if (row.status === to) return row;
      if (!allowed[row.status]?.includes(to)) throw new AppError('INVALID_STATE_TRANSITION', `Cannot move a ${row.status} notification to ${to}.`, 409);
      const updated = await tx.userNotification.update({ where: { id: row.id }, data: { status: to, readAt: to === 'READ' ? new Date() : to === 'UNREAD' ? null : row.readAt, archivedAt: to === 'ARCHIVED' ? new Date() : null } });
      if (to === 'READ') await emitEvent(tx, { workspaceId: actor.workspaceId, eventType: 'NOTIFICATION_READ', aggregateType: 'Notification', aggregateId: row.id, actorId: actor.userId, payload: {} });
      return { id: updated.id, status: updated.status };
    });
  }
  async readAll(actor: Principal) {
    const result = await this.db.userNotification.updateMany({ where: { workspaceId: actor.workspaceId, recipientUserId: actor.userId, status: 'UNREAD' }, data: { status: 'READ', readAt: new Date() } });
    return { updated: result.count };
  }
  async preferences(actor: Principal) {
    const rows = await this.db.notificationPreference.findMany({ where: { workspaceId: actor.workspaceId, userId: actor.userId }, orderBy: [{ notificationType: 'asc' }, { channel: 'asc' }] });
    return { mandatoryTopics: [...MANDATORY_TOPICS], defaults: DEFAULT_ENABLED, preferences: rows.map(r => ({ topic: r.notificationType, channel: r.channel, enabled: r.enabled, quietHours: r.quietHours })) };
  }
  async updatePreferences(actor: Principal, raw: unknown) {
    const input = z.strictObject({ topic: z.string().regex(/^[A-Z][A-Z0-9_]{1,60}$/), channels: z.partialRecord(z.enum(CHANNELS), z.boolean()), quietHours: quietHours.nullable().optional() }).parse(raw);
    if (MANDATORY_TOPICS.has(input.topic) && (input.channels.IN_APP === false || input.channels.EMAIL === false))
      throw new AppError('BUSINESS_RULE_VIOLATION', 'Mandatory security, access and billing notices cannot be disabled.', 422);
    return this.db.$transaction(async tx => {
      for (const [channel, enabled] of Object.entries(input.channels)) await tx.notificationPreference.upsert({ where: { workspaceId_userId_notificationType_channel: { workspaceId: actor.workspaceId, userId: actor.userId, notificationType: input.topic, channel } },
        create: { workspaceId: actor.workspaceId, userId: actor.userId, notificationType: input.topic, channel, enabled: Boolean(enabled), quietHours: (input.quietHours ?? {}) as Prisma.InputJsonObject },
        update: { enabled: Boolean(enabled), ...(input.quietHours !== undefined ? { quietHours: (input.quietHours ?? {}) as Prisma.InputJsonObject } : {}) } });
      return this.preferences(actor);
    });
  }
  async registerDevice(actor: Principal, raw: unknown) {
    const input = z.strictObject({ platform: z.enum(['IOS', 'ANDROID', 'WEB']), pushToken: z.string().min(16).max(4096) }).parse(raw);
    const hash = sha256(input.pushToken);
    const row = await this.db.deviceRegistration.upsert({ where: { workspaceId_userId_pushTokenHash: { workspaceId: actor.workspaceId, userId: actor.userId, pushTokenHash: hash } },
      create: { workspaceId: actor.workspaceId, userId: actor.userId, platform: input.platform, pushTokenHash: hash, pushTokenSealed: encrypt(input.pushToken) }, update: { revokedAt: null, lastVerifiedAt: new Date() } });
    return { id: row.id, platform: row.platform, lastVerifiedAt: row.lastVerifiedAt }; // token never echoed
  }
  async revokeDevice(actor: Principal, id: string) {
    const result = await this.db.deviceRegistration.updateMany({ where: { workspaceId: actor.workspaceId, userId: actor.userId, id: z.uuid().parse(id), revokedAt: null }, data: { revokedAt: new Date() } });
    if (!result.count) throw notFound('Device');
    return { id, revoked: true };
  }

  /** Delivery worker. Email/push providers are external; without a configured provider deliveries fail visibly. */
  async tickDeliveries(limit = 50) {
    const due = await this.db.notificationDelivery.findMany({ where: { status: 'QUEUED', nextAttemptAt: { lte: new Date() } }, take: limit, orderBy: { nextAttemptAt: 'asc' } });
    for (const d of due) {
      const provider = d.channel === 'EMAIL' ? process.env.NOTIFICATION_EMAIL_PROVIDER : process.env.NOTIFICATION_PUSH_PROVIDER;
      if (provider === 'SANDBOX') { await this.db.notificationDelivery.updateMany({ where: { id: d.id, status: 'QUEUED' }, data: { status: 'SENT', attempt: { increment: 1 }, providerMessageId: 'sbx_' + d.id } }); continue; }
      await this.db.$transaction(async tx => {
        const updated = await tx.notificationDelivery.updateMany({ where: { id: d.id, status: 'QUEUED' }, data: { status: 'FAILED', attempt: { increment: 1 }, lastErrorCode: 'PROVIDER_NOT_CONFIGURED' } });
        if (updated.count) await emitEvent(tx, { workspaceId: d.workspaceId, eventType: 'NOTIFICATION_DELIVERY_FAILED', aggregateType: 'NotificationDelivery', aggregateId: d.id, actorType: 'SERVICE', payload: { channel: d.channel, code: 'PROVIDER_NOT_CONFIGURED' } });
      });
    }
    return { processed: due.length };
  }
  /** Signed provider status callback; (provider, providerEventId) dedupe; status never regresses. */
  async providerEvent(provider: string, headers: Headers, rawBody: string) {
    const secret = process.env.NOTIFICATION_WEBHOOK_SECRET;
    if (!secret) throw new AppError('DEPENDENCY_UNAVAILABLE', 'Notification provider webhooks are not configured.', 503);
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex'), given = headers.get('x-notification-signature') ?? '';
    if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) throw new AppError('UNAUTHENTICATED', 'Provider signature is invalid.', 401);
    const event = z.object({ eventId: z.string().min(1).max(200), providerMessageId: z.string().min(1).max(200), status: z.enum(['SENT', 'DELIVERED', 'FAILED']) }).parse(JSON.parse(rawBody));
    return this.db.$transaction(async tx => {
      try { await tx.notificationProviderEvent.create({ data: { provider, providerEventId: event.eventId, status: event.status } }); }
      catch (e) { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { accepted: true, duplicate: true }; throw e; }
      const delivery = await tx.notificationDelivery.findFirst({ where: { providerMessageId: event.providerMessageId } });
      if (delivery && (STATUS_ORDER[event.status] ?? 0) > (STATUS_ORDER[delivery.status] ?? 0)) await tx.notificationDelivery.update({ where: { id: delivery.id }, data: { status: event.status } });
      return { accepted: true, duplicate: false };
    });
  }
  /** Platform-scoped emitter for workspace staff (e.g. announcements) behind an explicit permission. */
  async adminEmit(actor: Principal, raw: unknown, requestId: string) {
    requirePermission(actor, 'platform.notification.admin');
    const input = z.strictObject({ recipientIds: z.array(z.uuid()).min(1).max(500), topic: z.string().regex(/^[A-Z][A-Z0-9_]{1,60}$/), title: z.string().min(1).max(200), message: z.string().max(2000), eventKey: z.string().min(8).max(120) }).parse(raw);
    return this.db.$transaction(async tx => {
      const ids = await PlatformNotificationService.emitInTx(tx, { workspaceId: actor.workspaceId, recipientIds: input.recipientIds, topic: input.topic, title: input.title, message: input.message, eventId: sha256(actor.workspaceId + input.eventKey) });
      await audit(tx, { workspaceId: actor.workspaceId, actorId: actor.userId, action: 'NOTIFICATION_BROADCAST', resourceType: 'Notification', resourceId: ids[0] ?? null, after: { topic: input.topic, recipients: ids.length }, requestId });
      return { created: ids.length };
    });
  }
}
