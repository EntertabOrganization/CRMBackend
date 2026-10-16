import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError, isAppError } from '../../errors';
import { parse, uuid } from '../../process-platform/dto';
import { CommerceCheckoutService } from '../checkout-service';
import { cartToken, hashCartToken } from '../cart-service';
import { requestHash } from '../../suite/kernel';

const buyer = z.strictObject({ type: z.enum(['INDIVIDUAL', 'COMPANY']), name: z.string().trim().min(1).max(160), email: z.email().max(254).transform(v => v.toLowerCase()).optional(),
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/).optional(), company: z.strictObject({ legalName: z.string().trim().min(1).max(200), taxId: z.string().trim().max(60).optional(), requisiteId: uuid.optional() }).optional() })
  .refine(b => b.email || b.phone, 'Email or phone is required').refine(b => b.type === 'INDIVIDUAL' || b.company, 'Company payer details are required');
const confirmDto = z.strictObject({ buyer: buyer.optional(), billingAddressId: z.string().max(80).optional(), deliveryMethodId: z.string().min(1).max(64).optional(), paymentMethodId: z.string().min(1).max(64).optional(),
  acceptedQuoteVersion: z.number().int().positive(), consents: z.array(z.strictObject({ kind: z.enum(['TERMS', 'PRIVACY', 'MARKETING']), version: z.string().min(1).max(80), accepted: z.boolean() })).max(3).optional() });

/**
 * `/public/...` contract (spec OnlineStore-Commerce/04): store-slug-free aliases resolved from unguessable cart/checkout
 * tokens. The checkout session token travels in `X-Checkout-Token`; amounts are always recalculated server-side.
 */
export class CommercePublicCheckoutService {
  constructor(private readonly db: PrismaClient, readonly checkout = new CommerceCheckoutService(db)) {}

  private async slugForStore(workspaceId: string, storeId: string) {
    const front = await this.db.commerceStorefront.findFirst({ where: { workspaceId, storeId, status: 'PUBLISHED', type: { in: ['WEB', 'HEADLESS'] } }, orderBy: { slug: 'asc' } });
    if (!front) throw new AppError('NOT_FOUND', 'Store is unavailable.', 404);
    return front.slug;
  }
  async slugForCart(token: string) {
    parse(cartToken, token);
    const cart = await this.db.commerceCart.findUnique({ where: { tokenHash: hashCartToken(token) } });
    if (!cart) throw new AppError('NOT_FOUND', 'Cart was not found.', 404);
    return this.slugForStore(cart.workspaceId, cart.storeId);
  }

  async openSession(cart: string, raw: unknown, authorization: string | null) {
    const body = parse(z.record(z.string(), z.unknown()), raw);
    return this.checkout.create(await this.slugForCart(cart), { ...body, cartToken: cart }, authorization);
  }
  async quote(sessionId: string, token: string, raw: unknown) {
    const session = await this.session(sessionId);
    const result = await this.checkout.quote(await this.slugForStore(session.workspaceId, session.storeId), sessionId, token, raw) as Record<string, unknown>;
    const current = await this.db.commerceCheckoutSession.findUniqueOrThrow({ where: { id: sessionId } });
    return { ...result, quoteVersion: Number(current.version) };
  }
  private async session(id: string) {
    parse(uuid, id);
    const session = await this.db.commerceCheckoutSession.findUnique({ where: { id } });
    if (!session) throw new AppError('NOT_FOUND', 'Checkout was not found.', 404);
    return session;
  }

  async confirm(sessionId: string, token: string, raw: unknown, key: string | null) {
    const input = parse(confirmDto, raw);
    if (!key || key.length < 8 || key.length > 128) throw new AppError('VALIDATION_FAILED', 'Idempotency-Key must contain 8 to 128 characters.', 400);
    const session = await this.session(sessionId);
    const store = await this.db.commerceStore.findFirst({ where: { workspaceId: session.workspaceId, id: session.storeId } });
    // A suspended/unavailable Commerce store never yields a (false) successful confirmation.
    if (!store || store.status !== 'ACTIVE') throw new AppError('CHECKOUT_BLOCKED', 'Checkout is currently unavailable for this store.', 409);
    if (!token || session.tokenHash !== hashCartToken(token)) throw new AppError('NOT_FOUND', 'Checkout was not found.', 404);
    const hash = requestHash(input), bodyKey = { workspaceId: session.workspaceId, storeId: session.storeId, sessionId, key: 'confirm-body:' + key };
    const prior = await this.db.commerceCheckoutCommand.findUnique({ where: { workspaceId_storeId_sessionId_key: bodyKey } });
    if (prior && (prior.requestHash !== hash)) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'Key was used with another request.', 409);
    const slug = await this.slugForStore(session.workspaceId, session.storeId);
    if (!prior) {
      if (session.status === 'ORDERED' && session.orderId) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'Checkout was already confirmed with another key.', 409);
      if (session.status !== 'QUOTED' || !session.quoteExpiresAt || session.quoteExpiresAt <= new Date() || Number(session.version) !== input.acceptedQuoteVersion)
        throw new AppError('QUOTE_EXPIRED', 'Quote changed or expired; request a fresh quote.', 409, { refresh: `/api/v1/public/checkout-sessions/${sessionId}/quote` });
      const quoted = (session.quoteInput ?? {}) as { paymentMethodId?: string; deliveryMethodId?: string };
      if (input.paymentMethodId && input.paymentMethodId !== quoted.paymentMethodId || input.deliveryMethodId && quoted.deliveryMethodId && input.deliveryMethodId !== quoted.deliveryMethodId)
        throw new AppError('QUOTE_EXPIRED', 'Selected payment or delivery differs from the accepted quote.', 409);
      const customer = session.customerSnapshot as { email?: string };
      if (input.buyer?.email && customer.email && input.buyer.email !== customer.email) throw new AppError('VALIDATION_FAILED', 'Buyer email must match the checkout contact.', 400, { fields: [{ field: 'buyer.email', reason: 'MISMATCH' }] });
    }
    // Confirming the checkout records acceptance of the store's current terms/privacy notices.
    const consents = input.consents ?? [{ kind: 'TERMS' as const, version: 'checkout-confirm', accepted: true }, { kind: 'PRIVACY' as const, version: 'checkout-confirm', accepted: true }];
    let result: { orderId: string; status: string; paymentStatus: string; currency: string; total: string };
    try { result = await this.checkout.place(slug, sessionId, token, { quoteHash: session.quoteHash ?? '0'.repeat(64), consents }, 'confirm:' + key) as typeof result; }
    catch (error) {
      if (isAppError(error) && error.code === 'COMMERCE_CHECKOUT_REQUOTE_REQUIRED') throw new AppError('QUOTE_EXPIRED', 'Pricing changed; request a fresh quote.', 409);
      if (isAppError(error) && error.code === 'COMMERCE_STOCK_RESERVATION_FAILED') throw new AppError('INSUFFICIENT_STOCK', 'Requested quantity is not available.', 409);
      if (isAppError(error) && error.code === 'COMMERCE_CHECKOUT_DUPLICATE') throw new AppError('IDEMPOTENCY_KEY_REUSED', 'Checkout was already confirmed with another key.', 409);
      throw error;
    }
    if (!prior) await this.db.commerceCheckoutCommand.upsert({ where: { workspaceId_storeId_sessionId_key: bodyKey }, create: { ...bodyKey, requestHash: hash, response: result }, update: {} });
    return { id: result.orderId, ...result };
  }

  async cartItems(cart: string, raw: unknown, action: 'ADD' | 'UPDATE' | 'DELETE', itemId?: string) {
    const { CommerceCartService } = await import('../cart-service');
    return new CommerceCartService(this.db).mutate(await this.slugForCart(cart), cart, raw, action, itemId);
  }
  async coupon(cart: string, raw: unknown) {
    const input = parse(z.strictObject({ checkoutSessionToken: z.string(), code: z.string() }), raw);
    return this.checkout.validateCoupon(await this.slugForCart(cart), input);
  }
}
