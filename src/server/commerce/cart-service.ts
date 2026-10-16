import { Prisma, type CommerceCart, type CommerceStore, type PrismaClient } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { lock, type Tx } from '../process-platform/context';
import { canonical, decimal, parse, uuid } from '../process-platform/dto';
import { calculateRow, fromScaled, toScaled } from '../catalog/money';
import { exact } from '../inventory/decimal';
import { checkRateLimit } from '../rate-limit';
import { sanitizeAuditPayload } from '../sanitize';
import { commerceCatalogPort } from './catalog-port';
import { CommercePublicationService } from './publication-service';
import { assertCommerceVersion, commerceVersion } from './dto';

export const cartQuantity = decimal.refine(value => exact(value).gt(0) && exact(value).lt('1000000000000'), 'Quantity must fit NUMERIC(18,6) and be positive');
const options = z.record(z.string().min(1).max(80), z.string().max(160)).refine(value => Object.keys(value).length<=32);
export const cartAddInput = z.strictObject({ productId: uuid, variantId: uuid.optional(), quantity: cartQuantity, options: options.default({}) });
export const cartToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export function hashCartToken(token: string) { return createHash('sha256').update(token).digest('hex'); }
export async function publicCommerceEvent(tx: Tx, workspaceId: string, entityType: string, entityId: string, eventType: string, payload: Prisma.InputJsonObject = {}) {
  // Guest access never borrows the store creator's employee identity.
  const eventId = randomUUID();
  await tx.outboxEvent.create({ data: { id: eventId,correlationId: eventId,workspaceId, entityType, entityId, eventType, payload } });
  if (eventType==='ORDER_CREATED') await tx.auditLog.create({ data: { workspaceId,entityType,entityId,action: eventType,
    afterData: sanitizeAuditPayload(payload) as Prisma.InputJsonValue,metadata: { actorType: 'PUBLIC',eventId } } });
}

export class CommerceCartService {
  constructor(private readonly db: PrismaClient, readonly publications = new CommercePublicationService(db), readonly catalog = commerceCatalogPort) {}

  /** Reorder imports product identities and quantities only. Historical amounts,
   * discounts and taxes never enter the new Cart. All changes roll back together. */
  async reorderInTransaction(tx:Tx,store:CommerceStore,raw:unknown,orderId:string){
    const lines=parse(z.array(z.object({productId:uuid,variantId:uuid.nullable().optional(),quantity:cartQuantity,options:options.default({})})).min(1).max(100),raw);
    const token=randomBytes(32).toString('base64url');
    const cart=await tx.commerceCart.create({data:{workspaceId:store.workspaceId,storeId:store.id,tokenHash:hashCartToken(token),currency:store.defaultCurrency,expiresAt:new Date(Date.now()+7*86400000)}});
    for(const line of lines){
      const product=await this.product(tx,store,line.productId,line.variantId??null);
      const optionsHash=createHash('sha256').update(canonical(line.options)).digest('hex');
      const key={cartId:cart.id,inventoryKey:product.inventoryKey,optionsHash};
      const prior=await tx.commerceCartItem.findUnique({where:{cartId_inventoryKey_optionsHash:key}});
      const quantity=exact(prior?.quantity??0).plus(line.quantity).toFixed(6);parse(cartQuantity,quantity);
      if(product.unit&&exact(quantity).decimalPlaces()>product.unit.precision)throw new AppError('COMMERCE_ITEM_NOT_AVAILABLE','Quantity no longer matches the product unit.',422);
      if(product.stockable&&!(await this.publications.inventory.publicSellability(tx,store.workspaceId,product.inventoryKey,store.defaultWarehouseId)).available)throw new AppError('COMMERCE_ITEM_NOT_AVAILABLE','Product is currently out of stock.',422);
      await tx.commerceCartItem.upsert({where:{cartId_inventoryKey_optionsHash:key},create:{...key,workspaceId:store.workspaceId,storeId:store.id,productId:line.productId,variantId:line.variantId,quantity,options:line.options},update:{quantity,version:{increment:1}}});
    }
    const projection=await this.projection(tx,store,cart);
    await publicCommerceEvent(tx,store.workspaceId,'COMMERCE_CART',cart.id,'CART_CREATED',{storeId:store.id,sourceOrderId:orderId});
    return{...projection,cartToken:token};
  }

  async authorized(tx: Tx, store: CommerceStore, token: string, mutable = false) {
    parse(cartToken,token);
    const tokenHash = hashCartToken(token);
    if (mutable) await lock(tx,store.workspaceId,'commerce:cart:' + tokenHash);
    const cart = await tx.commerceCart.findFirst({ where: { workspaceId: store.workspaceId,storeId: store.id,tokenHash } });
    if (!cart) throw new AppError('COMMERCE_CART_NOT_FOUND','Cart was not found.',404);
    if (cart.expiresAt<=new Date() || cart.status==='EXPIRED') throw new AppError('COMMERCE_CART_EXPIRED','Cart has expired.',410);
    if (mutable && !['ACTIVE','CHECKOUT','ABANDONED'].includes(cart.status)) throw new AppError('COMMERCE_CHECKOUT_DUPLICATE','Cart has already been converted.',409);
    return cart;
  }

  async product(tx: Tx, store: CommerceStore, productId: string, variantId: string | null) {
    const now = new Date();
    const publication = await tx.commerceProductPublication.findFirst({ where: { workspaceId: store.workspaceId,storeId: store.id,productId,variantId,published: true,
      AND: [{ OR: [{ availableFrom: null },{ availableFrom: { lte: now } }] },{ OR: [{ availableUntil: null },{ availableUntil: { gt: now } }] }] } });
    if (!publication) throw new AppError('COMMERCE_ITEM_NOT_AVAILABLE','Product is unavailable.',404);
    const resolved = (await this.catalog(tx,store.workspaceId)).product(store.catalogId,productId,variantId,store.priceTypeId,store.defaultCurrency);
    // Price resolution order: valid store override > configured Catalog price type. Orders snapshot the result.
    const override = await tx.commerceListingOverride.findFirst({ where: { workspaceId: store.workspaceId,publicationId: publication.id,currency: store.defaultCurrency,amount: { not: null },
      AND: [{ OR: [{ validFrom: null },{ validFrom: { lte: now } }] },{ OR: [{ validTo: null },{ validTo: { gt: now } }] }] } });
    return override?.amount ? { ...resolved,unitPrice: override.amount.toFixed(6),revision: { ...resolved.revision,override: override.version } } : resolved;
  }

  async projection(tx: Tx, store: CommerceStore, cart: CommerceCart) {
    const rows = await tx.commerceCartItem.findMany({ where: { workspaceId: store.workspaceId,storeId: store.id,cartId: cart.id },orderBy: { id: 'asc' } });
    const items = []; let total = 0n;
    for (const row of rows) {
      const product = await this.product(tx,store,row.productId,row.variantId);
      const amounts = calculateRow(toScaled(row.quantity.toFixed(6))!,toScaled(product.unitPrice)!,{ type: 'NONE',value: 0n },{ taxable: false,rate: 0n,included: false },store.defaultCurrency);
      total += amounts.total;
      const availability = product.stockable ? await this.publications.inventory.publicSellability(tx,store.workspaceId,product.inventoryKey,store.defaultWarehouseId) : { available: true,backorderAllowed: false };
      items.push({ id: row.id,productId: row.productId,variantId: row.variantId,name: product.name,quantity: row.quantity.toFixed(6),options: row.options,
        unitPrice: product.unitPrice,lineTotal: fromScaled(amounts.total),version: row.version.toString(),available: availability.available,backorderAllowed: availability.backorderAllowed });
    }
    return { id: cart.id,status: cart.status,currency: cart.currency,version: cart.version.toString(),expiresAt: cart.expiresAt,items,subtotal: fromScaled(total) };
  }

  async create(storeSlug: string, raw: unknown, client: string) {
    parse(z.strictObject({}),raw);
    checkRateLimit(storeSlug + ':' + client,{ scope: 'commerce.cart-create',limit: 20,windowMs: 60000 });
    return this.db.$transaction(async tx => {
      const scope = await this.publications.publicScope(tx,storeSlug);
      await lock(tx,scope.store.workspaceId,'commerce:configuration');
      const { store } = await this.publications.publicScope(tx,storeSlug);
      const token = randomBytes(32).toString('base64url');
      const row = await tx.commerceCart.create({ data: { workspaceId: store.workspaceId,storeId: store.id,tokenHash: hashCartToken(token),currency: store.defaultCurrency,expiresAt: new Date(Date.now()+7*86400000) } });
      await publicCommerceEvent(tx,store.workspaceId,'COMMERCE_CART',row.id,'CART_CREATED',{ storeId: store.id });
      return { ...await this.projection(tx,store,row),cartToken: token };
    });
  }

  async get(storeSlug: string, token: string) {
    return this.db.$transaction(async tx => {
      const { store } = await this.publications.publicScope(tx,storeSlug);
      return this.projection(tx,store,await this.authorized(tx,store,token));
    },{ timeout: 60000 });
  }

  async mutate(storeSlug: string, token: string, raw: unknown, action: 'ADD'|'UPDATE'|'DELETE', itemId?: string) {
    const input = action==='ADD' ? parse(cartAddInput,raw) : action==='UPDATE' ? parse(z.strictObject({ quantity: cartQuantity,expectedVersion: commerceVersion }),raw) : parse(z.strictObject({}),raw);
    if (itemId) parse(uuid,itemId);
    checkRateLimit(hashCartToken(token),{ scope: 'commerce.cart-write',limit: 120,windowMs: 60000 });
    return this.db.$transaction(async tx => {
      const scope = await this.publications.publicScope(tx,storeSlug);
      await lock(tx,scope.store.workspaceId,'commerce:configuration');
      const { store } = await this.publications.publicScope(tx,storeSlug);
      const cart = await this.authorized(tx,store,token,true);
      if (action==='ADD' && 'productId' in input) {
        const product = await this.product(tx,store,input.productId,input.variantId ?? null);
        const optionsHash = createHash('sha256').update(canonical(input.options)).digest('hex');
        const prior = await tx.commerceCartItem.findUnique({ where: { cartId_inventoryKey_optionsHash: { cartId: cart.id,inventoryKey: product.inventoryKey,optionsHash } } });
        const quantity = exact(prior?.quantity ?? 0).plus(input.quantity).toFixed(6); parse(cartQuantity,quantity);
        if (product.unit && exact(quantity).decimalPlaces()>product.unit.precision) throw new AppError('INVALID_ARGUMENT','Quantity exceeds the Catalog unit precision.',400);
        if (!prior && await tx.commerceCartItem.count({ where: { cartId: cart.id } })>=100) throw new AppError('COMMERCE_CHECKOUT_INVALID','Cart item limit reached.',422);
        await tx.commerceCartItem.upsert({ where: { cartId_inventoryKey_optionsHash: { cartId: cart.id,inventoryKey: product.inventoryKey,optionsHash } },
          create: { workspaceId: store.workspaceId,storeId: store.id,cartId: cart.id,productId: input.productId,variantId: input.variantId,inventoryKey: product.inventoryKey,quantity,options: input.options,optionsHash },
          update: { quantity,version: { increment: 1 } } });
      } else {
        const item = await tx.commerceCartItem.findFirst({ where: { workspaceId: store.workspaceId,storeId: store.id,cartId: cart.id,id: itemId } });
        if (!item) throw new AppError('COMMERCE_CART_NOT_FOUND','Cart item was not found.',404);
        if (action==='UPDATE' && 'quantity' in input && 'expectedVersion' in input) {
          assertCommerceVersion(item.version,input.expectedVersion);
          const product = await this.product(tx,store,item.productId,item.variantId);
          if (product.unit && exact(input.quantity).decimalPlaces()>product.unit.precision) throw new AppError('INVALID_ARGUMENT','Quantity exceeds the Catalog unit precision.',400);
          await tx.commerceCartItem.update({ where: { id: item.id },data: { quantity: input.quantity,version: { increment: 1 } } });
        } else await tx.commerceCartItem.delete({ where: { id: item.id } });
      }
      const updated = await tx.commerceCart.update({ where: { id: cart.id },data: { ...(cart.status==='ABANDONED' ? { status: 'ACTIVE' } : {}),version: { increment: 1 },lastActivityAt: new Date() } });
      return this.projection(tx,store,updated);
    },{ timeout: 60000 });
  }
}
