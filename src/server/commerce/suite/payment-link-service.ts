import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../../errors';
import { parse, uuid } from '../../process-platform/dto';
import { evidence, lock, requirePermission, resolvePrincipal, type Principal } from '../../process-platform/context';
import { exact } from '../../inventory/decimal';
import { hydrateState } from '../../persistence';
import { CommerceOrderService } from '../order-service';
import { CommercePaymentCommandService } from '../payment-command-service';
import { CommerceReconciliationService } from '../reconciliation-service';
import { newToken, requestHash, sha256, systemEvent } from '../../suite/kernel';
import { checkRateLimit } from '../../rate-limit';

/**
 * Payment orchestration seam (spec OnlineStore-Commerce/06 + 11). Shared Payments owns attempts, captures and refunds;
 * Commerce keeps typed references. A browser return never changes payment state.
 */
export class CommercePaymentLinkService {
  constructor(private readonly db: PrismaClient, readonly orders = new CommerceOrderService(db), readonly commands = new CommercePaymentCommandService(db, orders),
    readonly reconciliation = new CommerceReconciliationService(db, orders)) {}

  async createIntent(actor: Principal, orderId: string, raw: unknown, key: string | null) {
    parse(uuid, orderId);
    const input = parse(z.strictObject({ paymentMethodId: z.string().min(1).max(64), returnUrl: z.url().max(2000).optional() }), raw);
    if (!key || key.length < 8 || key.length > 128) throw new AppError('VALIDATION_FAILED', 'Idempotency-Key must contain 8 to 128 characters.', 400);
    const hash = requestHash(input);
    const prepared = await this.db.$transaction(async tx => {
      actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      const order = await this.orders.load(tx, actor, orderId, 'COMMERCE.PAYMENT_MANAGE');
      const prior = await tx.commercePaymentIntentRef.findUnique({ where: { workspaceId_orderId_idempotencyKey: { workspaceId: actor.workspaceId, orderId, idempotencyKey: key } } });
      if (prior) { if (prior.requestHash !== hash) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'Key was used with another request.', 409); return { prior, order }; }
      if (await tx.commercePaymentIntentRef.count({ where: { workspaceId: actor.workspaceId, orderId, status: { in: ['AWAITING_PROVIDER', 'UNKNOWN'] } } }))
        throw new AppError('INVALID_STATE_TRANSITION', 'A provider attempt is pending; reconcile it before creating another intent.', 409);
      if (input.returnUrl) {
        const profile = await tx.commerceStoreProfile.findUnique({ where: { storeId: order.storeId } });
        const host = new URL(input.returnUrl).hostname;
        if (new URL(input.returnUrl).protocol !== 'https:' || !((profile?.allowedReturnHosts as string[] | undefined) ?? []).includes(host)) throw new AppError('VALIDATION_FAILED', 'Return URL host is not allowed.', 400, { fields: [{ field: 'returnUrl', reason: 'HOST_NOT_ALLOWED' }] });
      }
      const remaining = exact(order.total).minus(order.paidAmount);
      if (remaining.lte(0)) throw new AppError('INVALID_STATE_TRANSITION', 'Order is already paid.', 409);
      return { prior: null, order, remaining: remaining.toFixed(6) };
    });
    if (prepared.prior) return prepared.prior;
    const offline = ['OFFLINE', 'COD', 'CASH', 'BANK_TRANSFER'].includes(input.paymentMethodId);
    let paymentId: string | null = null, status = 'AWAITING_OFFLINE_SETTLEMENT', provider = input.paymentMethodId;
    if (!offline) {
      parse(uuid, input.paymentMethodId);
      // Amount is resolved from the Order; the client never submits it.
      const ack = await this.commands.create(actor, orderId, { methodId: input.paymentMethodId, amount: prepared.remaining!, mode: 'SALE' }, 'intent:' + key) as { paymentId?: string; status?: string };
      paymentId = ack.paymentId ?? null; status = 'AWAITING_PROVIDER'; provider = 'PROVIDER_METHOD';
    }
    return this.db.$transaction(async tx => {
      const row = await tx.commercePaymentIntentRef.create({ data: { workspaceId: actor.workspaceId, orderId, providerKey: provider, paymentMethodId: input.paymentMethodId, paymentId, returnUrl: input.returnUrl,
        amount: prepared.remaining!, currency: prepared.order.currency, status, idempotencyKey: key, requestHash: hash } });
      await evidence(tx, actor, 'COMMERCE_ORDER', orderId, 'PAYMENT_INTENT_CREATED', { intentId: row.id, paymentId, method: offline ? input.paymentMethodId : 'PROVIDER' });
      return row;
    });
  }

  /** Non-authoritative browser return: reports current server projection only. */
  async paymentReturn(storeSlug: string, raw: unknown) {
    const query = parse(z.object({ orderId: uuid, success: z.string().optional() }).passthrough(), raw);
    return this.db.$transaction(async tx => {
      const front = await tx.commerceStorefront.findUnique({ where: { slug: storeSlug } });
      const order = front && await tx.commerceOrder.findFirst({ where: { workspaceId: front.workspaceId, storeId: front.storeId, id: query.orderId } });
      if (!order) throw new AppError('NOT_FOUND', 'Order was not found.', 404);
      return { orderId: order.id, paymentStatus: order.paymentStatus, confirmed: order.paymentStatus === 'PAID', note: 'Payment is confirmed only by a verified provider callback or reconciliation.' };
    });
  }

  async reconcile(actor: Principal, orderId: string, key: string | null) {
    return this.reconciliation.create(actor, orderId, {}, key);
  }

  async issueLink(actor: Principal, orderId: string, raw: unknown, conversationId?: string) {
    parse(uuid, orderId); if (conversationId) parse(uuid, conversationId);
    const input = parse(z.strictObject({ expiresInMinutes: z.number().int().min(5).max(10080).default(1440) }), raw ?? {});
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'commerce:order:' + orderId); actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      requirePermission(actor, 'COMMERCE.CHECKOUT_LINK_ISSUE');
      if (conversationId) {
        // Agent needs Contact Center access plus CRM read and Commerce link issuance.
        requirePermission(actor, 'conversation.read'); requirePermission(actor, 'conversation.respond'); requirePermission(actor, 'crm.contact.read');
        const state = await hydrateState(tx);
        const conversation = (state.customerConversations as { id: string; workspaceId: string }[]).find(c => c.id === conversationId && c.workspaceId === actor.workspaceId);
        if (!conversation) throw new AppError('NOT_FOUND', 'Conversation was not found.', 404);
      }
      const order = await this.orders.load(tx, actor, orderId, 'COMMERCE.CHECKOUT_LINK_ISSUE');
      if (['CANCELLED', 'COMPLETED'].includes(order.status) || order.paymentStatus === 'PAID') throw new AppError('INVALID_STATE_TRANSITION', 'Order does not accept payment.', 409);
      const token = newToken('pl_');
      const row = await tx.commerceCheckoutLink.create({ data: { workspaceId: actor.workspaceId, storeId: order.storeId, orderId, conversationId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + input.expiresInMinutes * 60000), issuedByUserId: actor.userId } });
      await evidence(tx, actor, 'COMMERCE_ORDER', orderId, 'ORDER_CHECKOUT_LINK_ISSUED', { linkId: row.id, conversationId: conversationId ?? null });
      return { linkId: row.id, token, expiresAt: row.expiresAt };
    });
  }
  async revokeLink(actor: Principal, linkId: string) {
    return this.db.$transaction(async tx => {
      actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      const row = await tx.commerceCheckoutLink.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, linkId) } });
      if (!row || !row.orderId) throw new AppError('NOT_FOUND', 'Link was not found.', 404);
      await this.orders.load(tx, actor, row.orderId, 'COMMERCE.CHECKOUT_LINK_ISSUE');
      await tx.commerceCheckoutLink.update({ where: { id: row.id }, data: { status: 'REVOKED' } });
      await evidence(tx, actor, 'COMMERCE_ORDER', row.orderId, 'ORDER_CHECKOUT_LINK_REVOKED', { linkId });
      return { id: linkId, status: 'REVOKED' };
    });
  }
  /** Public resolution of a payment link: order summary without PII. */
  async resolveLink(token: string, client: string) {
    checkRateLimit(client, { scope: 'commerce.payment-link', limit: 60, windowMs: 60000 });
    return this.db.$transaction(async tx => {
      const row = await tx.commerceCheckoutLink.findUnique({ where: { tokenHash: sha256(token) } });
      if (!row || !row.orderId) throw new AppError('NOT_FOUND', 'Link was not found.', 404);
      if (row.status !== 'ACTIVE' || row.expiresAt <= new Date()) throw new AppError('RESOURCE_EXPIRED', 'Link expired or was revoked.', 410);
      const order = await tx.commerceOrder.findFirstOrThrow({ where: { workspaceId: row.workspaceId, id: row.orderId } });
      await systemEvent(tx, row.workspaceId, 'COMMERCE_ORDER', order.id, 'ORDER_CHECKOUT_LINK_OPENED', {}, false);
      return { orderId: order.id, currency: order.currency, total: order.total.toFixed(6), paymentStatus: order.paymentStatus, status: order.status };
    });
  }
}
