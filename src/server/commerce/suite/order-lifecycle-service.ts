import { Prisma, type CommerceOrder, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError, isAppError } from '../../errors';
import { parse, uuid } from '../../process-platform/dto';
import { command, evidence, lock, requirePermission, resolvePrincipal, type Principal, type Tx } from '../../process-platform/context';
import { exact } from '../../inventory/decimal';
import { InventoryReservationService } from '../../inventory/reservation-service';
import { InventoryStockService } from '../../inventory/stock-service';
import { CommerceOrderService } from '../order-service';
import { assertCommerceVersion, commerceVersion } from '../dto';

/** Protected semantic states (spec OnlineStore-Commerce/05). Existing persisted `NEW` is the protected PENDING_PAYMENT state. */
export const PROTECTED_STATUSES = ['NEW', 'CONFIRMED', 'PROCESSING', 'COMPLETED', 'CANCELLED'] as const;
const statusAlias: Record<string, string> = { PENDING_PAYMENT: 'NEW' };
const machine: Record<string, string[]> = { NEW: ['CONFIRMED'], CONFIRMED: ['PROCESSING'], PROCESSING: ['COMPLETED'], COMPLETED: [], CANCELLED: [] };
type Line = { itemId: string; productId: string; variantId: string | null; inventoryKey: string; name: string; quantity: string; unitPrice: string; stockable: boolean; total: string; gross?: string; discount?: string; tax?: string; subtotal?: string };

export class CommerceOrderLifecycleService {
  constructor(private readonly db: PrismaClient, readonly orders = new CommerceOrderService(db), readonly reservations = new InventoryReservationService(db), readonly stock = new InventoryStockService(db)) {}

  async statuses(actor: Principal, raw: unknown) {
    const query = parse(z.object({ storeId: uuid }), raw);
    return this.db.$transaction(async tx => {
      await this.orders.stores.store(tx, actor, query.storeId, 'COMMERCE.ORDER_VIEW');
      const custom = await tx.commerceOrderStatusDefinition.findMany({ where: { workspaceId: actor.workspaceId, storeId: query.storeId }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] });
      return [...PROTECTED_STATUSES.map((code, i) => ({ code, semantic: code === 'NEW' ? 'PENDING_PAYMENT' : code, name: code, sortOrder: i * 10, isProtected: true })), ...custom];
    });
  }
  async createStatus(actor: Principal, raw: unknown) {
    const input = parse(z.strictObject({ storeId: uuid, code: z.string().regex(/^[A-Z][A-Z0-9_]{1,40}$/), name: z.string().trim().min(1).max(80), sortOrder: z.number().int().min(0).max(10000).default(100) }), raw);
    if ((PROTECTED_STATUSES as readonly string[]).includes(input.code) || input.code === 'PENDING_PAYMENT') throw new AppError('VALIDATION_FAILED', 'Protected status codes cannot be redefined.', 400, { fields: [{ field: 'code', reason: 'PROTECTED' }] });
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'commerce:configuration'); actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      await this.orders.stores.store(tx, actor, input.storeId, 'COMMERCE.STATUS_MANAGE');
      const row = await tx.commerceOrderStatusDefinition.create({ data: { workspaceId: actor.workspaceId, ...input } });
      await evidence(tx, actor, 'COMMERCE_STORE', input.storeId, 'ORDER_STATUS_DEFINED', { code: row.code }); return row;
    });
  }

  /** Controlled transition: protected edges or custom intermediate processing status. Idempotent by key + expectedVersion. */
  async transition(actor: Principal, orderId: string, raw: unknown, key: string | null) {
    const input = parse(z.strictObject({ expectedVersion: commerceVersion, to: z.string().regex(/^[A-Z][A-Z0-9_]{1,40}$/), reason: z.string().trim().max(500).optional() }), raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'commerce:order:' + orderId); actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      requirePermission(actor, 'COMMERCE.ORDER_TRANSITION');
      return command(tx, actor, 'commerce.order.transition:' + orderId, key ?? 'v' + input.expectedVersion + ':' + input.to, input, async () => {
        const order = await this.orders.load(tx, actor, orderId, 'COMMERCE.ORDER_TRANSITION'); assertCommerceVersion(order.version, input.expectedVersion);
        const to = statusAlias[input.to] ?? input.to;
        if (to === 'CANCELLED') throw new AppError('INVALID_STATE_TRANSITION', 'Use the cancel command; captured funds route through the refund policy.', 409);
        let data: Prisma.CommerceOrderUpdateInput;
        if ((PROTECTED_STATUSES as readonly string[]).includes(to)) {
          if (!(machine[order.status] ?? []).includes(to)) throw new AppError('INVALID_STATE_TRANSITION', `Cannot move from ${order.status} to ${to}.`, 409);
          if (to === 'CONFIRMED' && order.paymentStatus === 'UNPAID' && !(order.snapshot as { paymentMethodId?: string }).paymentMethodId?.match(/^(OFFLINE|COD)$/))
            throw new AppError('INVALID_STATE_TRANSITION', 'Order requires permitted funding before confirmation.', 409);
          if (to === 'COMPLETED' && (order.fulfillmentStatus !== 'FULFILLED' || order.paymentStatus !== 'PAID')) throw new AppError('INVALID_STATE_TRANSITION', 'Completion requires paid and fulfilled order.', 409);
          data = { status: to, processingStatus: null };
        } else {
          const custom = await tx.commerceOrderStatusDefinition.findUnique({ where: { storeId_code: { storeId: order.storeId, code: to } } });
          if (!custom || custom.workspaceId !== actor.workspaceId) throw new AppError('VALIDATION_FAILED', 'Unknown order status.', 400, { fields: [{ field: 'to', reason: 'UNKNOWN_STATUS' }] });
          if (!['CONFIRMED', 'PROCESSING'].includes(order.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Intermediate statuses apply to confirmed or processing orders.', 409);
          data = { processingStatus: to };
        }
        const updated = await tx.commerceOrder.update({ where: { id: orderId }, data: { ...data, version: { increment: 1 } } });
        await tx.commerceOrderHistory.create({ data: { workspaceId: actor.workspaceId, storeId: order.storeId, orderId, actorUserId: actor.userId, action: 'STATUS_CHANGED', details: { from: order.processingStatus ?? order.status, to, reason: input.reason ?? null } } });
        await evidence(tx, actor, 'COMMERCE_ORDER', orderId, 'ORDER_STATUS_CHANGED', { from: order.status, to, version: updated.version.toString() });
        if (to === 'COMPLETED') await evidence(tx, actor, 'COMMERCE_ORDER', orderId, 'ORDER_COMPLETED', {});
        return { id: updated.id, status: updated.status, processingStatus: updated.processingStatus, version: updated.version.toString() };
      });
    }, { timeout: 60000 });
  }

  /** Amend unfulfilled quantities only; financial, shipped and invoiced values are immutable (append-only history). */
  async amend(actor: Principal, orderId: string, raw: unknown, key: string | null) {
    const input = parse(z.strictObject({ expectedVersion: commerceVersion, reason: z.string().trim().min(1).max(500), preview: z.boolean().default(false),
      lines: z.array(z.strictObject({ orderLineId: uuid, quantity: z.string().regex(/^\d{1,12}(?:\.\d{1,6})?$/) })).min(1).max(100) }), raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'commerce:configuration'); await lock(tx, actor.workspaceId, 'commerce:order:' + orderId); actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      const run = async () => {
        const order = await this.orders.load(tx, actor, orderId, 'COMMERCE.ORDER_AMEND'); assertCommerceVersion(order.version, input.expectedVersion);
        if (['CANCELLED', 'COMPLETED'].includes(order.status) || order.archivedAt) throw new AppError('INVALID_STATE_TRANSITION', 'Order is closed.', 409);
        if (order.paymentStatus !== 'UNPAID' || order.paidAmount.gt(0)) throw new AppError('INVALID_STATE_TRANSITION', 'Captured financial values change only through refund/adjustment services.', 409);
        const snapshot = order.snapshot as { lines: Line[]; subtotal: string; discount: string; tax: string; total: string; promotions?: unknown[] };
        const shippedItems = await tx.commerceShipmentItem.findMany({ where: { workspaceId: actor.workspaceId, orderId, shipmentId: { in: (await tx.commerceShipment.findMany({ where: { workspaceId: actor.workspaceId, orderId, status: { not: 'CANCELLED' } }, select: { id: true } })).map(s => s.id) } } });
        const after = snapshot.lines.map(line => ({ ...line }));
        for (const change of input.lines) {
          const line = after.find(l => l.itemId === change.orderLineId);
          if (!line) throw new AppError('NOT_FOUND', 'Order line was not found.', 404);
          const allocated = shippedItems.filter(i => i.orderLineId === line.itemId).reduce((s, i) => s.plus(i.quantity), exact(0));
          if (exact(change.quantity).lt(allocated)) throw new AppError('INVALID_STATE_TRANSITION', 'Shipped or allocated quantities cannot be reduced.', 409, { orderLineId: line.itemId });
          if (exact(change.quantity).gt(line.quantity)) throw new AppError('VALIDATION_FAILED', 'Amendment can reduce unfulfilled quantities; add items through a new order.', 400, { fields: [{ field: 'lines.quantity', reason: 'INCREASE_NOT_SUPPORTED' }] });
          const ratio = exact(change.quantity).div(line.quantity);
          for (const k of ['gross', 'discount', 'subtotal', 'tax', 'total'] as const) if (line[k] !== undefined) line[k] = exact(line[k]!).times(ratio).toDecimalPlaces(2).toFixed(6);
          line.quantity = exact(change.quantity).toFixed(6);
        }
        const sum = (k: 'subtotal' | 'discount' | 'tax' | 'total') => after.reduce((s, l) => s.plus(l[k] ?? '0'), exact(0)).toFixed(6);
        const afterSnapshot = { ...snapshot, lines: after, subtotal: sum('subtotal'), discount: sum('discount'), tax: sum('tax'), total: sum('total') };
        if (input.preview) return { preview: true, before: { total: order.total.toFixed(6), lines: snapshot.lines.map(l => ({ id: l.itemId, quantity: l.quantity })) }, after: { total: afterSnapshot.total, lines: after.map(l => ({ id: l.itemId, quantity: l.quantity })) } };
        // Stock deltas go through Inventory; any failure rolls back the whole amendment.
        const store = await this.orders.stores.store(tx, actor, order.storeId, 'COMMERCE.ORDER_AMEND'), inventoryUserId = (store.settings as { inventoryPrincipalUserId?: string }).inventoryPrincipalUserId;
        for (const change of input.lines) {
          const before = snapshot.lines.find(l => l.itemId === change.orderLineId)!, delta = exact(before.quantity).minus(change.quantity);
          if (!before.stockable || delta.lte(0)) continue;
          const links = await tx.commerceOrderLineReservation.findMany({ where: { workspaceId: actor.workspaceId, orderId, orderLineId: change.orderLineId } });
          if (!links.length) continue;
          if (!inventoryUserId) throw new AppError('DEPENDENCY_UNAVAILABLE', 'Inventory service principal is unavailable.', 503);
          const inventoryActor = await resolvePrincipal(tx, actor.workspaceId, inventoryUserId);
          for (const link of links) {
            const reservation = await tx.inventoryReservation.findFirstOrThrow({ where: { workspaceId: actor.workspaceId, id: link.reservationId } });
            if (!['ACTIVE', 'PARTIALLY_FULFILLED'].includes(reservation.status)) continue;
            const newQty = exact(reservation.quantity).minus(delta);
            if (newQty.lte(exact(reservation.fulfilledQuantity).plus(reservation.releasedQuantity))) await this.reservations.releaseInTransaction(tx, inventoryActor, reservation.id, { reason: 'Order amendment' }, 'amend:' + orderId + ':' + reservation.id + ':' + order.version);
            // Partial reductions keep the reservation; surplus is released when shipments close the line.
          }
        }
        const updated = await tx.commerceOrder.update({ where: { id: orderId }, data: { snapshot: afterSnapshot as unknown as Prisma.InputJsonValue, total: afterSnapshot.total, version: { increment: 1 } } });
        await tx.commerceOrderAmendment.create({ data: { workspaceId: actor.workspaceId, orderId, beforeSnapshot: snapshot as unknown as Prisma.InputJsonValue, afterSnapshot: afterSnapshot as unknown as Prisma.InputJsonValue, reason: input.reason, actorUserId: actor.userId } });
        await tx.commerceOrderHistory.create({ data: { workspaceId: actor.workspaceId, storeId: order.storeId, orderId, actorUserId: actor.userId, action: 'AMENDED', details: { reason: input.reason, totalBefore: order.total.toFixed(6), totalAfter: afterSnapshot.total } } });
        await evidence(tx, actor, 'COMMERCE_ORDER', orderId, 'ORDER_AMENDED', { totalBefore: order.total.toFixed(6), totalAfter: afterSnapshot.total, version: updated.version.toString() });
        return { id: updated.id, total: updated.total.toFixed(6), version: updated.version.toString() };
      };
      return input.preview ? run() : command(tx, actor, 'commerce.order.amend:' + orderId, key ?? 'v' + input.expectedVersion, input, run);
    }, { timeout: 60000 });
  }

  async availability(actor: Principal, orderId: string) {
    return this.db.$transaction(async tx => {
      const order = await this.orders.load(tx, actor, orderId, 'COMMERCE.ORDER_VIEW');
      const lines = (order.snapshot as { lines?: Line[] }).lines ?? [];
      const links = await tx.commerceOrderLineReservation.findMany({ where: { workspaceId: actor.workspaceId, orderId } });
      const reservations = await tx.inventoryReservation.findMany({ where: { workspaceId: actor.workspaceId, id: { in: links.map(l => l.reservationId) } } });
      const backorders = await tx.commerceBackorderLine.findMany({ where: { workspaceId: actor.workspaceId, orderId } });
      const store = await this.orders.stores.store(tx, actor, order.storeId, 'COMMERCE.ORDER_VIEW');
      const out = [];
      for (const line of lines) {
        const own = links.filter(l => l.orderLineId === line.itemId).map(l => reservations.find(r => r.id === l.reservationId)!).filter(Boolean);
        const active = own.filter(r => ['ACTIVE', 'PARTIALLY_FULFILLED'].includes(r.status)).reduce((s, r) => s.plus(exact(r.quantity).minus(r.fulfilledQuantity).minus(r.releasedQuantity)), exact(0));
        const consumed = own.reduce((s, r) => s.plus(r.fulfilledQuantity), exact(0));
        const sellable = line.stockable ? await this.stock.publicSellability(tx, actor.workspaceId, line.inventoryKey, store.defaultWarehouseId) : { available: true, backorderAllowed: false };
        out.push({ orderLineId: line.itemId, name: line.name, quantity: line.quantity, stockable: line.stockable, reserved: active.toFixed(6), consumed: consumed.toFixed(6),
          reservationStates: own.map(r => ({ id: r.id, status: r.status, expiresAt: r.expiresAt })), backorder: backorders.find(b => b.orderLineId === line.itemId) ?? null, currentlyAvailable: sellable.available });
      }
      return { orderId, fulfillmentStatus: order.fulfillmentStatus, lines: out };
    });
  }

  /** Re-reserve missing quantities (e.g. after expiry). Never touches the inventory ledger directly. */
  async refreshReservations(actor: Principal, orderId: string, key: string | null) {
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'commerce:configuration'); await lock(tx, actor.workspaceId, 'commerce:order:' + orderId); actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      requirePermission(actor, 'COMMERCE.FULFILLMENT_MANAGE');
      return command(tx, actor, 'commerce.order.reservations.refresh:' + orderId, key, {}, async () => {
        const order = await this.orders.load(tx, actor, orderId, 'COMMERCE.FULFILLMENT_MANAGE');
        const result = await this.reReserve(tx, order);
        await evidence(tx, actor, 'COMMERCE_ORDER', orderId, result.missing.length ? 'ORDER_STOCK_RESERVATION_INCOMPLETE' : 'ORDER_STOCK_RESERVED', { reserved: result.reserved.length, missing: result.missing.length });
        return result;
      });
    }, { timeout: 60000 });
  }
  async reReserve(tx: Tx, order: CommerceOrder) {
    if (['CANCELLED', 'COMPLETED'].includes(order.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Order is closed.', 409);
    const store = await tx.commerceStore.findFirstOrThrow({ where: { workspaceId: order.workspaceId, id: order.storeId } });
    const userId = (store.settings as { inventoryPrincipalUserId?: string }).inventoryPrincipalUserId;
    if (!userId) throw new AppError('DEPENDENCY_UNAVAILABLE', 'Inventory service principal is unavailable.', 503);
    const inventoryActor = await resolvePrincipal(tx, order.workspaceId, userId);
    const lines = ((order.snapshot as { lines?: Line[] }).lines ?? []).filter(l => l.stockable);
    const reserved: string[] = [], missing: { orderLineId: string; quantity: string }[] = [];
    for (const line of lines.sort((a, b) => a.inventoryKey.localeCompare(b.inventoryKey))) {
      const links = await tx.commerceOrderLineReservation.findMany({ where: { workspaceId: order.workspaceId, orderId: order.id, orderLineId: line.itemId } });
      const rows = await tx.inventoryReservation.findMany({ where: { workspaceId: order.workspaceId, id: { in: links.map(l => l.reservationId) } } });
      const covered = rows.reduce((s, r) => s.plus(['ACTIVE', 'PARTIALLY_FULFILLED'].includes(r.status) ? exact(r.quantity).minus(r.releasedQuantity) : r.fulfilledQuantity), exact(0));
      const need = exact(line.quantity).minus(covered);
      if (need.lte(0)) continue;
      try {
        const reservation = await this.reservations.createInTransaction(tx, inventoryActor, { sourceType: 'ORDER', sourceId: order.id, productId: line.productId, variantId: line.variantId ?? undefined, quantity: need.toFixed(6), warehouseId: store.defaultWarehouseId ?? undefined }, 'rereserve:' + order.id + ':' + line.itemId + ':' + links.length) as { id: string };
        await tx.commerceOrderLineReservation.create({ data: { workspaceId: order.workspaceId, storeId: order.storeId, orderId: order.id, orderLineId: line.itemId, reservationId: reservation.id, inventoryKey: line.inventoryKey, quantity: need.toFixed(6) } });
        reserved.push(line.itemId);
      } catch (error) { if (!isAppError(error)) throw error; missing.push({ orderLineId: line.itemId, quantity: need.toFixed(6) }); }
    }
    return { orderId: order.id, reserved, missing };
  }

  /**
   * Late payment after reservation expiry: the captured payment is preserved; Commerce tries a permitted re-reservation,
   * otherwise marks fulfillmentStatus EXCEPTION and opens a fulfillment exception (backorder/refund decision follows).
   */
  static async onOrderPaid(tx: Tx, actor: Principal, order: CommerceOrder, providerEventId: string) {
    const lines = ((order.snapshot as { lines?: Line[] }).lines ?? []).filter(l => l.stockable);
    if (!lines.length) return;
    const store = await tx.commerceStore.findFirst({ where: { workspaceId: order.workspaceId, id: order.storeId } });
    if (store?.reservationTiming === 'PAYMENT_PAID') return; // reservations are created after payment by the paid-reservation worker
    const service = new CommerceOrderLifecycleService(undefined as unknown as PrismaClient);
    let missing: { orderLineId: string; quantity: string }[] = [];
    try { missing = (await service.reReserve(tx, order)).missing; } catch (error) { if (!isAppError(error)) throw error; missing = lines.map(l => ({ orderLineId: l.itemId, quantity: l.quantity })); }
    if (!missing.length) return;
    await tx.commerceOrder.update({ where: { id: order.id }, data: { fulfillmentStatus: 'EXCEPTION', version: { increment: 1 } } });
    await tx.commerceFulfillmentException.create({ data: { workspaceId: order.workspaceId, orderId: order.id, paymentRef: providerEventId, reason: 'PAID_WITHOUT_AVAILABLE_STOCK' } });
    await tx.commerceOrderHistory.create({ data: { workspaceId: order.workspaceId, storeId: order.storeId, orderId: order.id, actorUserId: actor.userId, action: 'FULFILLMENT_EXCEPTION', details: { missing } } });
    await evidence(tx, actor, 'COMMERCE_ORDER', order.id, 'PAYMENT_STOCK_EXCEPTION', { missingLines: missing.length });
  }

  /** Resolve a fulfillment exception: BACKORDER (explicit waiting line), REALLOCATED (after refresh) or REFUND (finance follows refund policy). */
  async backorderAction(actor: Principal, orderId: string, raw: unknown) {
    const input = parse(z.strictObject({ action: z.enum(['BACKORDER', 'REALLOCATE', 'REFUND', 'CANCEL_BACKORDER']), orderLineId: uuid.optional(), expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), reason: z.string().trim().min(1).max(500) }), raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'commerce:configuration'); await lock(tx, actor.workspaceId, 'commerce:order:' + orderId); actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      const order = await this.orders.load(tx, actor, orderId, 'COMMERCE.FULFILLMENT_MANAGE');
      const profile = await tx.commerceStoreProfile.findUnique({ where: { storeId: order.storeId } });
      const lines = ((order.snapshot as { lines?: Line[] }).lines ?? []).filter(l => l.stockable && (!input.orderLineId || l.itemId === input.orderLineId));
      if (input.action === 'BACKORDER') {
        if (!profile?.backordersEnabled) throw new AppError('POLICY_NOT_CONFIGURED', 'Backorders are not enabled for this store.', 409);
        const { missing } = await this.reReserve(tx, order);
        for (const m of missing.filter(m => lines.some(l => l.itemId === m.orderLineId)))
          await tx.commerceBackorderLine.upsert({ where: { workspaceId_orderLineId: { workspaceId: actor.workspaceId, orderLineId: m.orderLineId } }, create: { workspaceId: actor.workspaceId, orderId, orderLineId: m.orderLineId, remainingQty: m.quantity, expectedDate: input.expectedDate ? new Date(input.expectedDate + 'T00:00:00Z') : null }, update: { remainingQty: m.quantity, state: 'WAITING' } });
        await evidence(tx, actor, 'COMMERCE_ORDER', orderId, 'ORDER_BACKORDERED', { lines: missing.length });
      } else if (input.action === 'REALLOCATE') {
        const { missing } = await this.reReserve(tx, order);
        if (missing.length) throw new AppError('INSUFFICIENT_STOCK', 'Stock is still unavailable.', 409, { missing });
        await tx.commerceBackorderLine.updateMany({ where: { workspaceId: actor.workspaceId, orderId, state: 'WAITING' }, data: { state: 'ALLOCATED' } });
        if (order.fulfillmentStatus === 'EXCEPTION') await tx.commerceOrder.update({ where: { id: orderId }, data: { fulfillmentStatus: 'UNFULFILLED', version: { increment: 1 } } });
      } else if (input.action === 'CANCEL_BACKORDER') {
        await tx.commerceBackorderLine.updateMany({ where: { workspaceId: actor.workspaceId, orderId, state: 'WAITING', ...(input.orderLineId ? { orderLineId: input.orderLineId } : {}) }, data: { state: 'CANCELLED' } });
      }
      await tx.commerceFulfillmentException.updateMany({ where: { workspaceId: actor.workspaceId, orderId, status: 'OPEN' }, data: { status: 'RESOLVED', resolution: input.action, resolvedAt: new Date() } });
      await tx.commerceOrderHistory.create({ data: { workspaceId: actor.workspaceId, storeId: order.storeId, orderId, actorUserId: actor.userId, action: 'FULFILLMENT_EXCEPTION_' + input.action, details: { reason: input.reason } } });
      await evidence(tx, actor, 'COMMERCE_ORDER', orderId, 'FULFILLMENT_EXCEPTION_RESOLVED', { action: input.action });
      return { orderId, action: input.action, nextStep: input.action === 'REFUND' ? 'Create a refund through POST /commerce/orders/:id/refunds; captured funds are preserved until processed.' : null };
    }, { timeout: 60000 });
  }
}
