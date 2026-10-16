import { randomUUID } from 'node:crypto';
import type { Tx } from './kernel';
import { AppError } from '../errors';
import { encrypt, decrypt } from '../suite/kernel';
import { marketingSender } from '../suite/providers';
import { enqueueJob, registerJob, registerSchedule } from './events-service';
import { legalHoldActive } from './privacy-service';

/** Transactional delivery hand-off. Credentials and invitation tokens never enter the job/outbox payload. */
export async function queueExternalEmail(tx: Tx, input: { workspaceId: string; resourceType: 'KnowledgeGuestInvitation'; resourceId: string; to: string; subject: string; body: string }) {
  const provider = process.env.NOTIFICATION_EMAIL_PROVIDER;
  if (!['SES', 'SMTP', 'SANDBOX'].includes(provider ?? '') || provider === 'SANDBOX' && process.env.NODE_ENV === 'production')
    throw new AppError('DEPENDENCY_UNAVAILABLE', 'Configure an email delivery provider.', 503);
  if (provider !== 'SANDBOX' && (!process.env.NOTIFICATION_EMAIL_SECRET_REF || !process.env.NOTIFICATION_EMAIL_FROM))
    throw new AppError('DEPENDENCY_UNAVAILABLE', 'Email sender credentials and address must be configured.', 503);
  const id = randomUUID();
  await tx.platformExternalEmail.create({ data: { id, workspaceId: input.workspaceId, resourceType: input.resourceType, resourceId: input.resourceId,
    messageSealed: encrypt(JSON.stringify({ to: input.to, subject: input.subject, body: input.body })) } });
  const job = await enqueueJob(tx, { type: 'platform.external-email', ownerModule: 'platform', workspaceId: input.workspaceId, payload: { emailId: id }, idempotencyKey: 'email:' + id });
  return { deliveryId: id, jobId: job.id };
}

registerJob({ type: 'platform.external-email', ownerModule: 'platform', maxAttempts: 3, async run(ctx) {
  const { prisma } = await import('../prisma-client');
  const id = String(ctx.payload.emailId);
  const row = await prisma.platformExternalEmail.findUniqueOrThrow({ where: { id } });
  if (row.state !== 'QUEUED') {
    if (row.state === 'SENDING') await prisma.platformExternalEmail.updateMany({ where: { id, state: 'SENDING' }, data: { state: 'UNKNOWN', messageSealed: null } });
    return { deliveryId: id, state: row.state === 'SENDING' ? 'UNKNOWN' : row.state };
  }
  const invitation = await prisma.knowledgeGuestInvitation.findFirst({ where: { id: row.resourceId, workspaceId: row.workspaceId, status: 'PENDING', expiresAt: { gt: new Date() } } });
  const article = invitation ? await prisma.knowledgeArticle.findFirst({ where: { id: invitation.articleId, workspaceId: row.workspaceId, status: 'PUBLISHED' } }) : null;
  const space = article ? await prisma.knowledgeSpace.findUnique({ where: { id: article.spaceId } }) : null;
  if (!invitation || !article?.publishedRevisionId || space?.status !== 'ACTIVE') { await prisma.platformExternalEmail.update({ where: { id }, data: { state: 'CANCELLED', messageSealed: null } }); return { deliveryId: id, state: 'CANCELLED' }; }
  const provider = process.env.NOTIFICATION_EMAIL_PROVIDER ?? '';
  if (provider === 'SANDBOX' && process.env.NODE_ENV === 'production') throw new AppError('DEPENDENCY_UNAVAILABLE', 'Sandbox email is forbidden in production.', 503);
  const sender = marketingSender(provider, 'EMAIL');
  const message = JSON.parse(decrypt(row.messageSealed)!) as { to: string; subject: string; body: string };
  const claimed = await prisma.platformExternalEmail.updateMany({ where: { id, state: 'QUEUED' }, data: { state: 'SENDING' } });
  if (!claimed.count) return { deliveryId: id, state: 'CLAIMED' };
  // A crash/transport uncertainty after this claim is never automatically resent.
  let state = 'UNKNOWN', providerMessageId: string | undefined;
  try {
    const result = await sender.send({ workspaceId: row.workspaceId, connectionId: 'platform-email', correlationId: ctx.jobId, idempotencyKey: id, secretRef: process.env.NOTIFICATION_EMAIL_SECRET_REF },
      { deliveryId: id, destination: message.to, senderAddress: process.env.NOTIFICATION_EMAIL_FROM ?? 'sandbox@example.invalid', subject: message.subject, body: message.body });
    state = result.accepted ? 'SENT' : result.retryable ? 'UNKNOWN' : 'FAILED';
    providerMessageId = result.externalMessageId;
  } catch { /* may have been accepted: operator reconciliation, no duplicate email */ }
  await prisma.platformExternalEmail.update({ where: { id }, data: { state, providerMessageId, messageSealed: null } });
  return { deliveryId: id, state };
} });
registerJob({ type: 'platform.external-email.cleanup', ownerModule: 'platform', async run() {
  const { prisma } = await import('../prisma-client');
  const rows = await prisma.platformExternalEmail.findMany({ where: { messageSealed: { not: null } }, orderBy: { createdAt: 'asc' }, take: 100 });
  let cleared = 0;
  for (const row of rows) {
    const inv = await prisma.knowledgeGuestInvitation.findUnique({ where: { id: row.resourceId } });
    if (inv && inv.expiresAt > new Date() && inv.status === 'PENDING') continue;
    if (await legalHoldActive(prisma, row.workspaceId, 'knowledge', inv?.articleId ?? row.resourceId)) continue;
    cleared += (await prisma.platformExternalEmail.updateMany({ where: { id: row.id, messageSealed: { not: null } }, data: { messageSealed: null, state: 'EXPIRED' } })).count;
  }
  return { cleared };
} });
registerSchedule({ name: 'platform.external-email.cleanup', ownerModule: 'platform', jobType: 'platform.external-email.cleanup', intervalMinutes: 60 });
