import { Prisma, type PrismaClient, type CommerceStore } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError, isAppError } from '../errors';
import { lock, resolvePrincipal, type Tx } from '../process-platform/context';
import { canonical, parse, uuid } from '../process-platform/dto';
import { checkRateLimit } from '../rate-limit';
import { InventoryReservationService } from '../inventory/reservation-service';
import { CommerceCartService, cartToken, hashCartToken, publicCommerceEvent } from './cart-service';
import { CommerceQuoteService } from './quote-service';
import { enqueueOrderCrmSync } from './crm-sync-service';
import { preparePaidReservations } from './paid-reservation-service';
import { checkoutCustomer } from './customer-service';

const customerInfo = z.strictObject({ name: z.string().trim().min(1).max(160),email: z.email().max(254).transform(v => v.trim().toLowerCase()),phone: z.string().trim().min(5).max(40).optional() });
const shippingInfo = z.strictObject({ country: z.string().regex(/^[A-Z]{2}$/),region: z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,10})?$/),
  city: z.string().trim().min(1).max(160),line1: z.string().trim().min(1).max(250),line2: z.string().trim().max(250).optional(),postalCode: z.string().trim().max(40).optional() });
const quoteInput = z.strictObject({ couponCodes: z.array(z.string().trim().toUpperCase().min(3).max(80).regex(/^[A-Z0-9_-]+$/)).max(10).default([]),
  paymentMethodId: z.enum(['OFFLINE','COD']),deliveryMethodId: z.literal('PICKUP').optional() });
const consent = z.strictObject({ kind: z.enum(['TERMS','PRIVACY','MARKETING']),version: z.string().min(1).max(80),accepted: z.boolean() });
export class CommerceCheckoutService {
  readonly pricing: CommerceQuoteService;
  constructor(private readonly db: PrismaClient,readonly carts = new CommerceCartService(db),readonly reservations = new InventoryReservationService(db)) { this.pricing = new CommerceQuoteService(carts); }

  private policy(store: CommerceStore,paymentMethodId: string) {
    const settings = store.settings as { paymentMethods?: string[];deliveryPolicy?: string };
    if (!settings.paymentMethods?.includes(paymentMethodId) || settings.deliveryPolicy!=='PICKUP') throw new AppError('COMMERCE_CHECKOUT_INVALID','Selected payment or delivery policy is unavailable.',422);
  }
  private async session(tx: Tx,store: CommerceStore,id: string,token: string) {
    parse(uuid,id); parse(cartToken,token);
    const row = await tx.commerceCheckoutSession.findFirst({ where: { workspaceId: store.workspaceId,storeId: store.id,id,tokenHash: hashCartToken(token) } });
    if (!row) throw new AppError('COMMERCE_CHECKOUT_INVALID','Checkout was not found.',404);
    if (row.expiresAt<=new Date()) throw new AppError('COMMERCE_CHECKOUT_INVALID','Checkout expired.',410);
    return row;
  }
  private context(store: CommerceStore,session: { customerSnapshot: Prisma.JsonValue;addressSnapshot: Prisma.JsonValue },raw: unknown) {
    const input = parse(quoteInput,raw); this.policy(store,input.paymentMethodId);
    const customer = parse(customerInfo,session.customerSnapshot),address = parse(shippingInfo,session.addressSnapshot);
    return { input,region: address.region,customerKey: createHash('sha256').update(store.id+':'+customer.email).digest('hex'),couponCodes: input.couponCodes,paymentMethodId: input.paymentMethodId };
  }

  async create(slug: string,raw: unknown,authorization: string|null = null) {
    const input = parse(z.strictObject({ cartToken,customerInfo,shippingInfo,payerType: z.enum(['PERSON','COMPANY']) }),raw);
    checkRateLimit(hashCartToken(input.cartToken),{ scope: 'commerce.checkout-create',limit: 20,windowMs: 60000 });
    if (input.shippingInfo.region.split('-')[0]!==input.shippingInfo.country) throw new AppError('COMMERCE_CHECKOUT_INVALID','Address region must match country.',422);
    return this.db.$transaction(async tx => {
      const scope = await this.carts.publications.publicScope(tx,slug);
      await lock(tx,scope.store.workspaceId,'commerce:configuration');
      const { store } = await this.carts.publications.publicScope(tx,slug);
      const cart = await this.carts.authorized(tx,store,input.cartToken,true);
      const customer = await checkoutCustomer(tx,store,authorization,input.customerInfo.email);
      if (!await tx.commerceCartItem.count({ where: { cartId: cart.id } })) throw new AppError('COMMERCE_CHECKOUT_INVALID','Cart is empty.',422);
      const token = randomBytes(32).toString('base64url');
      const row = await tx.commerceCheckoutSession.create({ data: { workspaceId: store.workspaceId,storeId: store.id,cartId: cart.id,tokenHash: hashCartToken(token),
        customerAccountId: customer?.id,customerSnapshot: input.customerInfo,addressSnapshot: input.shippingInfo,payerType: input.payerType,expiresAt: new Date(Math.min(cart.expiresAt.getTime(),Date.now()+3600000)) } });
      await tx.commerceCart.update({ where: { id: cart.id },data: { status: 'CHECKOUT',lastActivityAt: new Date() } });
      await publicCommerceEvent(tx,store.workspaceId,'COMMERCE_CHECKOUT',row.id,'CHECKOUT_STARTED',{ cartId: cart.id,storeId: store.id });
      return { id: row.id,checkoutSessionToken: token,status: row.status,expiresAt: row.expiresAt };
    });
  }

  async quote(slug: string,id: string,token: string,raw: unknown) {
    checkRateLimit(hashCartToken(token),{ scope: 'commerce.checkout-quote',limit: 30,windowMs: 60000 });
    return this.db.$transaction(async tx => {
      const scope = await this.carts.publications.publicScope(tx,slug);
      await lock(tx,scope.store.workspaceId,'commerce:configuration');
      const { store } = await this.carts.publications.publicScope(tx,slug);
      await lock(tx,store.workspaceId,'commerce:checkout:' + id);
      const row = await this.session(tx,store,id,token);
      if (row.status==='ORDERED') throw new AppError('COMMERCE_CHECKOUT_DUPLICATE','Checkout already converted.',409);
      const cart = await tx.commerceCart.findFirstOrThrow({ where: { workspaceId: store.workspaceId,id: row.cartId } });
      await lock(tx,store.workspaceId,'commerce:cart:' + cart.tokenHash);
      const current = await tx.commerceCart.findUniqueOrThrow({ where: { id: cart.id } });
      if (current.status==='CONVERTED' || current.expiresAt<=new Date()) throw new AppError('COMMERCE_CHECKOUT_DUPLICATE','Cart is unavailable.',409);
      const context = this.context(store,row,raw),result = await this.pricing.calculate(tx,store,current,context);
      const expiresAt = new Date(Math.min(row.expiresAt.getTime(),Date.now()+300000));
      await tx.commerceCheckoutSession.update({ where: { id },data: { quoteHash: result.hash,quote: result.quote as unknown as Prisma.InputJsonValue,quoteInput: context.input,status: 'QUOTED',quoteExpiresAt: expiresAt,version: { increment: 1 } } });
      await tx.commerceCart.update({ where: { id: cart.id },data: { lastActivityAt: new Date() } });
      return { ...result.quote,quoteHash: result.hash,expiresAt };
    },{ timeout: 60000 });
  }

  async place(slug: string,id: string,token: string,raw: unknown,key: string|null) {
    const input = parse(z.strictObject({ quoteHash: z.string().regex(/^[a-f0-9]{64}$/),consents: z.array(consent).max(3).refine(v => new Set(v.map(c => c.kind)).size===v.length) }),raw);
    if (!key || key.length<8 || key.length>128) throw new AppError('INVALID_ARGUMENT','Idempotency-Key must contain 8 to 128 characters.',400);
    if (!['TERMS','PRIVACY'].every(kind => input.consents.some(c => c.kind===kind && c.accepted))) throw new AppError('COMMERCE_CHECKOUT_INVALID','Terms and privacy acceptance are required.',422);
    checkRateLimit(hashCartToken(token),{ scope: 'commerce.place-order',limit: 30,windowMs: 60000 });
    return this.db.$transaction(async tx => {
      const scope = await this.carts.publications.publicScope(tx,slug);
      await lock(tx,scope.store.workspaceId,'commerce:configuration'); await lock(tx,scope.store.workspaceId,'commerce:checkout:' + id);
      const store = await tx.commerceStore.findUniqueOrThrow({ where: { id: scope.store.id } });
      if (store.status!=='ACTIVE') throw new AppError('COMMERCE_STORE_NOT_FOUND','Store is unavailable.',404);
      const session = await this.session(tx,store,id,token),requestHash = createHash('sha256').update(canonical(input)).digest('hex');
      const identity = { workspaceId: store.workspaceId,storeId: store.id,sessionId: id,key };
      const prior = await tx.commerceCheckoutCommand.findUnique({ where: { workspaceId_storeId_sessionId_key: identity } });
      if (prior) { if (prior.requestHash!==requestHash) throw new AppError('IDEMPOTENCY_KEY_REUSED','Key was used with another request.',409); return prior.response; }
      const cart = await tx.commerceCart.findUniqueOrThrow({ where: { id: session.cartId } });
      await lock(tx,store.workspaceId,'commerce:cart:' + cart.tokenHash);
      const currentCart = await tx.commerceCart.findUniqueOrThrow({ where: { id: cart.id } });
      if (session.status==='ORDERED' || currentCart.status==='CONVERTED') throw new AppError('COMMERCE_CHECKOUT_DUPLICATE','Checkout already converted.',409);
      if (session.status!=='QUOTED' || !session.quoteExpiresAt || session.quoteExpiresAt<=new Date() || input.quoteHash!==session.quoteHash)
        throw new AppError('COMMERCE_CHECKOUT_REQUOTE_REQUIRED','Request a current quote.',409);
      const context = this.context(store,session,session.quoteInput),result = await this.pricing.calculate(tx,store,currentCart,context);
      if(session.customerAccountId&&!await tx.commerceCustomerAccount.findFirst({where:{workspaceId:store.workspaceId,storeId:store.id,id:session.customerAccountId,status:'ACTIVE'}}))throw new AppError('COMMERCE_CUSTOMER_ACCESS_DENIED','Customer account is unavailable.',403);
      if (result.hash!==session.quoteHash) throw new AppError('COMMERCE_CHECKOUT_REQUOTE_REQUIRED','Pricing changed; request another quote.',409);
      const order = await tx.commerceOrder.create({ data: { workspaceId: store.workspaceId,storeId: store.id,cartId: cart.id,checkoutSessionId: id,currency: store.defaultCurrency,total: result.quote.total,paymentStatus:new Prisma.Decimal(result.quote.total).isZero()?'PAID':'UNPAID',
        customerAccountId:session.customerAccountId,snapshot: { ...result.quote,customer: session.customerSnapshot,address: session.addressSnapshot,payerType: session.payerType },
        consents: input.consents.map(c => ({ ...c,recordedAt: new Date().toISOString() })) } });
      if (result.quote.lines.some(l => l.stockable)) {
        const userId = (store.settings as { inventoryPrincipalUserId?: string }).inventoryPrincipalUserId;
        if (!userId) throw new AppError('COMMERCE_STOCK_RESERVATION_FAILED','Inventory service principal is not configured.',409);
        const actor = await resolvePrincipal(tx,store.workspaceId,userId);
        if (!['ORDER_PLACED','PAYMENT_PAID'].includes(store.reservationTiming)) throw new AppError('COMMERCE_CHECKOUT_INVALID','This reservation timing is not available for checkout.',422);
        if(store.reservationTiming==='PAYMENT_PAID')await preparePaidReservations(tx,order,store);
        else for (const line of result.quote.lines.filter(l => l.stockable).sort((a,b) => a.inventoryKey.localeCompare(b.inventoryKey))) {
          try {
            const reservation=await this.reservations.createInTransaction(tx,actor,{ sourceType: 'ORDER',sourceId: order.id,productId: line.productId,variantId: line.variantId ?? undefined,quantity: line.quantity,warehouseId: store.defaultWarehouseId ?? undefined },'checkout:'+id+':'+line.itemId) as {id:string};
            await tx.commerceOrderLineReservation.create({data:{workspaceId:store.workspaceId,storeId:store.id,orderId:order.id,orderLineId:line.itemId,reservationId:reservation.id,inventoryKey:line.inventoryKey,quantity:line.quantity}});
          }
          catch (error) { if (isAppError(error)) throw new AppError('COMMERCE_STOCK_RESERVATION_FAILED','Stock could not be reserved.',409); throw error; }
        }
      }
      for (const promotion of result.quote.promotions) {
        await tx.commerceDiscountRedemption.create({ data: { workspaceId: store.workspaceId,storeId: store.id,orderId: order.id,ruleId: promotion.ruleId,couponId: promotion.couponId,customerKey: context.customerKey,amount: promotion.amount } });
        if (promotion.couponId) await publicCommerceEvent(tx,store.workspaceId,'COMMERCE_ORDER',order.id,'COMMERCE_COUPON_REDEEMED',{ couponId: promotion.couponId });
      }
      await tx.commerceOrderHistory.create({ data: { workspaceId: store.workspaceId,storeId: store.id,orderId: order.id,action: 'CREATED' } });
      await enqueueOrderCrmSync(tx,order,store);
      await tx.commerceCheckoutSession.update({ where: { id },data: { orderId: order.id,status: 'ORDERED',version: { increment: 1 } } });
      await tx.commerceCart.update({ where: { id: cart.id },data: { status: 'CONVERTED',version: { increment: 1 } } });
      await publicCommerceEvent(tx,store.workspaceId,'COMMERCE_ORDER',order.id,'ORDER_CREATED',{ storeId: store.id,checkoutSessionId: id });
      const response = { orderId: order.id,status: order.status,paymentStatus: order.paymentStatus,currency: order.currency,total: result.quote.total };
      await tx.commerceCheckoutCommand.create({ data: { ...identity,requestHash,response } }); return response;
    },{ timeout: 60000 });
  }

  async status(slug: string,id: string,token: string) {
    return this.db.$transaction(async tx => {
      const { store } = await this.carts.publications.publicScope(tx,slug),row = await this.session(tx,store,id,token);
      return { id: row.id,status: row.status,orderId: row.orderId,expiresAt: row.expiresAt };
    });
  }
  async validateCoupon(slug: string,raw: unknown) {
    const input = parse(z.strictObject({ checkoutSessionToken: cartToken,code: z.string().trim().toUpperCase().min(3).max(80).regex(/^[A-Z0-9_-]+$/) }),raw);
    checkRateLimit(hashCartToken(input.checkoutSessionToken),{ scope: 'commerce.coupon-probe',limit: 10,windowMs: 60000 });
    return this.db.$transaction(async tx => {
      const { store } = await this.carts.publications.publicScope(tx,slug);
      const row = await tx.commerceCheckoutSession.findFirst({ where: { workspaceId: store.workspaceId,storeId: store.id,tokenHash: hashCartToken(input.checkoutSessionToken),expiresAt: { gt: new Date() },status: { in: ['DRAFT','QUOTED'] } } });
      if (!row) throw new AppError('COMMERCE_CHECKOUT_INVALID','Checkout was not found.',404);
      const cart = await tx.commerceCart.findFirstOrThrow({ where: { workspaceId: store.workspaceId,id: row.cartId } });
      if (!row.quoteInput) throw new AppError('COMMERCE_CHECKOUT_INVALID','Select payment and delivery before validating a coupon.',422);
      try {
        const context = this.context(store,row,{ ...parse(quoteInput,row.quoteInput),couponCodes: [input.code] });
        const result = await this.pricing.calculate(tx,store,cart,context);
        return { eligible: result.quote.promotions.some(p => p.couponId!==null) };
      } catch (error) {
        if (isAppError(error) && ['COMMERCE_COUPON_INVALID','COMMERCE_COUPON_EXHAUSTED','COMMERCE_PROMOTION_CONFLICT'].includes(error.code)) return { eligible: false };
        throw error;
      }
    },{ timeout: 60000 });
  }
}
