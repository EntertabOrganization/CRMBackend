import type { PrismaClient, Prisma } from '@prisma/client';
import type { ActorContext } from '../access-service';
import { AdapterUnavailableError, type NotificationPort } from '../ports';
import { AppError } from '../errors';
import { Body, notFoundError, validationError } from '../collab/support';

type NotificationInput = Parameters<NotificationPort['notifyUsers']>[0];
type PreferenceInput = Parameters<NonNullable<NotificationPort['canDeliver']>>[0];

/** Shared durable inbox. Delivery runs independently of the request's hydrated business state. */
export class NotificationService implements NotificationPort {
  constructor(private readonly db: PrismaClient) {}
  private async eligible(db: Prisma.TransactionClient | PrismaClient, workspaceId: string, userId: string) {
    return Boolean(await db.workspaceMembership.findFirst({ where: { workspaceId, userId, status: 'ACTIVE', isDeleted: false,
      user: { status: 'ACTIVE', isDeleted: false }, workspace: { isDeleted: false } } }));
  }
  private async allowed(db: Prisma.TransactionClient | PrismaClient, input: PreferenceInput) {
    if (!await this.eligible(db, input.workspaceId, input.recipientUserId)) return false;
    const preference = await db.notificationPreference.findUnique({ where: { workspaceId_userId_notificationType_channel: {
      workspaceId: input.workspaceId, userId: input.recipientUserId, notificationType: input.notificationType, channel: input.channel } } });
    return preference?.enabled ?? true;
  }
  canDeliver(input: PreferenceInput) { return this.allowed(this.db, input); }
  async notifyUsers(input: NotificationInput) {
    if (input.signal?.aborted) throw new AdapterUnavailableError('Notification delivery aborted.');
    const channel = input.channel ?? 'IN_APP', notificationType = input.notificationType ?? 'GENERAL';
    // A disabled channel is suppressed; an enabled unconfigured provider remains retryable.
    if (channel !== 'IN_APP') throw new AdapterUnavailableError(`${channel} notification delivery is not configured.`);
    return this.db.$transaction(tx => this.deliverInTransaction(tx, { ...input, channel, notificationType }));
  }
  /** In-app delivery inside the caller's domain transaction, so the inbox item commits or rolls back with its business effect. */
  async deliverInTransaction(tx: Prisma.TransactionClient, input: NotificationInput) {
    const channel = input.channel ?? 'IN_APP', notificationType = input.notificationType ?? 'GENERAL';
    if (channel !== 'IN_APP') throw new AdapterUnavailableError(`${channel} notification delivery is not configured.`);
    const ids: string[] = [];
    for (const recipientUserId of [...new Set(input.recipientUserIds)].sort()) {
      if (input.signal?.aborted) throw new AdapterUnavailableError('Notification delivery aborted.');
      // Serialize preference changes and membership revocation with the final delivery check.
      await tx.$queryRaw`SELECT id FROM workspace_memberships WHERE workspace_id = CAST(${input.workspaceId} AS uuid)
        AND user_id = CAST(${recipientUserId} AS uuid) FOR UPDATE`;
      if (!await this.allowed(tx, { workspaceId: input.workspaceId, recipientUserId, channel, notificationType })) continue;
      const row = await tx.userNotification.upsert({ where: { workspaceId_recipientUserId_idempotencyKey: {
        workspaceId: input.workspaceId, recipientUserId, idempotencyKey: input.idempotencyKey } }, update: {},
        create: { workspaceId: input.workspaceId, recipientUserId, notificationType, title: input.title,
          message: input.message, link: input.link ?? null, idempotencyKey: input.idempotencyKey } });
      ids.push(row.id);
    }
    return { reference: ids.join(',') || null };
  }
  async list(actor: ActorContext, query: URLSearchParams) {
    const body = new Body(Object.fromEntries(query)); body.only(['page', 'limit']);
    const page = Number(query.get('page') ?? 1), limit = Number(query.get('limit') ?? 20);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw validationError('pagination', 'Use a positive page and a limit from 1 to 100.');
    const where = { workspaceId: actor.workspaceId, recipientUserId: actor.user.id };
    const [data, total] = await this.db.$transaction([
      this.db.userNotification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit,
        select: { id: true, notificationType: true, title: true, message: true, link: true, readAt: true, createdAt: true } }),
      this.db.userNotification.count({ where }),
    ]);
    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }
  async read(actor: ActorContext, id: string) {
    id = new Body({ id }).uuid('id', { required: true });
    await this.db.userNotification.updateMany({ where: { id, workspaceId: actor.workspaceId,
      recipientUserId: actor.user.id, readAt: null }, data: { readAt: new Date() } });
    const row = await this.db.userNotification.findFirst({ where: { id, workspaceId: actor.workspaceId, recipientUserId: actor.user.id },
      select: { id: true, readAt: true } });
    if (!row) throw notFoundError('NOTIFICATION_NOT_FOUND', 'Notification');
    return row;
  }
  preferences(actor: ActorContext) {
    return this.db.notificationPreference.findMany({ where: { workspaceId: actor.workspaceId, userId: actor.user.id },
      select: { notificationType: true, channel: true, enabled: true }, orderBy: [{ notificationType: 'asc' }, { channel: 'asc' }] });
  }
  async setPreference(actor: ActorContext, body: Body) {
    body.only(['notificationType', 'channel', 'enabled']);
    const notificationType = body.str('notificationType', { required: true, max: 100 });
    if (!/^[A-Z][A-Z0-9_]*$/.test(notificationType)) throw validationError('notificationType', 'Use an uppercase notification type.');
    const channel = body.enumOf('channel', ['IN_APP', 'EMAIL', 'PUSH'] as const, { required: true });
    const enabled = body.bool('enabled', { required: true });
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM workspace_memberships WHERE workspace_id = CAST(${actor.workspaceId} AS uuid)
        AND user_id = CAST(${actor.user.id} AS uuid) FOR UPDATE`;
      if (!await this.eligible(tx, actor.workspaceId, actor.user.id)) throw new AppError('PERMISSION_DENIED', 'Workspace membership is inactive.', 403);
      const row = await tx.notificationPreference.upsert({ where: { workspaceId_userId_notificationType_channel: {
        workspaceId: actor.workspaceId, userId: actor.user.id, notificationType, channel } }, update: { enabled },
        create: { workspaceId: actor.workspaceId, userId: actor.user.id, notificationType, channel, enabled } });
      return { notificationType: row.notificationType, channel: row.channel, enabled: row.enabled };
    });
  }
}
