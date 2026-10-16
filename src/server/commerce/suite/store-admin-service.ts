import type { CommerceStore, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../../errors';
import { code as codeDto, name as nameDto, parse, timezone, uuid } from '../../process-platform/dto';
import { evidence, lock, requirePermission, resolvePrincipal, type Principal, type Tx } from '../../process-platform/context';
import { commerceCurrency, slug } from '../dto';
import { CommerceStoreService } from '../store-service';
import { commerceCatalogPort } from '../catalog-port';
import { assertVersion, expectedVersion, policyMissing } from '../../suite/kernel';

const locale = z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/);
export const storePolicyDto = z.strictObject({
  reservationTtlSeconds: z.number().int().min(60).max(604800).optional(),
  backordersEnabled: z.boolean().optional(), guestCheckoutEnabled: z.boolean().optional(), ordersCreateDeals: z.boolean().optional(),
  portalEnabled: z.boolean().optional(), invoicePolicy: z.enum(['NONE', 'ON_ORDER', 'ON_PAYMENT']).optional(),
  discountStackingMode: z.enum(['PRIORITY', 'BEST_FOR_CUSTOMER', 'NONE']).optional(),
  digitalAccessPolicy: z.strictObject({ downloadLimit: z.number().int().min(1).max(1000).optional(), accessDays: z.number().int().min(1).max(3650).optional(), revokeOnRefund: z.boolean().default(true) }).optional(),
  allowedReturnHosts: z.array(z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/)).max(20).optional(),
  retentionConfigured: z.boolean().optional(),
});
const createDto = z.strictObject({ name: nameDto, slug, code: codeDto.optional(), mode: z.enum(['WEB', 'HEADLESS', 'HYBRID']).default('HYBRID'), defaultCurrency: commerceCurrency,
  defaultLocale: locale.default('en'), timezone, catalogId: uuid, policy: storePolicyDto.default({}) });

/** Store administration extension (spec OnlineStore-Commerce/01): slug, mode, locale, policy, readiness, channels, archive. */
export class CommerceStoreAdminService {
  constructor(private readonly db: PrismaClient, readonly stores = new CommerceStoreService(db)) {}

  async profile(tx: Tx, store: CommerceStore) {
    return await tx.commerceStoreProfile.findUnique({ where: { storeId: store.id } })
      ?? await tx.commerceStoreProfile.create({ data: { storeId: store.id, workspaceId: store.workspaceId, slug: store.code.toLowerCase().replace(/_/g, '-') } });
  }
  private quota(actor: Principal, kind: 'commerceStoreLimit' | 'commerceActiveStoreLimit') {
    const limit = actor.entitlements?.[kind];
    return typeof limit === 'number' ? limit : null;
  }

  /** POST /commerce/stores with the extended contract (slug/mode/locale/policy). Legacy `code`-only payloads stay supported. */
  async create(actor: Principal, raw: unknown) {
    if (!raw || typeof raw !== 'object' || !('slug' in raw)) return this.stores.create(actor, raw);
    const input = parse(createDto, raw);
    if (input.policy && 'workspaceId' in (raw as Record<string, unknown>)) throw new AppError('VALIDATION_FAILED', 'workspaceId is not accepted.', 400);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'commerce:configuration'); actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId); requirePermission(actor, 'COMMERCE.STORE_MANAGE');
      const limit = this.quota(actor, 'commerceStoreLimit');
      if (limit !== null && await tx.commerceStore.count({ where: { workspaceId: actor.workspaceId, status: { not: 'ARCHIVED' } } }) >= limit)
        throw new AppError('PLAN_LIMIT_REACHED', 'Store quota reached for this subscription.', 403);
      if (await tx.commerceStoreProfile.findUnique({ where: { workspaceId_slug: { workspaceId: actor.workspaceId, slug: input.slug } } }))
        throw new AppError('STORE_SLUG_CONFLICT', 'Store slug is already used in this Workspace.', 409);
      const code = input.code ?? input.slug.toUpperCase().replace(/-/g, '_').replace(/^([^A-Z])/, 'S_$1').slice(0, 64);
      if (await tx.commerceStore.findFirst({ where: { workspaceId: actor.workspaceId, code } })) throw new AppError('STORE_SLUG_CONFLICT', 'Store code is already used.', 409);
      const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: actor.workspaceId } });
      if ((workspace.settings as { entitlements?: { commerce?: boolean } }).entitlements?.commerce === false) throw new AppError('PERMISSION_DENIED', 'Commerce is unavailable.', 403);
      const catalog = (await commerceCatalogPort(tx, actor.workspaceId, actor)).configuration(input.catalogId);
      const store = await tx.commerceStore.create({ data: { workspaceId: actor.workspaceId, name: input.name, code, defaultCurrency: input.defaultCurrency, timezone: input.timezone,
        catalogId: input.catalogId, priceTypeId: catalog.priceTypeId, createdByUserId: actor.userId } });
      const { allowedReturnHosts, digitalAccessPolicy, ...policy } = input.policy;
      const profile = await tx.commerceStoreProfile.create({ data: { storeId: store.id, workspaceId: actor.workspaceId, slug: input.slug, mode: input.mode, defaultLocale: input.defaultLocale,
        ...policy, ...(allowedReturnHosts ? { allowedReturnHosts } : {}), ...(digitalAccessPolicy ? { digitalAccessPolicy } : {}) } });
      await evidence(tx, actor, 'COMMERCE_STORE', store.id, 'STORE_CREATED', { slug: profile.slug, mode: profile.mode, currency: store.defaultCurrency });
      return { ...store, slug: profile.slug, mode: profile.mode, defaultLocale: profile.defaultLocale, policy: profile, version: Number(store.version) };
    }, { timeout: 60000 });
  }

  async detail(actor: Principal, id: string) {
    const base = await this.stores.get(actor, id);
    return this.db.$transaction(async tx => {
      const store = await this.stores.store(tx, actor, id, 'COMMERCE.STORE_VIEW'); const profile = await this.profile(tx, store);
      // Merchant secrets never leave payment authority; only method identifiers are listed.
      const settings = store.settings as { paymentMethods?: string[]; providerPaymentMethods?: { id: string; provider: string }[] };
      return { ...base, settings: undefined, paymentMethods: settings.paymentMethods ?? [], providerPaymentMethods: (settings.providerPaymentMethods ?? []).map(m => ({ id: m.id, provider: m.provider })),
        slug: profile.slug, mode: profile.mode, defaultLocale: profile.defaultLocale, policy: { ...profile, storeId: undefined, workspaceId: undefined } };
    });
  }

  async updatePolicy(actor: Principal, id: string, raw: unknown) {
    const input = parse(storePolicyDto.extend({ expectedPolicyVersion: expectedVersion, slug: slug.optional(), mode: z.enum(['WEB', 'HEADLESS', 'HYBRID']).optional(), defaultLocale: locale.optional() }), raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'commerce:configuration'); actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      const store = await this.stores.store(tx, actor, id, 'COMMERCE.STORE_MANAGE'); const profile = await this.profile(tx, store);
      assertVersion(profile.policyVersion, input.expectedPolicyVersion);
      if (input.slug && input.slug !== profile.slug && await tx.commerceStoreProfile.findUnique({ where: { workspaceId_slug: { workspaceId: actor.workspaceId, slug: input.slug } } }))
        throw new AppError('STORE_SLUG_CONFLICT', 'Store slug is already used in this Workspace.', 409);
      const { expectedPolicyVersion, allowedReturnHosts, digitalAccessPolicy, ...data } = input;
      const updated = await tx.commerceStoreProfile.update({ where: { storeId: id }, data: { ...data, ...(allowedReturnHosts ? { allowedReturnHosts } : {}), ...(digitalAccessPolicy ? { digitalAccessPolicy } : {}), policyVersion: { increment: 1 } } });
      await evidence(tx, actor, 'COMMERCE_STORE', id, 'STORE_POLICY_CHANGED', { before: { policyVersion: profile.policyVersion }, after: { ...data, policyVersion: updated.policyVersion } });
      return updated;
    });
  }

  async readiness(actor: Principal, id: string) {
    return this.db.$transaction(async tx => {
      const store = await this.stores.store(tx, actor, id, 'COMMERCE.STORE_VIEW'); return this.evaluate(tx, store);
    }, { timeout: 60000 });
  }
  async evaluate(tx: Tx, store: CommerceStore) {
    const profile = await this.profile(tx, store), settings = store.settings as { paymentMethods?: string[]; deliveryPolicy?: string; providerPaymentMethods?: unknown[]; inventoryPrincipalUserId?: string };
    const blockers: { code: string; message: string }[] = [], now = new Date();
    if (!settings.paymentMethods?.length && !settings.providerPaymentMethods?.length) blockers.push({ code: 'PAYMENT_POLICY_MISSING', message: 'Configure offline or provider payment methods.' });
    if (!settings.deliveryPolicy && !await tx.commerceDeliveryService.count({ where: { workspaceId: store.workspaceId, storeId: store.id, active: true } })) blockers.push({ code: 'DELIVERY_POLICY_MISSING', message: 'Configure pickup or delivery services.' });
    if (!await tx.commerceTaxRule.count({ where: { workspaceId: store.workspaceId, storeId: store.id, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] } }))
      blockers.push({ code: 'TAX_POLICY_MISSING', message: 'Configure tax rules (an explicit 0% rule is allowed); no statutory rate is assumed.' });
    if (!profile.reservationTtlSeconds) blockers.push({ code: 'RESERVATION_TTL_MISSING', message: 'Configure the store reservation TTL.' });
    if (!profile.retentionConfigured && !await tx.suiteRetentionPolicy.count({ where: { workspaceId: store.workspaceId, module: 'commerce' } })) blockers.push({ code: 'RETENTION_POLICY_MISSING', message: 'Configure guest data retention for the jurisdiction.' });
    if (!await tx.commerceStorefront.count({ where: { workspaceId: store.workspaceId, storeId: store.id } }) && !await tx.commerceStoreChannel.count({ where: { workspaceId: store.workspaceId, storeId: store.id } }))
      blockers.push({ code: 'CHANNEL_MISSING', message: 'Configure a storefront or public channel.' });
    if (!await tx.commerceProductPublication.count({ where: { workspaceId: store.workspaceId, storeId: store.id, published: true } })) blockers.push({ code: 'NO_PUBLISHED_PRODUCTS', message: 'Publish at least one product.' });
    const workspace = await tx.workspace.findUnique({ where: { id: store.workspaceId } });
    if ((workspace?.settings as { entitlements?: { commerce?: boolean } })?.entitlements?.commerce === false) blockers.push({ code: 'ENTITLEMENT_MISSING', message: 'Commerce is not included in the subscription.' });
    return { storeId: store.id, status: store.status, ready: blockers.length === 0, blockers, policyVersion: profile.policyVersion,
      dependencies: { payments: 'SHARED_PAYMENTS', inventory: settings.inventoryPrincipalUserId ? 'CONFIGURED' : 'NOT_CONFIGURED', crm: 'SHARED_CRM', sitesDomain: 'SITES_SERVICE' } };
  }

  /** Activation requires the policy readiness (tax/TTL/retention) and the existing owner checks. */
  async activate(actor: Principal, id: string, raw: unknown) {
    await this.db.$transaction(async tx => {
      actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      const store = await this.stores.store(tx, actor, id, 'COMMERCE.STORE_MANAGE'); const result = await this.evaluate(tx, store);
      const policy = result.blockers.find(b => ['TAX_POLICY_MISSING', 'RESERVATION_TTL_MISSING', 'RETENTION_POLICY_MISSING', 'PAYMENT_POLICY_MISSING'].includes(b.code));
      if (policy) throw new AppError('POLICY_NOT_CONFIGURED', policy.message, 409, { blockers: result.blockers });
      const limit = this.quota(actor, 'commerceActiveStoreLimit');
      if (limit !== null && store.status !== 'ACTIVE' && await tx.commerceStore.count({ where: { workspaceId: actor.workspaceId, status: 'ACTIVE' } }) >= limit) throw new AppError('PLAN_LIMIT_REACHED', 'Active store quota reached.', 403);
    });
    const activated = await this.stores.activate(actor, id, raw);
    await this.db.$transaction(tx => evidence(tx, actor, 'COMMERCE_STORE', id, 'STORE_ACTIVATED', { version: activated.version.toString() }, false));
    return activated;
  }
  async suspend(actor: Principal, id: string, raw: unknown) {
    const result = await this.stores.update(actor, id, raw, true);
    await this.db.$transaction(tx => evidence(tx, actor, 'COMMERCE_STORE', id, 'STORE_SUSPENDED', { version: result.version.toString() }, false));
    return result;
  }

  async addChannel(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ routePrefix: z.string().regex(/^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/).max(160), hostname: z.string().toLowerCase().max(253).optional(), siteId: uuid.optional(), apiClientId: z.string().max(80).optional() }), raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'commerce:configuration'); await lock(tx, '00000000-0000-0000-0000-000000000000', 'public-routes');
      actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId); await this.stores.store(tx, actor, id, 'COMMERCE.STORE_MANAGE');
      const host = input.hostname ?? '*';
      if (input.hostname) {
        const domain = await tx.siteDomain.findUnique({ where: { hostname: input.hostname } });
        if (!domain || domain.workspaceId !== actor.workspaceId || !['VERIFIED', 'CERT_ISSUED'].includes(domain.verificationState)) throw new AppError('DOMAIN_NOT_VERIFIED', 'Hostname must be a verified Sites domain of this Workspace.', 409);
      }
      const prefix = input.routePrefix.replace(/\/$/, '') || '/';
      const collide = (a: string, b: string) => a === b || a.startsWith(b === '/' ? '/' : b + '/') && b !== '/' || b.startsWith(a + '/') && a !== '/';
      const channels = await tx.commerceStoreChannel.findMany({ where: { hostname: host } });
      const routes = input.hostname ? await tx.siteHostRoute.findMany({ where: { hostname: input.hostname, status: 'ACTIVE' } }) : [];
      if (channels.some(c => collide(c.routePrefix, prefix)) || routes.some(r => collide(r.pathPrefix, prefix) && !(r.storeId === id)))
        throw new AppError('ROUTE_COLLISION', 'Store channel route collides with an existing route.', 409);
      const row = await tx.commerceStoreChannel.create({ data: { workspaceId: actor.workspaceId, storeId: id, hostname: host, routePrefix: prefix, siteId: input.siteId, apiClientId: input.apiClientId } });
      await evidence(tx, actor, 'COMMERCE_STORE', id, 'STORE_CHANNEL_ADDED', { channelId: row.id, routePrefix: prefix });
      return row;
    });
  }

  /** Soft archive; historical orders, returns and payments remain intact and readable. */
  async archive(actor: Principal, id: string, raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion: z.union([z.string(), z.number()]).transform(String), reason: z.string().trim().min(1).max(500) }), raw);
    return this.db.$transaction(async tx => {
      await lock(tx, actor.workspaceId, 'commerce:configuration'); actor = await resolvePrincipal(tx, actor.workspaceId, actor.userId);
      const store = await this.stores.store(tx, actor, id, 'COMMERCE.STORE_MANAGE');
      if (store.version.toString() !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Store changed; reload.', 409);
      if (await tx.commerceOrder.count({ where: { workspaceId: actor.workspaceId, storeId: id, status: { notIn: ['COMPLETED', 'CANCELLED'] }, archivedAt: null } }))
        throw new AppError('INVALID_STATE_TRANSITION', 'Store has open orders; suspend it and complete obligations before archiving.', 409);
      const updated = await tx.commerceStore.update({ where: { id }, data: { status: 'ARCHIVED', version: { increment: 1 } } });
      await tx.commerceStoreProfile.update({ where: { storeId: id }, data: { deletedAt: new Date() } }).catch(() => null);
      await evidence(tx, actor, 'COMMERCE_STORE', id, 'STORE_ARCHIVED', { reason: input.reason });
      return updated;
    });
  }

  async entitlementImpact(actor: Principal, id: string) {
    return this.db.$transaction(async tx => {
      const store = await this.stores.store(tx, actor, id, 'COMMERCE.STORE_VIEW');
      const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: actor.workspaceId } });
      const ent = ((workspace.settings as { entitlements?: Record<string, unknown> }).entitlements ?? {}) as Record<string, unknown>;
      const graceEndsAt = typeof ent.commerceGraceEndsAt === 'string' ? new Date(ent.commerceGraceEndsAt) : null;
      const state = ent.commerce === false ? (graceEndsAt && graceEndsAt > new Date() ? 'GRACE' : 'CHECKOUT_BLOCKED') : ent.commerceReadOnly === true ? 'READ_ONLY' : 'STANDARD';
      const [open, paidUnfulfilled, returns] = await Promise.all([
        tx.commerceOrder.count({ where: { workspaceId: actor.workspaceId, storeId: id, status: { notIn: ['COMPLETED', 'CANCELLED'] } } }),
        tx.commerceOrder.count({ where: { workspaceId: actor.workspaceId, storeId: id, paymentStatus: 'PAID', fulfillmentStatus: { not: 'FULFILLED' } } }),
        tx.commerceReturn.count({ where: { workspaceId: actor.workspaceId, storeId: id, status: { notIn: ['COMPLETED', 'REJECTED', 'CANCELLED'] } } })]);
      return { storeId: store.id, capabilityState: state, graceDays: typeof ent.commerceGraceDays === 'number' ? ent.commerceGraceDays : 15, graceEndsAt,
        newCheckout: state === 'STANDARD' || state === 'GRACE' ? 'ALLOWED' : 'BLOCKED', publicCatalog: state === 'CHECKOUT_BLOCKED' && ent.commercePublicCatalog === false ? 'HIDDEN' : 'READABLE',
        preservedObligations: { openOrders: open, paidUnfulfilledOrders: paidUnfulfilled, openReturns: returns } };
    });
  }

  /** Throws when the workspace commerce entitlement blocks new checkout (existing obligations unaffected). */
  static async assertCheckoutAllowed(tx: Tx, workspaceId: string) {
    const workspace = await tx.workspace.findUnique({ where: { id: workspaceId } });
    const ent = ((workspace?.settings as { entitlements?: Record<string, unknown> })?.entitlements ?? {}) as Record<string, unknown>;
    const grace = typeof ent.commerceGraceEndsAt === 'string' && new Date(ent.commerceGraceEndsAt) > new Date();
    if (ent.commerceCheckout === false && !grace) throw new AppError('CHECKOUT_BLOCKED', 'New checkout is unavailable for this store.', 409);
  }
  static policyMissing = policyMissing;
}
