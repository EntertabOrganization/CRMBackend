import { Prisma, type PrismaClient, type CommerceShipment, type CommerceOrder } from '@prisma/client';
import { z } from 'zod';
import { AppError, isAppError } from '../errors';
import { command, evidence, lock, resolvePrincipal, type Principal, type Tx } from '../process-platform/context';
import { requirePermission } from '../process-platform/context';
import { ownerVisible } from '../process-platform/owner-scope';
import { decimal, parse, uuid } from '../process-platform/dto';
import { exact } from '../inventory/decimal';
import { fitsCurrency, toScaled } from '../catalog/money';
import { InventoryDocumentService } from '../inventory/document-service';
import { InventoryReservationService } from '../inventory/reservation-service';
import { InventoryWarehouseService } from '../inventory/warehouse-service';
import { OrderPaymentCoverage } from '../commercial/order-payment-coverage';
import { CommerceOrderService } from './order-service';
import { assertCommerceVersion, commerceVersion, commerceCurrency } from './dto';
import { cartQuantity } from './cart-service';

const preDispatch = ['NEW','PROCESSING','READY'];
const conditions = z.strictObject({ regions: z.array(z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,10})?$/)).max(250).optional(),minimumSubtotal: decimal.optional(),maximumSubtotal: decimal.optional() })
  .refine(v => !v.minimumSubtotal || !v.maximumSubtotal || exact(v.minimumSubtotal).lte(v.maximumSubtotal));
const rate = z.strictObject({ price: decimal,currency: commerceCurrency,conditions: conditions.default({}),estimatedDaysMin: z.number().int().min(0).max(365),estimatedDaysMax: z.number().int().min(0).max(365) });
type OrderLine = { itemId: string;productId: string;variantId: string|null;inventoryKey: string;quantity: string;stockable: boolean;name: string };
export function shipmentOrderLines(order: CommerceOrder) { return (order.snapshot as { lines: OrderLine[] }).lines; }

export class CommerceShipmentService {
  readonly documents: InventoryDocumentService;
  readonly reservations: InventoryReservationService;
  readonly warehouses: InventoryWarehouseService;
  constructor(private readonly db: PrismaClient,readonly orders = new CommerceOrderService(db),readonly payments = new OrderPaymentCoverage()) {
    this.warehouses = new InventoryWarehouseService(db);
    this.documents = new InventoryDocumentService(db,this.warehouses);
    this.reservations = new InventoryReservationService(db,this.warehouses,this.documents.sources);
    this.documents.setReservationPort(this.reservations); this.reservations.setDocumentAuthority(this.documents);
  }
  private async inventoryActor(tx: Tx,actor: Principal,storeId: string) {
    const store = await tx.commerceStore.findFirstOrThrow({ where: { workspaceId: actor.workspaceId,id: storeId } });
    const id = (store.settings as { inventoryPrincipalUserId?: string }).inventoryPrincipalUserId;
    if (!id) throw new AppError('SHIPMENT_INVENTORY_POST_FAILED','Inventory service principal is not configured.',409);
    return resolvePrincipal(tx,actor.workspaceId,id);
  }
  private async service(tx: Tx,actor: Principal,id: string,storeId: string) {
    const row = await tx.commerceDeliveryService.findFirst({ where: { workspaceId: actor.workspaceId,storeId,id,active: true } });
    if (!row) throw new AppError('SHIPMENT_INVALID_STATE','Delivery service is unavailable.',404); return row;
  }
  async deliveryServices(actor: Principal,storeId: string,raw?: unknown) {
    parse(uuid,storeId);
    if (raw===undefined) return this.db.$transaction(async tx => {
      await this.orders.stores.store(tx,actor,storeId,'COMMERCE.DELIVERY_MANAGE');
      const rows = await tx.commerceDeliveryService.findMany({ where: { workspaceId: actor.workspaceId,storeId },orderBy: { id: 'asc' } });
      return Promise.all(rows.map(async row => ({ ...row,rates: await tx.commerceDeliveryRate.findMany({ where: { workspaceId: actor.workspaceId,storeId,serviceId: row.id },orderBy: { id: 'asc' } }) })));
    });
    const input = parse(z.strictObject({ type: z.enum(['COURIER','PICKUP','POSTAL','SAME_DAY','THIRD_PARTY','DIGITAL','CUSTOM']),conditions: conditions.default({}),rates: z.array(rate).min(1).max(100),providerConnectionId: uuid.optional() }),raw);
    if (input.rates.some(r => r.estimatedDaysMin>r.estimatedDaysMax || !fitsCurrency(toScaled(r.price)!,r.currency))) throw new AppError('INVALID_ARGUMENT','Delivery rate precision or estimate is invalid.',400);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'commerce:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const store = await this.orders.stores.store(tx,actor,storeId,'COMMERCE.DELIVERY_MANAGE');
      if (input.rates.some(r => r.currency!==store.defaultCurrency)) throw new AppError('INVALID_ARGUMENT','Delivery rates must use the Store currency.',400);
      if (input.providerConnectionId) {
        requirePermission(actor,'INTEGRATION.CONNECTION_USE');
        const connection = await tx.integrationOutboundConnection.findFirst({ where: { workspaceId: actor.workspaceId,id: input.providerConnectionId,isActive: true } });
        if (!connection || !await ownerVisible(tx,actor,connection.createdByUserId,'INTEGRATION.CONNECTION_USE')) throw new AppError('SHIPMENT_INVALID_STATE','Provider connection is unavailable.',404);
      }
      const row = await tx.commerceDeliveryService.create({ data: { workspaceId: actor.workspaceId,storeId,type: input.type,conditions: input.conditions,providerConnectionId: input.providerConnectionId } });
      await tx.commerceDeliveryRate.createMany({ data: input.rates.map(r => ({ workspaceId: actor.workspaceId,storeId,serviceId: row.id,...r })) });
      await evidence(tx,actor,'COMMERCE_STORE',storeId,'DELIVERY_SERVICE_CREATED',{ deliveryServiceId: row.id,type: row.type }); return row;
    });
  }
  async load(tx: Tx,actor: Principal,id: string,permission: string) {
    parse(uuid,id);
    const row = await tx.commerceShipment.findFirst({ where: { workspaceId: actor.workspaceId,id } });
    if (!row) throw new AppError('SHIPMENT_NOT_FOUND','Shipment was not found.',404);
    await this.orders.load(tx,actor,row.orderId,permission); await this.warehouses.warehouse(tx,actor,row.warehouseId,'INVENTORY.WAREHOUSE_READ'); return row;
  }
  private async projection(tx: Tx,row: CommerceShipment) {
    return { ...row,items: await tx.commerceShipmentItem.findMany({ where: { workspaceId: row.workspaceId,shipmentId: row.id },orderBy: { orderLineId: 'asc' } }),
      events: await tx.commerceShipmentEvent.findMany({ where: { workspaceId: row.workspaceId,shipmentId: row.id },orderBy: [{ occurredAt: 'asc' },{ id: 'asc' }] }) };
  }
  async list(actor: Principal,orderId: string) {
    return this.db.$transaction(async tx => {
      await this.orders.load(tx,actor,orderId,'COMMERCE.SHIPMENT_VIEW');
      const rows = await tx.commerceShipment.findMany({ where: { workspaceId: actor.workspaceId,orderId },orderBy: { createdAt: 'asc' } }),visible = [];
      for (const row of rows) {
        try { await this.warehouses.warehouse(tx,actor,row.warehouseId,'INVENTORY.WAREHOUSE_READ'); visible.push(await this.projection(tx,row)); }
        catch (error) { if (!isAppError(error) || ![403,404].includes(error.status)) throw error; }
      }
      return visible;
    });
  }
  async get(actor: Principal,id: string) { return this.db.$transaction(async tx => this.projection(tx,await this.load(tx,actor,id,'COMMERCE.SHIPMENT_VIEW'))); }
  private openOrder(order: CommerceOrder) {
    if (order.archivedAt || !['NEW','CONFIRMED','PROCESSING'].includes(order.status)) throw new AppError('SHIPMENT_INVALID_STATE','Order cannot be fulfilled.',409);
  }
  private async event(tx: Tx,actor: Principal,row: CommerceShipment,action: string,details: Prisma.InputJsonObject = {}) {
    await tx.commerceShipmentEvent.create({ data: { workspaceId: actor.workspaceId,storeId: row.storeId,shipmentId: row.id,actorUserId: actor.userId,action,evidence: details } });
    await evidence(tx,actor,'COMMERCE_SHIPMENT',row.id,'SHIPMENT_'+action,{ orderId: row.orderId,version: row.version.toString(),...details });
  }
  async create(actor: Principal,orderId: string,raw: unknown,key: string|null) {
    const input = parse(z.strictObject({ warehouseId: uuid,deliveryServiceId: uuid,items: z.array(z.strictObject({ orderLineId: uuid,quantity: cartQuantity })).min(1).max(100).refine(v => new Set(v.map(r => r.orderLineId)).size===v.length) }),raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'commerce:configuration'); await lock(tx,actor.workspaceId,'commerce:order:'+orderId);
      actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const order = await this.orders.load(tx,actor,orderId,'COMMERCE.SHIPMENT_MANAGE'); this.openOrder(order);
      await this.warehouses.warehouse(tx,actor,input.warehouseId,'INVENTORY.WAREHOUSE_READ',true);
      const service = await this.service(tx,actor,input.deliveryServiceId,order.storeId);
      const policy = parse(conditions,service.conditions),snapshot = order.snapshot as { address: { region: string };subtotal: string };
      if (policy.regions?.length && !policy.regions.some(region => snapshot.address.region===region || snapshot.address.region.startsWith(region+'-'))
        || policy.minimumSubtotal && exact(snapshot.subtotal).lt(policy.minimumSubtotal) || policy.maximumSubtotal && exact(snapshot.subtotal).gt(policy.maximumSubtotal))
        throw new AppError('SHIPMENT_INVALID_STATE','Delivery service is not eligible for this Order.',422);
      return command(tx,actor,'COMMERCE.SHIPMENT_CREATE:'+orderId,key,input,async () => {
        const lines = shipmentOrderLines(order),active = await tx.commerceShipment.findMany({ where: { workspaceId: actor.workspaceId,orderId,status: { not: 'CANCELLED' } },select: { id: true } });
        const orderReservations=await tx.commerceOrderLineReservation.findMany({where:{workspaceId:actor.workspaceId,orderId}});
        const row = await tx.commerceShipment.create({ data: { workspaceId: actor.workspaceId,storeId: order.storeId,orderId,warehouseId: input.warehouseId,deliveryServiceId: input.deliveryServiceId } });
        for (const item of input.items) {
          const line = lines.find(l => l.itemId===item.orderLineId);
          if (!line) throw new AppError('SHIPMENT_QUANTITY_EXCEEDED','Order line is unavailable.',422);
          if (service.type==='DIGITAL' && line.stockable) throw new AppError('SHIPMENT_INVALID_STATE','Digital delivery cannot fulfill physical stock.',422);
          const allocated = await tx.commerceShipmentItem.aggregate({ where: { workspaceId: actor.workspaceId,orderId,orderLineId: item.orderLineId,shipmentId: { in: active.map(s => s.id) } },_sum: { quantity: true } });
          if (exact(allocated._sum.quantity ?? 0).plus(item.quantity).gt(line.quantity)) throw new AppError('SHIPMENT_QUANTITY_EXCEEDED','Shipment quantities exceed the Order.',409);
          const created = await tx.commerceShipmentItem.create({ data: { workspaceId: actor.workspaceId,storeId: order.storeId,orderId,shipmentId: row.id,...item } });
          if (!line.stockable) continue;
          const inventoryActor = await this.inventoryActor(tx,actor,order.storeId);
          let legs;
          const bound=orderReservations.filter(b=>b.orderLineId===line.itemId&&b.inventoryKey===line.inventoryKey);
          // Legacy Orders may use SKU allocation only when there is one unambiguous source line.
          if(!bound.length&&(orderReservations.length||lines.filter(l=>l.stockable&&l.inventoryKey===line.inventoryKey).length!==1))throw new AppError('SHIPMENT_RESERVATION_BINDING_REQUIRED','Order line requires an explicit reservation binding.',409);
          try { legs = await this.reservations.shipmentAllocations(tx,inventoryActor,orderId,line.inventoryKey,input.warehouseId,item.quantity,bound.length?bound.map(b=>b.reservationId):undefined); }
          catch (error) { if (isAppError(error) && error.code==='RESERVATION_QUANTITY_INVALID') throw new AppError('SHIPMENT_QUANTITY_EXCEEDED','Shipment quantity exceeds Catalog unit precision.',422); throw error; }
          let needed = exact(item.quantity);
          for (const leg of legs) {
            const current = await tx.commerceShipmentStockBinding.findMany({ where: { workspaceId: actor.workspaceId,reservationId: leg.reservationId,locationId: leg.locationId,shipmentId: { in: [...active.map(s => s.id),row.id] } } });
            // Shipped bindings have already been deducted from the owning allocation.
            const pendingIds = await tx.commerceShipment.findMany({ where: { workspaceId: actor.workspaceId,warehouseId: input.warehouseId,id: { in: current.map(b => b.shipmentId) },status: { in: preDispatch } },select: { id: true } });
            const pending = current.filter(b => pendingIds.some(s => s.id===b.shipmentId)).reduce((s,b) => s.plus(b.quantity),exact(0));
            const available = exact(leg.quantity).minus(pending);
            if (available.lte(0)) continue;
            const take = available.lt(needed) ? available : needed;
            await tx.commerceShipmentStockBinding.create({ data: { workspaceId: actor.workspaceId,shipmentId: row.id,itemId: created.id,reservationId: leg.reservationId,locationId: leg.locationId,quantity: take.toFixed(6) } });
            needed = needed.minus(take); if (needed.eq(0)) break;
          }
          if (needed.gt(0)) throw new AppError('SHIPMENT_QUANTITY_EXCEEDED','Selected warehouse reservations do not cover the shipment.',409);
        }
        await this.event(tx,actor,row,'CREATED'); return this.projection(tx,row);
      });
    },{ timeout: 60000 });
  }
  async update(actor: Principal,id: string,raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion: commerceVersion,trackingInfo: z.strictObject({ trackingNumber: z.string().trim().min(1).max(160),externalShipmentId: z.string().trim().min(1).max(160).optional() }).optional(),deliveryChoice: uuid.optional() }),raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'commerce:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const row = await this.load(tx,actor,id,'COMMERCE.SHIPMENT_MANAGE'); await lock(tx,actor.workspaceId,'commerce:order:'+row.orderId);
      this.openOrder(await this.orders.load(tx,actor,row.orderId,'COMMERCE.SHIPMENT_MANAGE'));
      assertCommerceVersion(row.version,input.expectedVersion); if (!preDispatch.includes(row.status)) throw new AppError('SHIPMENT_INVALID_STATE','Dispatched tracking is immutable.',409);
      if (input.deliveryChoice) await this.service(tx,actor,input.deliveryChoice,row.storeId);
      const updated = await tx.commerceShipment.update({ where: { id },data: { ...input.trackingInfo,deliveryServiceId: input.deliveryChoice,version: { increment: 1 } } });
      await this.event(tx,actor,updated,'UPDATED'); return this.projection(tx,updated);
    });
  }
  private async refreshOrder(tx: Tx,actor: Principal,order: CommerceOrder) {
    const shipments = await tx.commerceShipment.findMany({ where: { workspaceId: actor.workspaceId,orderId: order.id,status: { not: 'CANCELLED' } } });
    const delivered = await tx.commerceShipmentItem.findMany({ where: { workspaceId: actor.workspaceId,orderId: order.id,shipmentId: { in: shipments.filter(s => s.status==='DELIVERED').map(s => s.id) } } });
    const complete = shipmentOrderLines(order).every(line => delivered.filter(i => i.orderLineId===line.itemId).reduce((s,i) => s.plus(i.quantity),exact(0)).eq(line.quantity));
    const paid = await this.payments.paid(tx,actor,order.id,order.currency);
    const status = complete && exact(paid).gte(order.total) ? 'COMPLETED' : shipments.some(s => s.shippedAt!==null) ? 'PROCESSING' : order.status;
    const updated = await tx.commerceOrder.update({ where: { id: order.id },data: { status,version: { increment: 1 } } });
    await tx.commerceOrderHistory.create({ data: { workspaceId: actor.workspaceId,storeId: order.storeId,orderId: order.id,actorUserId: actor.userId,action: 'FULFILLMENT_CHANGED',details: { status,fullyDelivered: complete } } });
    await evidence(tx,actor,'COMMERCE_ORDER',order.id,'ORDER_FULFILLMENT_CHANGED',{ status,fullyDelivered: complete,version: updated.version.toString() });
    await this.orders.refreshFulfillmentProjection(tx,actor,order.id,'COMMERCE.SHIPMENT_MANAGE');
  }
  async applyDeliveryEvent(tx: Tx,actor: Principal,id: string,event: { status: 'IN_TRANSIT'|'DELIVERED'|'FAILED'|'RETURNED';occurredAt: string;providerStatus: string;externalEventId: string }) {
    await lock(tx,actor.workspaceId,'commerce:configuration');
    const row = await this.load(tx,actor,id,'COMMERCE.SHIPMENT_MANAGE');
    await lock(tx,actor.workspaceId,'commerce:order:'+row.orderId);
    const order = await this.orders.load(tx,actor,row.orderId,'COMMERCE.SHIPMENT_MANAGE'),at = new Date(event.occurredAt);
    if (!row.shippedAt || row.status==='CANCELLED') throw new AppError('SHIPMENT_INVALID_STATE','Provider status cannot dispatch an unposted Shipment.',409);
    const rank: Record<string,number> = { SHIPPED: 0,IN_TRANSIT: 1,FAILED: 2,DELIVERED: 3,RETURNED: 4 };
    const stale = at<row.shippedAt || row.lastProviderEventAt && (at<row.lastProviderEventAt || at.getTime()===row.lastProviderEventAt.getTime() && rank[event.status]<=rank[row.status]) || row.deliveredAt && at<row.deliveredAt;
    const regression = row.status==='RETURNED' && event.status!=='RETURNED' || row.status==='DELIVERED' && !['RETURNED','DELIVERED'].includes(event.status) || row.status==='FAILED' && event.status==='IN_TRANSIT';
    if (stale || regression) {
      await this.event(tx,actor,row,'PROVIDER_EVENT_IGNORED',{ ...event }); return { changed: false };
    }
    if (row.status===event.status) {
      const confirmed = await tx.commerceShipment.update({ where: { id },data: { lastProviderEventAt: at,version: { increment: 1 } } });
      await this.event(tx,actor,confirmed,'PROVIDER_EVENT_CONFIRMED',{ ...event }); return { changed: false };
    }
    if (order.archivedAt || order.status==='CANCELLED') throw new AppError('SHIPMENT_INVALID_STATE','Order is closed for provider changes.',409);
    const updated = await tx.commerceShipment.update({ where: { id },data: { status: event.status,lastProviderEventAt: at,...(event.status==='DELIVERED' ? { deliveredAt: at } : {}),version: { increment: 1 } } });
    await this.event(tx,actor,updated,event.status,{ ...event }); await this.refreshOrder(tx,actor,order); return { changed: true };
  }
  async transition(actor: Principal,id: string,raw: unknown,key: string|null,action: 'SHIP'|'DELIVER'|'CANCEL') {
    const input = action==='SHIP' ? parse(z.strictObject({ expectedVersion: commerceVersion }),raw) : action==='DELIVER' ? parse(z.strictObject({ trackingEvidence: z.strictObject({ reference: z.string().trim().min(1).max(250),deliveredAt: z.iso.datetime({ offset: true }) }) }),raw) : parse(z.strictObject({ reason: z.string().trim().min(1).max(2000) }),raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'commerce:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const row = await this.load(tx,actor,id,action==='SHIP' ? 'COMMERCE.SHIPMENT_SHIP' : 'COMMERCE.SHIPMENT_MANAGE');
      await lock(tx,actor.workspaceId,'commerce:order:'+row.orderId);
      const order = await this.orders.load(tx,actor,row.orderId,action==='SHIP' ? 'COMMERCE.SHIPMENT_SHIP' : 'COMMERCE.SHIPMENT_MANAGE');
      return command(tx,actor,'COMMERCE.SHIPMENT_'+action+':'+id,key,input,async () => {
        this.openOrder(order);
        if (action==='SHIP') {
          if ('expectedVersion' in input) assertCommerceVersion(row.version,input.expectedVersion);
          if (!preDispatch.includes(row.status)) throw new AppError('SHIPMENT_INVALID_STATE','Shipment cannot ship.',409);
          const paid = await this.payments.paid(tx,actor,order.id,order.currency);
          if (exact(paid).lt(order.total) && (order.snapshot as { paymentMethodId?: string }).paymentMethodId!=='COD') throw new AppError('SHIPMENT_PAYMENT_BLOCKED','Payment is required before shipping.',409);
          const items = await tx.commerceShipmentItem.findMany({ where: { workspaceId: actor.workspaceId,shipmentId: id },orderBy: { id: 'asc' } });
          const stock = items.filter(i => shipmentOrderLines(order).find(l => l.itemId===i.orderLineId)?.stockable);
          if (stock.length) {
            const inventoryActor = await this.inventoryActor(tx,actor,row.storeId);
            await lock(tx,actor.workspaceId,'inventory:configuration');
            let documentId = row.inventoryDocumentId;
            if (!documentId) {
              const document = await this.documents.createInTransaction(tx,inventoryActor,{ documentType: 'SALES_ORDER',warehouseIds: { source: row.warehouseId },currency: order.currency,sourceRef: { entityType: 'ORDER',entityId: order.id } }); documentId = document.id;
              for (const item of stock) {
                const line = shipmentOrderLines(order).find(l => l.itemId===item.orderLineId)!;
                const bindings = await tx.commerceShipmentStockBinding.findMany({ where: { workspaceId: actor.workspaceId,shipmentId: id,itemId: item.id },orderBy: { id: 'asc' } });
                for (const binding of bindings) {
                  const created = await this.documents.addLineInTransaction(tx,inventoryActor,documentId,{ productId: line.productId,variantId: line.variantId ?? undefined,quantity: binding.quantity.toFixed(6),unitCost: '0',sourceLocationId: binding.locationId ?? undefined,reservationId: binding.reservationId });
                  await tx.commerceShipmentStockBinding.update({ where: { id: binding.id },data: { inventoryDocumentLineId: created.id } });
                }
              }
              await tx.commerceShipment.update({ where: { id },data: { inventoryDocumentId: documentId } });
            }
            const plan = await this.documents.shipmentPlan(tx,inventoryActor,documentId),document = plan.document;
            const expected = await tx.commerceShipmentStockBinding.findMany({ where: { workspaceId: actor.workspaceId,shipmentId: id } });
            if (document.type!=='SALES_ORDER' || document.sourceEntityType!=='ORDER' || document.sourceEntityId!==order.id || document.sourceWarehouseId!==row.warehouseId || document.currency!==order.currency || document.reversedAt
              || plan.lines.length!==expected.length || expected.some(binding => !plan.lines.some(line => line.id===binding.inventoryDocumentLineId && line.reservationId===binding.reservationId
                && line.sourceLocationId===binding.locationId && exact(line.quantity).eq(binding.quantity)))) throw new AppError('SHIPMENT_INVENTORY_POST_FAILED','Inventory document no longer matches the Shipment plan.',409);
            if (document.status==='PENDING_APPROVAL') return this.projection(tx,await tx.commerceShipment.update({ where: { id },data: { status: 'PROCESSING',version: { increment: 1 } } }));
            if (document.status!=='PROCESSED') {
              // Submit first so configured approval creates a durable, visible checkpoint.
              let ready = document;
              if (document.status==='DRAFT') ready = await this.documents.approvalInTransaction(tx,inventoryActor,documentId,{ expectedVersion: document.version.toString() },true);
              if (ready.status==='PENDING_APPROVAL') {
                const waiting = await tx.commerceShipment.update({ where: { id },data: { status: 'PROCESSING',version: { increment: 1 } } });
                await this.event(tx,actor,waiting,'APPROVAL_PENDING',{ inventoryDocumentId: documentId }); return this.projection(tx,waiting);
              }
              await this.documents.processInTransaction(tx,inventoryActor,documentId,{ expectedVersion: ready.version.toString() },'shipment:'+id);
            }
          }
          const updated = await tx.commerceShipment.update({ where: { id },data: { status: 'SHIPPED',shippedAt: new Date(),version: { increment: 1 } } });
          await this.event(tx,actor,updated,'SHIPPED'); await this.refreshOrder(tx,actor,order); return this.projection(tx,updated);
        }
        if (action==='DELIVER' && 'trackingEvidence' in input) {
          if (!['SHIPPED','IN_TRANSIT'].includes(row.status)) throw new AppError('SHIPMENT_INVALID_STATE','Only dispatched shipments can be delivered.',409);
          const at = new Date(input.trackingEvidence.deliveredAt);
          if (!row.shippedAt || at<row.shippedAt || at>new Date()) throw new AppError('SHIPMENT_INVALID_STATE','Delivery timestamp must follow dispatch and not be in the future.',422);
          const updated = await tx.commerceShipment.update({ where: { id },data: { status: 'DELIVERED',deliveredAt: at,version: { increment: 1 } } });
          await this.event(tx,actor,updated,'DELIVERED',input.trackingEvidence); await this.refreshOrder(tx,actor,order); return this.projection(tx,updated);
        }
        if (!preDispatch.includes(row.status)) throw new AppError('SHIPMENT_INVALID_STATE','Dispatched shipments require a Return.',409);
        const bindings = await tx.commerceShipmentStockBinding.findMany({ where: { workspaceId: actor.workspaceId,shipmentId: id },orderBy: { id: 'asc' } });
        if (bindings.length) {
          const inventoryActor = await this.inventoryActor(tx,actor,row.storeId);
          if (row.inventoryDocumentId) await this.documents.cancelForShipment(tx,inventoryActor,row.inventoryDocumentId);
          for (const binding of bindings) await this.reservations.releaseShipmentAllocation(tx,inventoryActor,binding.reservationId,binding.quantity.toFixed(6),row.warehouseId,binding.locationId,'shipment-cancel:'+id+':'+binding.id);
        }
        const updated = await tx.commerceShipment.update({ where: { id },data: { status: 'CANCELLED',version: { increment: 1 } } });
        await this.event(tx,actor,updated,'CANCELLED','reason' in input && typeof input.reason==='string' ? { reason: input.reason } : {}); return this.projection(tx,updated);
      });
    },{ timeout: 60000 }).catch(error => {
      if (action==='SHIP' && isAppError(error) && /^(INVENTORY_|STOCK_|RESERVATION_|COSTING_)/.test(error.code)) throw new AppError('SHIPMENT_INVENTORY_POST_FAILED','Inventory could not post the shipment.',409,{ reason: error.code });
      throw error;
    });
  }
}
