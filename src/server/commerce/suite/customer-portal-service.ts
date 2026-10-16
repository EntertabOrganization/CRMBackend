import type { CommerceOrder, CommerceStore, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../../errors';
import { parse, pageQuery, uuid } from '../../process-platform/dto';
import { evidence, lock, resolvePrincipal, type Principal, type Tx } from '../../process-platform/context';
import { hashSecret, verifyHash } from '../../security';
import { checkRateLimit } from '../../rate-limit';
import { CommercePublicationService } from '../publication-service';
import { CommerceStoreService } from '../store-service';
import { encrypt, newToken, sha256, systemEvent } from '../../suite/kernel';
import { recordProviderCall } from '../../suite/providers';
import { CommerceStoreAdminService } from './store-admin-service';

const email = z.email().max(254).transform(v => v.trim().toLowerCase());
const password = z.string().min(10).max(128).refine(v => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v), 'Password must include upper, lower case and a digit');
const SESSION_TTL = 7 * 86400000, GUEST_LINK_TTL = 30 * 86400000;

export function customerOrderView(order: CommerceOrder) {
  const snapshot = order.snapshot as { lines?: { itemId: string; name: string; quantity: string; unitPrice: string; total: string }[]; total?: string; subtotal?: string; tax?: string; discount?: string };
  // Internal comments, provider tokens, CRM ids and warehouse notes are excluded.
  return { id: order.id, status: order.status, paymentStatus: order.paymentStatus, fulfillmentStatus: order.fulfillmentStatus, currency: order.currency, total: order.total.toFixed(6), createdAt: order.createdAt,
    lines: (snapshot.lines ?? []).map(l => ({ id: l.itemId, name: l.name, quantity: l.quantity, unitPrice: l.unitPrice, total: l.total })),
    totals: { subtotal: snapshot.subtotal, discount: snapshot.discount, tax: snapshot.tax, total: snapshot.total } };
}

/**
 * Storefront customer realm (spec OnlineStore-Commerce/03). Customer identities are workspace-scoped,
 * never internal Users, and never grant workspace membership. Bearer tokens are `csr_` prefixed and stored hashed.
 */
export class CommerceCustomerPortalService {
  constructor(private readonly db: PrismaClient, readonly publications = new CommercePublicationService(db), readonly stores = new CommerceStoreService(db)) {}

  private async portalStore(tx: Tx, slug: string) {
    const { store } = await this.publications.publicScope(tx, slug);
    const profile = await tx.commerceStoreProfile.findUnique({ where: { storeId: store.id } });
    if (!profile?.portalEnabled) throw new AppError('NOT_FOUND', 'Customer portal is not enabled for this store.', 404);
    return store;
  }
  private async mail(tx: Tx, store: CommerceStore, to: string, kind: string, token: string) {
    // Delivery is performed by the configured notification provider; only a sealed copy is kept for delivery retry.
    await recordProviderCall(tx, { workspaceId: store.workspaceId, module: 'commerce', provider: process.env.CUSTOMER_MAIL_PROVIDER ?? 'SANDBOX', operation: 'CUSTOMER_' + kind,
      idempotencyKey: 'customer-mail:' + sha256(token), outcome: 'QUEUED', payload: { to: encrypt(to), token: encrypt(token) } });
  }

  async register(slug: string, raw: unknown, client: string) {
    const input = parse(z.strictObject({ email, password }), raw);
    checkRateLimit(slug + ':' + client, { scope: 'commerce.customer-register', limit: 10, windowMs: 3600000 });
    const passwordHash = await hashSecret(input.password);
    return this.db.$transaction(async tx => {
      const store = await this.portalStore(tx, slug);
      await lock(tx, store.workspaceId, 'commerce:customer-identity:' + input.email);
      let identity = await tx.commerceCustomerIdentity.findUnique({ where: { workspaceId_emailNormalized: { workspaceId: store.workspaceId, emailNormalized: input.email } } });
      if (!identity) {
        identity = await tx.commerceCustomerIdentity.create({ data: { workspaceId: store.workspaceId, emailNormalized: input.email, passwordHash, createdByStoreId: store.id } });
        await systemEvent(tx, store.workspaceId, 'COMMERCE_CUSTOMER', identity.id, 'CUSTOMER_IDENTITY_REGISTERED', { storeId: store.id });
      }
      // Cross-store reuse inside the same workspace only; existing identities are not disclosed.
      await tx.commerceCustomerStoreMembership.upsert({ where: { identityId_storeId: { identityId: identity.id, storeId: store.id } }, create: { identityId: identity.id, storeId: store.id, workspaceId: store.workspaceId }, update: {} });
      if (!identity.verifiedAt) {
        const token = newToken();
        await tx.commerceCustomerToken.create({ data: { workspaceId: store.workspaceId, storeId: store.id, identityId: identity.id, purpose: 'VERIFY_EMAIL', tokenHash: sha256(token), expiresAt: new Date(Date.now() + 86400000) } });
        await this.mail(tx, store, input.email, 'VERIFY_EMAIL', token);
      }
      return { accepted: true, verificationRequired: true };
    });
  }

  async verify(slug: string, raw: unknown) {
    const input = parse(z.strictObject({ token: z.string().min(20).max(200) }), raw);
    return this.db.$transaction(async tx => {
      const store = await this.portalStore(tx, slug);
      const row = await tx.commerceCustomerToken.findUnique({ where: { tokenHash: sha256(input.token) } });
      if (!row || row.workspaceId !== store.workspaceId || row.purpose !== 'VERIFY_EMAIL' || !row.identityId) throw new AppError('NOT_FOUND', 'Verification link is invalid.', 404);
      if (row.consumedAt || row.revokedAt || row.expiresAt <= new Date()) throw new AppError('RESOURCE_EXPIRED', 'Verification link expired.', 410);
      await tx.commerceCustomerToken.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
      await tx.commerceCustomerIdentity.update({ where: { id: row.identityId }, data: { verifiedAt: new Date() } });
      return { verified: true };
    });
  }

  async login(slug: string, raw: unknown, client: string) {
    const input = parse(z.strictObject({ email, password: z.string().min(1).max(128) }), raw);
    checkRateLimit(slug + ':' + client, { scope: 'commerce.customer-login', limit: 20, windowMs: 900000 });
    checkRateLimit(slug + ':' + input.email, { scope: 'commerce.customer-login-account', limit: 10, windowMs: 900000 });
    return this.db.$transaction(async tx => {
      const store = await this.portalStore(tx, slug);
      const identity = await tx.commerceCustomerIdentity.findUnique({ where: { workspaceId_emailNormalized: { workspaceId: store.workspaceId, emailNormalized: input.email } } });
      const denied = new AppError('UNAUTHENTICATED', 'Email or password is incorrect.', 401);
      if (!identity || identity.status !== 'ACTIVE') throw denied;
      if (identity.lockedUntil && identity.lockedUntil > new Date()) throw new AppError('RATE_LIMITED', 'Account is temporarily locked.', 429);
      if (!await verifyHash(identity.passwordHash, input.password)) {
        const failed = identity.failedAttempts + 1;
        await tx.commerceCustomerIdentity.update({ where: { id: identity.id }, data: { failedAttempts: failed, lockedUntil: failed >= 5 ? new Date(Date.now() + 900000) : null } });
        throw denied;
      }
      if (!identity.verifiedAt) throw new AppError('PERMISSION_DENIED', 'Verify your email before signing in.', 403);
      if (!await tx.commerceCustomerStoreMembership.findUnique({ where: { identityId_storeId: { identityId: identity.id, storeId: store.id } } }))
        await tx.commerceCustomerStoreMembership.create({ data: { identityId: identity.id, storeId: store.id, workspaceId: store.workspaceId } });
      await tx.commerceCustomerIdentity.update({ where: { id: identity.id }, data: { failedAttempts: 0, lockedUntil: null } });
      const token = newToken('csr_');
      await tx.commerceCustomerToken.create({ data: { workspaceId: store.workspaceId, storeId: store.id, identityId: identity.id, purpose: 'SESSION', tokenHash: sha256(token), expiresAt: new Date(Date.now() + SESSION_TTL) } });
      return { accessToken: token, tokenType: 'Bearer', expiresIn: SESSION_TTL / 1000 };
    });
  }

  async recover(slug: string, raw: unknown, client: string) {
    const input = parse(z.strictObject({ email }), raw);
    checkRateLimit(slug + ':' + client, { scope: 'commerce.customer-recover', limit: 5, windowMs: 3600000 });
    return this.db.$transaction(async tx => {
      const store = await this.portalStore(tx, slug);
      const identity = await tx.commerceCustomerIdentity.findUnique({ where: { workspaceId_emailNormalized: { workspaceId: store.workspaceId, emailNormalized: input.email } } });
      if (identity?.status === 'ACTIVE') {
        const token = newToken();
        await tx.commerceCustomerToken.create({ data: { workspaceId: store.workspaceId, storeId: store.id, identityId: identity.id, purpose: 'RESET_PASSWORD', tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600000) } });
        await this.mail(tx, store, input.email, 'RESET_PASSWORD', token);
      }
      return { accepted: true }; // Never discloses whether the account exists.
    });
  }

  async resetPassword(slug: string, raw: unknown) {
    const input = parse(z.strictObject({ token: z.string().min(20).max(200), password }), raw);
    const passwordHash = await hashSecret(input.password);
    return this.db.$transaction(async tx => {
      const store = await this.portalStore(tx, slug);
      const row = await tx.commerceCustomerToken.findUnique({ where: { tokenHash: sha256(input.token) } });
      if (!row || row.workspaceId !== store.workspaceId || row.purpose !== 'RESET_PASSWORD' || !row.identityId) throw new AppError('NOT_FOUND', 'Reset link is invalid.', 404);
      if (row.consumedAt || row.revokedAt || row.expiresAt <= new Date()) throw new AppError('RESOURCE_EXPIRED', 'Reset link expired.', 410);
      await tx.commerceCustomerToken.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
      await tx.commerceCustomerIdentity.update({ where: { id: row.identityId }, data: { passwordHash, failedAttempts: 0, lockedUntil: null } });
      await tx.commerceCustomerToken.updateMany({ where: { identityId: row.identityId, purpose: 'SESSION', revokedAt: null }, data: { revokedAt: new Date() } });
      return { reset: true };
    });
  }

  /** Resolves a customer session or a guest order-access token. Employee bearer tokens are never accepted. */
  async subject(tx: Tx, authorization: string | null) {
    if (!authorization?.startsWith('Bearer ')) throw new AppError('UNAUTHENTICATED', 'Customer authentication is required.', 401);
    const token = authorization.slice(7);
    if (!token.startsWith('csr_') && !token.startsWith('goa_')) throw new AppError('UNAUTHENTICATED', 'A storefront customer credential is required.', 401);
    const row = await tx.commerceCustomerToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.revokedAt || !['SESSION', 'GUEST_ORDER_SESSION'].includes(row.purpose)) throw new AppError('UNAUTHENTICATED', 'Customer session is invalid.', 401);
    if (row.expiresAt <= new Date()) throw new AppError('RESOURCE_EXPIRED', 'Customer session expired.', 410);
    if (row.identityId) {
      const identity = await tx.commerceCustomerIdentity.findFirst({ where: { id: row.identityId, workspaceId: row.workspaceId, status: 'ACTIVE' } });
      if (!identity) throw new AppError('UNAUTHENTICATED', 'Customer account is unavailable.', 401);
      return { workspaceId: row.workspaceId, storeId: row.storeId, identityId: identity.id, email: identity.emailNormalized, orderId: null as string | null };
    }
    return { workspaceId: row.workspaceId, storeId: row.storeId, identityId: null as string | null, email: null as string | null, orderId: row.orderId };
  }
  /** Customer ownership: guest token → exact order; account → orders placed with the verified identity email. */
  async ownedOrder(tx: Tx, subject: Awaited<ReturnType<CommerceCustomerPortalService['subject']>>, orderId: string) {
    parse(uuid, orderId);
    const order = await tx.commerceOrder.findFirst({ where: { workspaceId: subject.workspaceId, id: orderId } });
    const owned = order && (subject.orderId ? subject.orderId === order.id
      : (order.snapshot as { customer?: { email?: string } }).customer?.email?.toLowerCase() === subject.email && await tx.commerceCustomerStoreMembership.findUnique({ where: { identityId_storeId: { identityId: subject.identityId!, storeId: order.storeId } } }));
    if (!order || !owned) throw new AppError('NOT_FOUND', 'Order was not found.', 404);
    return order;
  }

  async orders(authorization: string | null, raw: unknown) {
    const query = parse(pageQuery.omit({ search: true }), raw);
    return this.db.$transaction(async tx => {
      const subject = await this.subject(tx, authorization);
      if (subject.orderId) { const order = await this.ownedOrder(tx, subject, subject.orderId); return { data: [customerOrderView(order)], meta: { page: 1, limit: 1, total: 1, totalPages: 1 } }; }
      const stores = (await tx.commerceCustomerStoreMembership.findMany({ where: { identityId: subject.identityId!, workspaceId: subject.workspaceId } })).map(m => m.storeId);
      const rows = await tx.commerceOrder.findMany({ where: { workspaceId: subject.workspaceId, storeId: { in: stores }, snapshot: { path: ['customer', 'email'], equals: subject.email! } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
      return { data: rows.slice((query.page - 1) * query.limit, query.page * query.limit).map(customerOrderView), meta: { page: query.page, limit: query.limit, total: rows.length, totalPages: Math.ceil(rows.length / query.limit) } };
    });
  }
  async order(authorization: string | null, orderId: string) {
    return this.db.$transaction(async tx => customerOrderView(await this.ownedOrder(tx, await this.subject(tx, authorization), orderId)));
  }
  async tracking(authorization: string | null, orderId: string) {
    return this.db.$transaction(async tx => {
      const order = await this.ownedOrder(tx, await this.subject(tx, authorization), orderId);
      const shipments = await tx.commerceShipment.findMany({ where: { workspaceId: order.workspaceId, orderId }, orderBy: { createdAt: 'asc' } });
      // Warehouse identifiers and internal notes are masked from customers.
      return shipments.map(s => ({ id: s.id, status: s.status, trackingNumber: s.trackingNumber, shippedAt: s.shippedAt, deliveredAt: s.deliveredAt }));
    });
  }
  async cancelRequest(authorization: string | null, orderId: string, raw: unknown) {
    const input = parse(z.strictObject({ reason: z.string().trim().min(1).max(500) }), raw);
    return this.db.$transaction(async tx => {
      const order = await this.ownedOrder(tx, await this.subject(tx, authorization), orderId);
      if (['CANCELLED', 'COMPLETED'].includes(order.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Order can no longer be cancelled.', 409);
      await tx.commerceOrderHistory.create({ data: { workspaceId: order.workspaceId, storeId: order.storeId, orderId, action: 'CUSTOMER_CANCEL_REQUESTED', details: { reasonLength: input.reason.length } } });
      await systemEvent(tx, order.workspaceId, 'COMMERCE_ORDER', orderId, 'ORDER_CANCEL_REQUESTED', { source: 'CUSTOMER' });
      return { orderId, requested: true, status: order.status };
    });
  }
  async returnRequest(authorization: string | null, orderId: string, raw: unknown) {
    const input = parse(z.strictObject({ items: z.array(z.strictObject({ orderLineId: uuid, quantity: z.string().regex(/^\d+(?:\.\d{1,6})?$/) })).min(1).max(100), reason: z.string().trim().min(1).max(500) }), raw);
    return this.db.$transaction(async tx => {
      const order = await this.ownedOrder(tx, await this.subject(tx, authorization), orderId);
      await tx.commerceOrderHistory.create({ data: { workspaceId: order.workspaceId, storeId: order.storeId, orderId, action: 'CUSTOMER_RETURN_REQUESTED', details: { items: input.items } } });
      await systemEvent(tx, order.workspaceId, 'COMMERCE_ORDER', orderId, 'RETURN_REQUESTED', { source: 'CUSTOMER', lineCount: input.items.length });
      // Staff create the authoritative Return after eligibility review (quantities are revalidated there).
      return { orderId, requested: true };
    });
  }

  /** Issues a hashed one-time guest order link (purpose GUEST_ORDER_LINK). */
  static async issueGuestLink(tx: Tx, order: CommerceOrder) {
    const token = newToken();
    await tx.commerceCustomerToken.create({ data: { workspaceId: order.workspaceId, storeId: order.storeId, orderId: order.id, purpose: 'GUEST_ORDER_LINK', tokenHash: sha256(token), expiresAt: new Date(Date.now() + GUEST_LINK_TTL) } });
    await systemEvent(tx, order.workspaceId, 'COMMERCE_ORDER', order.id, 'GUEST_ORDER_ACCESS_ISSUED', {});
    return token;
  }
  /** POST /public/order-access/exchange: one-time link → short-lived order-scoped session. */
  async exchange(raw: unknown, client: string) {
    const input = parse(z.strictObject({ token: z.string().min(20).max(200) }), raw);
    checkRateLimit(client, { scope: 'commerce.order-access', limit: 30, windowMs: 600000 });
    return this.db.$transaction(async tx => {
      const row = await tx.commerceCustomerToken.findUnique({ where: { tokenHash: sha256(input.token) } });
      if (!row || row.purpose !== 'GUEST_ORDER_LINK' || !row.orderId) throw new AppError('NOT_FOUND', 'Order link is invalid.', 404);
      if (row.consumedAt || row.revokedAt || row.expiresAt <= new Date()) throw new AppError('RESOURCE_EXPIRED', 'Order link expired or was already used.', 410);
      await tx.commerceCustomerToken.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
      const session = newToken('goa_');
      await tx.commerceCustomerToken.create({ data: { workspaceId: row.workspaceId, storeId: row.storeId, orderId: row.orderId, purpose: 'GUEST_ORDER_SESSION', tokenHash: sha256(session), expiresAt: new Date(Date.now() + 3600000) } });
      return { accessToken: session, tokenType: 'Bearer', expiresIn: 3600, orderId: row.orderId };
    });
  }

  /** Admin: issue guest link for an order (COMMERCE.CUSTOMER_MANAGE). */
  async adminIssueGuestLink(actor: Principal, orderId: string) {
    return this.db.$transaction(async tx => {
      actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      const order = await tx.commerceOrder.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, orderId) } });
      if (!order) throw new AppError('NOT_FOUND', 'Order was not found.', 404);
      await this.stores.store(tx, actor, order.storeId, 'COMMERCE.CUSTOMER_MANAGE');
      const token = await CommerceCustomerPortalService.issueGuestLink(tx, order);
      await evidence(tx, actor, 'COMMERCE_ORDER', orderId, 'GUEST_ORDER_ACCESS_ISSUED_BY_STAFF', {});
      return { token, expiresInDays: GUEST_LINK_TTL / 86400000 };
    });
  }
  async setIdentityStatus(actor: Principal, identityId: string, raw: unknown) {
    const input = parse(z.strictObject({ status: z.enum(['ACTIVE', 'LOCKED', 'DISABLED']), reason: z.string().trim().min(1).max(500) }), raw);
    return this.db.$transaction(async tx => {
      actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      const identity = await tx.commerceCustomerIdentity.findFirst({ where: { workspaceId: actor.workspaceId, id: parse(uuid, identityId) } });
      if (!identity) throw new AppError('NOT_FOUND', 'Customer was not found.', 404);
      await this.stores.store(tx, actor, identity.createdByStoreId, 'COMMERCE.CUSTOMER_MANAGE');
      const updated = await tx.commerceCustomerIdentity.update({ where: { id: identity.id }, data: { status: input.status } });
      if (input.status !== 'ACTIVE') await tx.commerceCustomerToken.updateMany({ where: { identityId: identity.id, purpose: 'SESSION', revokedAt: null }, data: { revokedAt: new Date() } });
      await evidence(tx, actor, 'COMMERCE_CUSTOMER', identity.id, 'CUSTOMER_IDENTITY_STATUS_CHANGED', { status: input.status });
      return { id: updated.id, status: updated.status };
    });
  }
  static checkoutAllowed = CommerceStoreAdminService.assertCheckoutAllowed;
}
