import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../../errors';
import { decimal, parse, uuid } from '../../process-platform/dto';
import { evidence, lock, requirePermission, resolvePrincipal, type Principal } from '../../process-platform/context';
import { exact } from '../../inventory/decimal';
import { checkRateLimit } from '../../rate-limit';
import { CommerceOrderService } from '../order-service';
import { CommerceShipmentService } from '../shipment-service';
import { CommerceReturnService } from '../return-service';
import { CommerceRefundService } from '../refund-service';
import { CommerceCartService, hashCartToken } from '../cart-service';
import { CommerceCustomerPortalService } from './customer-portal-service';
import { newToken, sha256, systemEvent } from '../../suite/kernel';
import { CrmReferenceReadService } from '../../crm-reference-read-service';

type Line = { itemId: string; productId: string; variantId: string | null; name: string; quantity: string; stockable: boolean; total: string };
const lineQty = z.string().regex(/^\d{1,12}(?:\.\d{1,6})?$/).refine(v => exact(v).gt(0), 'Quantity must be positive');

/** Fulfillment, return refunds, delivery quotes, CRM retries, reports and digital/service fulfillment (specs 08–13). */
export class CommerceOperationsService {
  constructor(private readonly db: PrismaClient, readonly orders = new CommerceOrderService(db), readonly shipments = new CommerceShipmentService(db, orders),
    readonly returns = new CommerceReturnService(db, orders), readonly refunds = new CommerceRefundService(db, orders), readonly carts = new CommerceCartService(db),
    readonly portal = new CommerceCustomerPortalService(db)) {}

  // ---------------------------------------------------------------- fulfillment
  /** Plans a split fulfillment. SHIP creates a Commerce shipment through the owning shipment service; PICKUP stays a handoff record. */
  async createFulfillment(actor: Principal, orderId: string, raw: unknown, key: string | null) {
    const input = parse(z.strictObject({ type: z.enum(['SHIP', 'PICKUP']), warehouseId: uuid, deliveryServiceId: uuid.optional(), lines: z.array(z.strictObject({ orderLineId: uuid, quantity: lineQty })).min(1).max(100) }), raw);
    if (input.type === 'SHIP') {
      if (!input.deliveryServiceId) throw new AppError('VALIDATION_FAILED', 'deliveryServiceId is required for shipping.', 400, { fields: [{ field: 'deliveryServiceId', reason: 'REQUIRED' }] });
      const shipment = await this.shipments.create(actor, orderId, { warehouseId: input.warehouseId, deliveryServiceId: input.deliveryServiceId, items: input.lines }, key) as { id: string };
      return this.db.$transaction(async tx => {
        actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
        const existing = await tx.commerceFulfillment.findUnique({ where: { shipmentId: shipment.id } });
        if (existing) return existing;
        const order = await this.orders.load(tx, actor, orderId, 'COMMERCE.SHIPMENT_MANAGE');
        const row = await tx.commerceFulfillment.create({ data: { workspaceId: actor.workspaceId, storeId: order.storeId, orderId, warehouseId: input.warehouseId, type: 'SHIP', status: 'PICKING', lines: input.lines, shipmentId: shipment.id, createdByUserId: actor.userId } });
        await evidence(tx, actor, 'COMMERCE_ORDER', orderId, 'FULFILLMENT_CREATED', { fulfillmentId: row.id, shipmentId: shipment.id, type: 'SHIP' });
        return row;
      });
    }
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'commerce:order:' + orderId); actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      const order = await this.orders.load(tx, actor, orderId, 'COMMERCE.FULFILLMENT_MANAGE');
      if (['CANCELLED', 'COMPLETED'].includes(order.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Order is closed.', 409);
      await this.assertRemaining(orderId, actor, input.lines, tx);
      const row = await tx.commerceFulfillment.create({ data: { workspaceId: actor.workspaceId, storeId: order.storeId, orderId, warehouseId: input.warehouseId, type: 'PICKUP', status: 'PLANNED', lines: input.lines, createdByUserId: actor.userId } });
      await evidence(tx, actor, 'COMMERCE_ORDER', orderId, 'FULFILLMENT_CREATED', { fulfillmentId: row.id, type: 'PICKUP' });
      return row;
    }, { timeout: 60000 });
  }
  private async assertRemaining(orderId: string, actor: Principal, lines: { orderLineId: string; quantity: string }[], tx: Prisma.TransactionClient, excludeId?: string) {
    const order = await tx.commerceOrder.findFirstOrThrow({ where: { workspaceId: actor.workspaceId, id: orderId } });
    const snapshot = (order.snapshot as { lines?: Line[] }).lines ?? [];
    const shipped = await tx.commerceShipmentItem.findMany({ where: { workspaceId: actor.workspaceId, orderId, shipmentId: { in: (await tx.commerceShipment.findMany({ where: { workspaceId: actor.workspaceId, orderId, status: { not: 'CANCELLED' } }, select: { id: true } })).map(s => s.id) } } });
    const pickups = await tx.commerceFulfillment.findMany({ where: { workspaceId: actor.workspaceId, orderId, type: 'PICKUP', status: { not: 'CANCELLED' }, ...(excludeId ? { id: { not: excludeId } } : {}) } });
    for (const line of lines) {
      const source = snapshot.find(l => l.itemId === line.orderLineId);
      if (!source) throw new AppError('NOT_FOUND', 'Order line was not found.', 404);
      const used = shipped.filter(s => s.orderLineId === line.orderLineId).reduce((s, i) => s.plus(i.quantity), exact(0))
        .plus(pickups.flatMap(p => p.lines as { orderLineId: string; quantity: string }[]).filter(l => l.orderLineId === line.orderLineId).reduce((s, l) => s.plus(l.quantity), exact(0)));
      if (exact(line.quantity).plus(used).gt(source.quantity)) throw new AppError('VALIDATION_FAILED', 'Quantity exceeds the remaining unfulfilled quantity.', 400, { fields: [{ field: 'lines.quantity', reason: 'EXCEEDS_REMAINING' }] });
    }
  }
  async updateFulfillment(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion: z.number().int().positive(), status: z.enum(['PICKING', 'PACKED', 'DONE', 'CANCELLED']).optional(), lines: z.array(z.strictObject({ orderLineId: uuid, quantity: lineQty })).min(1).max(100).optional(), handoffConfirmation: z.strictObject({ receivedBy: z.string().trim().min(1).max(160) }).optional() }), raw);
    const order: Record<string, string[]> = { PLANNED: ['PICKING', 'CANCELLED'], PICKING: ['PACKED', 'CANCELLED'], PACKED: ['DONE', 'CANCELLED'], DISPATCHED: ['DONE'], DONE: [], CANCELLED: [] };
    return this.db.$transaction(async tx => {
      actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      const row = await tx.commerceFulfillment.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, id) } });
      if (!row) throw new AppError('NOT_FOUND', 'Fulfillment was not found.', 404);
      await lock(tx, actor.workspaceId, 'commerce:order:' + row.orderId);
      await this.orders.load(tx, actor, row.orderId, 'COMMERCE.FULFILLMENT_MANAGE');
      if (row.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Fulfillment changed; reload.', 409);
      if (input.status && !(order[row.status] ?? []).includes(input.status)) throw new AppError('INVALID_STATE_TRANSITION', `Cannot move from ${row.status} to ${input.status}.`, 409);
      if (input.status === 'DONE' && row.type === 'PICKUP' && !input.handoffConfirmation) throw new AppError('VALIDATION_FAILED', 'Pickup handoff requires an authorized confirmation.', 400, { fields: [{ field: 'handoffConfirmation', reason: 'REQUIRED' }] });
      if (input.lines) { if (row.type !== 'PICKUP' || row.status !== 'PLANNED') throw new AppError('INVALID_STATE_TRANSITION', 'Only planned pickup allocations can change; shipments use the shipment API.', 409); await this.assertRemaining(row.orderId, actor, input.lines, tx, row.id); }
      const updated = await tx.commerceFulfillment.update({ where: { id: row.id }, data: { ...(input.status ? { status: input.status } : {}), ...(input.lines ? { lines: input.lines } : {}), version: { increment: 1 } } });
      await evidence(tx, actor, 'COMMERCE_ORDER', row.orderId, input.status === 'DONE' && row.type === 'PICKUP' ? 'PICKUP_HANDED_OVER' : 'FULFILLMENT_CHANGED', { fulfillmentId: row.id, status: updated.status });
      return updated;
    });
  }
  /** Dispatch = owning shipment SHIP (posts the Inventory issue and consumes the reservation idempotently). */
  async dispatch(actor: Principal, shipmentId: string, raw: unknown, key: string | null) {
    const result = await this.shipments.transition(actor, shipmentId, raw, key, 'SHIP');
    await this.db.$transaction(async tx => {
      await tx.commerceFulfillment.updateMany({ where: { workspaceId: actor.workspaceId, shipmentId, status: { notIn: ['DONE', 'CANCELLED'] } }, data: { status: 'DISPATCHED', version: { increment: 1 } } });
      const row = await tx.commerceShipment.findFirst({ where: { workspaceId: actor.workspaceId, id: shipmentId } });
      if (row) await evidence(tx, actor, 'COMMERCE_ORDER', row.orderId, 'SHIPMENT_DISPATCHED', { shipmentId }, false);
    });
    return result;
  }
  async tracking(actor: Principal, shipmentId: string, raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion: z.union([z.string(), z.number()]).transform(String), trackingNumber: z.string().trim().min(1).max(160), carrierKey: z.string().max(60).optional() }), raw);
    return this.shipments.update(actor, shipmentId, { expectedVersion: input.expectedVersion, trackingInfo: { trackingNumber: input.trackingNumber } });
  }

  // ---------------------------------------------------------------- returns/refunds
  async refundReturn(actor: Principal, returnId: string, raw: unknown, key: string | null) {
    const input = parse(z.strictObject({ paymentId: uuid, amount: decimal, reason: z.string().trim().min(1).max(2000) }), raw);
    const row = await this.db.$transaction(async tx => { actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId); return this.returns.load(tx, actor, parse(uuid, returnId), 'COMMERCE.RETURN_VIEW') as Promise<{ orderId: string }>; });
    // Owning refund service enforces captured-minus-refunded limits and approval policy.
    return this.refunds.create(actor, row.orderId, { ...input, returnId }, key);
  }
  async returnHistory(actor: Principal, returnId: string) {
    return this.db.$transaction(async tx => {
      actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      await this.returns.load(tx, actor, parse(uuid, returnId), 'COMMERCE.RETURN_VIEW');
      const [events, refunds] = await Promise.all([tx.commerceReturnEvent.findMany({ where: { workspaceId: actor.workspaceId, returnId }, orderBy: { occurredAt: 'asc' } }),
        tx.commerceRefundBinding.findMany({ where: { workspaceId: actor.workspaceId, returnId }, orderBy: { createdAt: 'asc' } })]);
      return { returnId, events, refunds: refunds.map(r => ({ refundId: r.refundId, paymentId: r.paymentId, requestedAt: r.createdAt })) };
    });
  }

  // ---------------------------------------------------------------- public cart helpers
  private async publicCart(tx: Prisma.TransactionClient, cartToken: string) {
    const cart = await tx.commerceCart.findUnique({ where: { tokenHash: hashCartToken(cartToken) } });
    if (!cart) throw new AppError('NOT_FOUND', 'Cart was not found.', 404);
    if (cart.expiresAt <= new Date()) throw new AppError('RESOURCE_EXPIRED', 'Cart has expired.', 410);
    const store = await tx.commerceStore.findFirstOrThrow({ where: { workspaceId: cart.workspaceId, id: cart.storeId } });
    if (store.status !== 'ACTIVE') throw new AppError('NOT_FOUND', 'Store is unavailable.', 404);
    return { cart, store };
  }
  /** Server-side delivery options from configured services/rates; client totals are never trusted. */
  async deliveryQuote(cartToken: string, raw: unknown, client: string) {
    const input = parse(z.strictObject({ region: z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,10})?$/) }), raw);
    checkRateLimit(client, { scope: 'commerce.delivery-quote', limit: 60, windowMs: 60000 });
    return this.db.$transaction(async tx => {
      const { cart, store } = await this.publicCart(tx, cartToken);
      const projection = await this.carts.projection(tx, store, cart);
      const services = await tx.commerceDeliveryService.findMany({ where: { workspaceId: store.workspaceId, storeId: store.id, active: true } });
      const rates = await tx.commerceDeliveryRate.findMany({ where: { workspaceId: store.workspaceId, storeId: store.id, active: true, serviceId: { in: services.map(s => s.id) } } });
      const options = [];
      for (const service of services) {
        const c = service.conditions as { regions?: string[]; minimumSubtotal?: string; maximumSubtotal?: string };
        if (c.regions?.length && !c.regions.some(r => input.region === r || input.region.startsWith(r + '-'))) continue;
        if (c.minimumSubtotal && exact(projection.subtotal).lt(c.minimumSubtotal) || c.maximumSubtotal && exact(projection.subtotal).gt(c.maximumSubtotal)) continue;
        if (service.type === 'PICKUP') { options.push({ deliveryMethodId: service.id, type: service.type, amount: '0.000000', currency: store.defaultCurrency, estimatedDays: { min: 0, max: 0 } }); continue; }
        for (const rate of rates.filter(r => r.serviceId === service.id && r.currency === store.defaultCurrency)) {
          const rc = rate.conditions as { regions?: string[] };
          if (rc.regions?.length && !rc.regions.some(r => input.region === r || input.region.startsWith(r + '-'))) continue;
          options.push({ deliveryMethodId: service.id, rateId: rate.id, type: service.type, amount: rate.price.toFixed(6), currency: rate.currency, estimatedDays: { min: rate.estimatedDaysMin, max: rate.estimatedDaysMax } });
        }
      }
      return { cartId: cart.id, region: input.region, options, validUntil: new Date(Date.now() + 900000) };
    }, { timeout: 60000 });
  }

  // ---------------------------------------------------------------- CRM linkage
  async retrySync(actor: Principal, syncId: string) {
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'commerce:configuration'); actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      requirePermission(actor, 'COMMERCE.SYNC_RETRY');
      const row = await tx.commerceCrmSync.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, syncId) } });
      if (!row) throw new AppError('NOT_FOUND', 'Sync record was not found.', 404);
      await this.orders.load(tx, actor, row.orderId, 'COMMERCE.ORDER_MANAGE');
      if (!['FAILED', 'BLOCKED', 'RETRYABLE_FAILED'].includes(row.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Only failed synchronizations can be retried.', 409);
      const updated = await tx.commerceCrmSync.update({ where: { id: row.id }, data: { status: 'QUEUED', cycleAttempts: 0, nextAttemptAt: new Date(), errorCode: null, version: { increment: 1 } } });
      await evidence(tx, actor, 'COMMERCE_ORDER', row.orderId, 'ORDER_CRM_SYNC_RETRY_REQUESTED', { syncId: row.id });
      return { id: updated.id, status: updated.status };
    });
  }
  async syncFailures(actor: Principal) {
    return this.db.$transaction(async tx => {
      requirePermission(actor, 'COMMERCE.SYNC_RETRY');
      const rows = await tx.commerceCrmSync.findMany({ where: { workspaceId: actor.workspaceId, status: { in: ['FAILED', 'BLOCKED', 'RETRYABLE_FAILED'] } }, orderBy: { createdAt: 'desc' }, take: 100 });
      const visible = [];
      for (const row of rows) try { await this.orders.load(tx, actor, row.orderId, 'COMMERCE.ORDER_VIEW'); visible.push({ id: row.id, orderId: row.orderId, status: row.status, attempts: row.attempts, errorCode: row.errorCode, nextAttemptAt: row.nextAttemptAt }); } catch { /* hidden by scope */ }
      return visible;
    });
  }
  /** GET /crm/contacts/:id/commerce/orders — requires CRM read of the Contact and Commerce order view. */
  async contactOrders(actor: Principal, contactId: string) {
    return this.db.$transaction(async tx => {
      actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      await new CrmReferenceReadService().read(tx, actor, 'CONTACT', parse(uuid, contactId));
      requirePermission(actor, 'COMMERCE.ORDER_VIEW');
      const bindings = await tx.commerceCrmBinding.findMany({ where: { workspaceId: actor.workspaceId, entityType: 'CONTACT', targetId: contactId } });
      const out = [];
      for (const b of bindings) try {
        const order = await this.orders.load(tx, actor, b.orderId, 'COMMERCE.ORDER_VIEW');
        const deal = await tx.commerceCrmBinding.findFirst({ where: { workspaceId: actor.workspaceId, orderId: order.id, entityType: 'DEAL' } });
        out.push({ orderId: order.id, status: order.status, paymentStatus: order.paymentStatus, currency: order.currency, total: order.total.toFixed(6), dealId: deal?.targetId ?? null, createdAt: order.createdAt });
      } catch { /* order hidden by scope */ }
      return out;
    });
  }

  // ---------------------------------------------------------------- reports (derived, rebuildable)
  async report(actor: Principal, kind: 'orders' | 'revenue' | 'abandoned-carts' | 'fulfillment', raw: unknown) {
    const query = parse(z.object({ storeId: uuid.optional(), from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() }).passthrough(), raw);
    return this.db.$transaction(async tx => {
      actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId); requirePermission(actor, 'COMMERCE.ANALYTICS_READ');
      const stores = await tx.commerceStore.findMany({ where: { workspaceId: actor.workspaceId, ...(query.storeId ? { id: query.storeId } : {}) } }), ids: string[] = [];
      for (const s of stores) try { await this.orders.stores.store(tx, actor, s.id, 'COMMERCE.ANALYTICS_READ'); ids.push(s.id); } catch { /* scope */ }
      if (query.storeId && !ids.length) throw new AppError('NOT_FOUND', 'Store was not found.', 404);
      const range = { gte: query.from ? new Date(query.from) : new Date(Date.now() - 30 * 86400000), lt: query.to ? new Date(query.to) : new Date() };
      const basis = { timezone: 'UTC', dateBasis: 'order.createdAt', from: range.gte, to: range.lt, generatedAt: new Date(), version: 1, freshness: 'LIVE_FROM_SOURCE' };
      if (kind === 'abandoned-carts') {
        const carts = await tx.commerceCart.findMany({ where: { workspaceId: actor.workspaceId, storeId: { in: ids }, status: 'ABANDONED', lastActivityAt: range } });
        // Marketing eligibility depends on consent/identity, which Marketing evaluates at send time.
        return { basis, count: carts.length, byStore: ids.map(id => ({ storeId: id, count: carts.filter(c => c.storeId === id).length })), marketingEligibility: 'EVALUATED_BY_MARKETING_CONSENT' };
      }
      const orders = await tx.commerceOrder.findMany({ where: { workspaceId: actor.workspaceId, storeId: { in: ids }, createdAt: range } });
      const byCurrency = new Map<string, { orders: number; gross: Prisma.Decimal; captured: Prisma.Decimal; refunded: Prisma.Decimal; cancelled: number }>();
      for (const o of orders) {
        const acc = byCurrency.get(o.currency) ?? { orders: 0, gross: new Prisma.Decimal(0), captured: new Prisma.Decimal(0), refunded: new Prisma.Decimal(0), cancelled: 0 };
        acc.orders++; if (o.status === 'CANCELLED') acc.cancelled++; else acc.gross = acc.gross.plus(o.total);
        acc.captured = acc.captured.plus(o.paidAmount).plus(o.refundedAmount); acc.refunded = acc.refunded.plus(o.refundedAmount); byCurrency.set(o.currency, acc);
      }
      if (kind === 'orders') return { basis, totals: [...byCurrency].map(([currency, a]) => ({ currency, orders: a.orders, cancelled: a.cancelled, grossOrderValue: a.gross.toFixed(6) })),
        byStatus: Object.entries(orders.reduce<Record<string, number>>((m, o) => (m[o.status] = (m[o.status] ?? 0) + 1, m), {})).map(([status, count]) => ({ status, count })) };
      if (kind === 'revenue') {
        requirePermission(actor, 'COMMERCE.PAYMENT_VIEW');
        // paidAmount is net of refunds (Order payment projection from the Payments ledger): captured = net + refunded.
        return { basis: { ...basis, source: 'Shared Payments allocation projection' }, totals: [...byCurrency].map(([currency, a]) => ({ currency, grossOrderValue: a.gross.toFixed(6), capturedRevenue: a.captured.toFixed(6), refundedAmount: a.refunded.toFixed(6), netPaid: a.captured.minus(a.refunded).toFixed(6) })) };
      }
      const shipments = await tx.commerceShipment.findMany({ where: { workspaceId: actor.workspaceId, storeId: { in: ids }, createdAt: range } });
      const lags = shipments.filter(s => s.shippedAt).map(s => (s.shippedAt!.getTime() - s.createdAt.getTime()) / 3600000);
      return { basis, fulfillment: { orders: orders.length, fulfilled: orders.filter(o => o.fulfillmentStatus === 'FULFILLED').length, partial: orders.filter(o => o.fulfillmentStatus.startsWith('PARTIAL')).length,
        exceptions: orders.filter(o => o.fulfillmentStatus === 'EXCEPTION').length, shipments: shipments.length, averageDispatchLagHours: lags.length ? Number((lags.reduce((a, b) => a + b, 0) / lags.length).toFixed(2)) : null } };
    }, { timeout: 60000 });
  }

  // ---------------------------------------------------------------- digital goods & services
  private digitalPolicy(profile: { digitalAccessPolicy: Prisma.JsonValue } | null) {
    return (profile?.digitalAccessPolicy ?? {}) as { downloadLimit?: number; accessDays?: number; revokeOnRefund?: boolean };
  }
  async digitalFulfillment(actor: Principal, orderId: string, raw: unknown) {
    const input = parse(z.strictObject({ items: z.array(z.strictObject({ orderLineId: uuid, fileId: uuid.optional(), licenseReference: z.string().trim().min(1).max(200).optional() })).min(1).max(100) }), raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'commerce:order:' + orderId); actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      const order = await this.orders.load(tx, actor, orderId, 'COMMERCE.DIGITAL_FULFILL');
      if (order.paymentStatus !== 'PAID') throw new AppError('INVALID_STATE_TRANSITION', 'Digital delivery starts after payment eligibility.', 409);
      const profile = await tx.commerceStoreProfile.findUnique({ where: { storeId: order.storeId } }), policy = this.digitalPolicy(profile);
      const lines = (order.snapshot as { lines?: Line[] }).lines ?? [], out = [];
      for (const item of input.items) {
        const line = lines.find(l => l.itemId === item.orderLineId);
        if (!line) throw new AppError('NOT_FOUND', 'Order line was not found.', 404);
        if (line.stockable) throw new AppError('VALIDATION_FAILED', 'Stock-managed SKUs ship through fulfillment, not digital delivery.', 400, { fields: [{ field: 'items.orderLineId', reason: 'STOCK_MANAGED' }] });
        if (!item.fileId && !item.licenseReference) throw new AppError('VALIDATION_FAILED', 'A clean File or license reference is required.', 400);
        if (item.fileId) {
          const file = await tx.driveFile.findFirst({ where: { workspaceId: actor.workspaceId, id: item.fileId, trashedAt: null } });
          if (!file || !['ACTIVE', 'AVAILABLE', 'READY'].includes(file.status)) throw new AppError('NOT_FOUND', 'File is unavailable or not scan-cleared.', 404);
        }
        const row = await tx.commerceDigitalDelivery.upsert({ where: { workspaceId_orderLineId: { workspaceId: actor.workspaceId, orderLineId: item.orderLineId } },
          create: { workspaceId: actor.workspaceId, storeId: order.storeId, orderId, orderLineId: item.orderLineId, fileId: item.fileId, licenseReference: item.licenseReference, accessState: 'ACTIVE', availableAt: new Date(),
            downloadLimit: policy.downloadLimit ?? null, expiresAt: policy.accessDays ? new Date(Date.now() + policy.accessDays * 86400000) : null }, update: {} });
        out.push(row);
        await evidence(tx, actor, 'COMMERCE_ORDER', orderId, 'DIGITAL_ACCESS_GRANTED', { deliveryId: row.id, orderLineId: item.orderLineId });
      }
      return out;
    });
  }
  async customerDigitalItems(authorization: string | null, orderId: string) {
    return this.db.$transaction(async tx => {
      const order = await this.portal.ownedOrder(tx, await this.portal.subject(tx, authorization), orderId);
      const rows = await tx.commerceDigitalDelivery.findMany({ where: { workspaceId: order.workspaceId, orderId } });
      return rows.map(r => ({ id: r.id, orderLineId: r.orderLineId, accessState: r.accessState, downloadsRemaining: r.downloadLimit === null ? null : Math.max(0, r.downloadLimit - r.downloadCount), expiresAt: r.expiresAt, hasLicense: Boolean(r.licenseReference) }));
    });
  }
  async digitalToken(authorization: string | null, deliveryId: string) {
    return this.db.$transaction(async tx => {
      const subject = await this.portal.subject(tx, authorization);
      const row = await tx.commerceDigitalDelivery.findFirst({ where: { workspaceId: subject.workspaceId, id: parse(uuid, deliveryId) } });
      if (!row) throw new AppError('NOT_FOUND', 'Digital item was not found.', 404);
      await this.portal.ownedOrder(tx, subject, row.orderId);
      this.assertActive(row);
      const token = newToken('dl_');
      await tx.commerceDigitalAccessToken.create({ data: { workspaceId: row.workspaceId, deliveryId: row.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 600000) } });
      return { token, expiresIn: 600 };
    });
  }
  private assertActive(row: { accessState: string; expiresAt: Date | null; downloadLimit: number | null; downloadCount: number }) {
    if (row.accessState !== 'ACTIVE') throw new AppError('RESOURCE_EXPIRED', 'Digital access is not active.', 410);
    if (row.expiresAt && row.expiresAt <= new Date()) throw new AppError('RESOURCE_EXPIRED', 'Digital access expired.', 410);
    if (row.downloadLimit !== null && row.downloadCount >= row.downloadLimit) throw new AppError('RESOURCE_EXPIRED', 'Download limit reached.', 410);
  }
  /** Verifies token + limits on each request and returns a short-lived file delivery reference (no public object URL). */
  async download(deliveryId: string, token: string) {
    return this.db.$transaction(async tx => {
      const grant = await tx.commerceDigitalAccessToken.findUnique({ where: { tokenHash: sha256(token) } });
      if (!grant || grant.deliveryId !== parse(uuid, deliveryId)) throw new AppError('NOT_FOUND', 'Download was not found.', 404);
      if (grant.expiresAt <= new Date()) throw new AppError('RESOURCE_EXPIRED', 'Download link expired.', 410);
      await lock(tx, grant.workspaceId, 'commerce:digital:' + deliveryId);
      const row = await tx.commerceDigitalDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
      this.assertActive(row);
      await tx.commerceDigitalDelivery.update({ where: { id: row.id }, data: { downloadCount: { increment: 1 } } });
      await tx.commerceDigitalAccessToken.update({ where: { id: grant.id }, data: { expiresAt: new Date() } });
      await systemEvent(tx, row.workspaceId, 'COMMERCE_ORDER', row.orderId, 'DIGITAL_ASSET_DOWNLOADED', { deliveryId: row.id });
      return row.fileId ? { fileId: row.fileId, delivery: 'FILES_SIGNED_DELIVERY', note: 'Stream through the Files delivery grant service.' } : { licenseReference: row.licenseReference };
    });
  }
  /** Refund policy hook: revokes future digital access only when configured; delivery audit is preserved. */
  async revokeDigitalForOrder(actor: Principal, orderId: string, raw: unknown) {
    const input = parse(z.strictObject({ reason: z.string().trim().min(1).max(500) }), raw);
    return this.db.$transaction(async tx => {
      actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      const order = await this.orders.load(tx, actor, orderId, 'COMMERCE.DIGITAL_FULFILL');
      const policy = this.digitalPolicy(await tx.commerceStoreProfile.findUnique({ where: { storeId: order.storeId } }));
      if (policy.revokeOnRefund === false) throw new AppError('POLICY_NOT_CONFIGURED', 'Store policy keeps digital access after refund.', 409);
      if (!['REFUNDED', 'PARTIALLY_REFUNDED'].includes(order.paymentStatus)) throw new AppError('INVALID_STATE_TRANSITION', 'Access revocation follows a refund.', 409);
      const result = await tx.commerceDigitalDelivery.updateMany({ where: { workspaceId: actor.workspaceId, orderId, accessState: 'ACTIVE' }, data: { accessState: 'REVOKED', revokedAt: new Date() } });
      await evidence(tx, actor, 'COMMERCE_ORDER', orderId, 'DIGITAL_ACCESS_REVOKED', { count: result.count, reason: input.reason });
      return { revoked: result.count };
    });
  }
  async completeService(actor: Principal, orderLineId: string, raw: unknown) {
    const input = parse(z.strictObject({ orderId: uuid, scheduledAt: z.iso.datetime({ offset: true }).optional(), outcome: z.enum(['DELIVERED', 'CANCELLED']).default('DELIVERED') }), raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'commerce:order:' + input.orderId); actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      const order = await this.orders.load(tx, actor, input.orderId, 'COMMERCE.FULFILLMENT_MANAGE');
      const line = ((order.snapshot as { lines?: Line[] }).lines ?? []).find(l => l.itemId === parse(uuid, orderLineId));
      if (!line) throw new AppError('NOT_FOUND', 'Order line was not found.', 404);
      if (line.stockable) throw new AppError('VALIDATION_FAILED', 'Service completion applies to non-stock service lines.', 400);
      const existing = await tx.commerceServiceFulfillment.findUnique({ where: { workspaceId_orderLineId: { workspaceId: actor.workspaceId, orderLineId } } });
      if (existing && existing.status !== 'PENDING') return existing;
      const row = await tx.commerceServiceFulfillment.upsert({ where: { workspaceId_orderLineId: { workspaceId: actor.workspaceId, orderLineId } },
        create: { workspaceId: actor.workspaceId, orderId: input.orderId, orderLineId, scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null, status: input.outcome, completedAt: new Date(), completedByUserId: actor.userId },
        update: { status: input.outcome, completedAt: new Date(), completedByUserId: actor.userId } });
      await evidence(tx, actor, 'COMMERCE_ORDER', input.orderId, input.outcome === 'DELIVERED' ? 'SERVICE_FULFILLED' : 'SERVICE_CANCELLED', { orderLineId });
      return row;
    });
  }
}
