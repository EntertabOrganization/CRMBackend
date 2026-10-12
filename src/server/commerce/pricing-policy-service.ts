import { Prisma,type PrismaClient,type CommerceDiscountRule } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors';
import { evidence,lock,resolvePrincipal,type Principal } from '../process-platform/context';
import { parse,uuid,code,name,decimal,pageQuery } from '../process-platform/dto';
import { fitsCurrency,toScaled } from '../catalog/money';
import { exact } from '../inventory/decimal';
import { commerceVersion,assertCommerceVersion } from './dto';
import { CommerceStoreService } from './store-service';
import { commerceCatalogPort } from './catalog-port';

const uniqueIds = z.array(uuid).max(1000).refine(ids => new Set(ids).size===ids.length);
export const promotionEligibility = z.strictObject({ productIds: uniqueIds.optional(),categoryIds: uniqueIds.optional(),
  minimumQuantity: decimal.optional(),minimumSubtotal: decimal.optional(),customerKind: z.enum(['ANY','GUEST','REGISTERED']).default('ANY'),
  regions: z.array(z.string().regex(/^[A-Z]{2}(?:-[A-Z0-9]{1,10})?$/)).max(250).optional() });
const limits = z.strictObject({ total: z.number().int().positive().max(2147483647).nullable().optional(),perCustomer: z.number().int().positive().max(2147483647).nullable().optional() });
const kind = z.enum(['PERCENT','FIXED','FREE_SHIPPING']);
const promotion = z.strictObject({ code,name: name.optional(),kind,value: decimal,eligibility: promotionEligibility.default({ customerKind: 'ANY' }),
  combinable: z.boolean().default(false),priority: z.number().int().min(0).max(1000000).default(100),limits: limits.optional(),
  appliesTo: z.enum(['LINE','ORDER','SHIPPING']).optional(),stackGroup: code.optional(),startAt: z.iso.datetime({ offset: true }).nullable().optional(),
  endAt: z.iso.datetime({ offset: true }).nullable().optional(),active: z.boolean().default(true) });
const promotionPatch = z.strictObject({ expectedVersion: commerceVersion,code: code.optional(),name: name.optional(),kind: kind.optional(),value: decimal.optional(),
  eligibility: promotionEligibility.optional(),combinable: z.boolean().optional(),priority: z.number().int().min(0).max(1000000).optional(),limits: limits.optional(),
  appliesTo: z.enum(['LINE','ORDER','SHIPPING']).optional(),stackGroup: code.optional(),startAt: z.iso.datetime({ offset: true }).nullable().optional(),
  endAt: z.iso.datetime({ offset: true }).nullable().optional(),active: z.boolean().optional() });
function ruleSnapshot(row: CommerceDiscountRule): Prisma.InputJsonObject {
  return { code: row.code,name: row.name,kind: row.kind,value: row.value.toFixed(6),appliesTo: row.appliesTo,priority: row.priority,stackGroup: row.stackGroup,
    combinable: row.combinable,eligibility: row.eligibility,usageLimit: row.usageLimit,perCustomerLimit: row.perCustomerLimit,
    startAt: row.startsAt?.toISOString() ?? null,endAt: row.endsAt?.toISOString() ?? null,active: row.active,version: row.version.toString() };
}
export function couponHash(storeId: string,value: string) { return createHash('sha256').update(storeId + ':' + value.trim().toUpperCase()).digest('hex'); }
export class CommercePricingPolicyService {
  constructor(private readonly db: PrismaClient,readonly stores = new CommerceStoreService(db)) {}
  private validRule(rule: { kind: string;value: string;appliesTo: string;startAt?: string | null;endAt?: string | null },denomination: string) {
    if (rule.kind==='PERCENT' && exact(rule.value).gt(100) || rule.kind==='FREE_SHIPPING' && (!exact(rule.value).eq(0) || rule.appliesTo!=='SHIPPING'))
      throw new AppError('COMMERCE_PROMOTION_CONFLICT','Promotion amount or scope is invalid.',422);
    if (rule.kind==='FIXED' && !fitsCurrency(toScaled(rule.value)!,denomination)) throw new AppError('COMMERCE_PRICE_INVALID','Fixed discount exceeds currency precision.',422);
    if (rule.startAt && rule.endAt && new Date(rule.startAt)>=new Date(rule.endAt)) throw new AppError('COMMERCE_PROMOTION_CONFLICT','Promotion window is invalid.',422);
  }
  async list(actor: Principal,storeId: string,raw: unknown,taxes = false) {
    const query = parse(pageQuery,raw);
    return this.db.$transaction(async tx => {
      await this.stores.store(tx,actor,storeId,taxes ? 'COMMERCE.TAX_VIEW' : 'COMMERCE.PROMOTION_VIEW');
      const where = { workspaceId: actor.workspaceId,storeId };
      if (taxes) {
        const [data,total] = await Promise.all([tx.commerceTaxRule.findMany({ where,orderBy: [{ effectiveFrom: 'desc' },{ id: 'asc' }],skip: (query.page-1)*query.limit,take: query.limit }),tx.commerceTaxRule.count({ where })]);
        return { data,meta: { page: query.page,limit: query.limit,total,totalPages: Math.ceil(total/query.limit) } };
      }
      const [data,total] = await Promise.all([tx.commerceDiscountRule.findMany({ where,orderBy: [{ priority: 'asc' },{ id: 'asc' }],skip: (query.page-1)*query.limit,take: query.limit }),tx.commerceDiscountRule.count({ where })]);
      return { data,meta: { page: query.page,limit: query.limit,total,totalPages: Math.ceil(total/query.limit) } };
    });
  }
  async create(actor: Principal,storeId: string,raw: unknown) {
    const input = parse(promotion,raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'commerce:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const store = await this.stores.store(tx,actor,storeId,'COMMERCE.PROMOTION_MANAGE');
      const appliesTo = input.appliesTo ?? (input.kind==='FREE_SHIPPING' ? 'SHIPPING' : 'ORDER'); this.validRule({ ...input,appliesTo },store.defaultCurrency);
      (await commerceCatalogPort(tx,actor.workspaceId,actor)).references(store.catalogId,input.eligibility);
      const row = await tx.commerceDiscountRule.create({ data: { workspaceId: actor.workspaceId,storeId,code: input.code,name: input.name ?? input.code,kind: input.kind,value: input.value,
        appliesTo,priority: input.priority,stackGroup: input.stackGroup ?? 'DEFAULT',combinable: input.combinable,eligibility: input.eligibility as Prisma.InputJsonValue,
        usageLimit: input.limits?.total,perCustomerLimit: input.limits?.perCustomer,
        startsAt: input.startAt ? new Date(input.startAt) : null,endsAt: input.endAt ? new Date(input.endAt) : null,active: input.active } });
      await tx.commerceStore.update({ where: { id: storeId },data: { version: { increment: 1 } } });
      await evidence(tx,actor,'COMMERCE_PROMOTION',row.id,'COMMERCE_PROMOTION_CREATED',{ storeId,after: ruleSnapshot(row) }); return row;
    },{ timeout: 60000 });
  }
  async update(actor: Principal,id: string,raw: unknown) {
    parse(uuid,id); const input = parse(promotionPatch,raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'commerce:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const current = await tx.commerceDiscountRule.findFirst({ where: { workspaceId: actor.workspaceId,id } });
      if (!current) throw new AppError('COMMERCE_PROMOTION_NOT_FOUND','Promotion was not found.',404);
      const store = await this.stores.store(tx,actor,current.storeId,'COMMERCE.PROMOTION_MANAGE'); assertCommerceVersion(current.version,input.expectedVersion);
      const effective = { kind: input.kind ?? current.kind,value: input.value ?? current.value.toFixed(6),appliesTo: input.appliesTo ?? current.appliesTo,
        startAt: input.startAt===undefined ? current.startsAt?.toISOString() : input.startAt,endAt: input.endAt===undefined ? current.endsAt?.toISOString() : input.endAt };
      this.validRule(effective,store.defaultCurrency);
      if (input.eligibility) (await commerceCatalogPort(tx,actor.workspaceId,actor)).references(store.catalogId,input.eligibility);
      const { expectedVersion,limits: usage,startAt,endAt,...data } = input;
      const row = await tx.commerceDiscountRule.update({ where: { id },data: { ...data,eligibility: input.eligibility as Prisma.InputJsonValue | undefined,
        ...(usage?.total!==undefined ? { usageLimit: usage.total } : {}),...(usage?.perCustomer!==undefined ? { perCustomerLimit: usage.perCustomer } : {}),
        ...(startAt!==undefined ? { startsAt: startAt ? new Date(startAt) : null } : {}),...(endAt!==undefined ? { endsAt: endAt ? new Date(endAt) : null } : {}),version: { increment: 1 } } });
      await tx.commerceStore.update({ where: { id: store.id },data: { version: { increment: 1 } } });
      await evidence(tx,actor,'COMMERCE_PROMOTION',id,'COMMERCE_PROMOTION_CHANGED',{ storeId: store.id,before: ruleSnapshot(current),after: ruleSnapshot(row) }); return row;
    },{ timeout: 60000 });
  }
  async coupon(actor: Principal,id: string,raw: unknown) {
    parse(uuid,id); const input = parse(z.strictObject({ code: z.string().trim().toUpperCase().min(3).max(80).regex(/^[A-Z0-9_-]+$/),
      usageLimit: z.number().int().positive().max(2147483647).optional(),perCustomerLimit: z.number().int().positive().max(2147483647).optional(),expiresAt: z.iso.datetime({ offset: true }).optional() }),raw);
    if (input.expiresAt && new Date(input.expiresAt)<=new Date()) throw new AppError('COMMERCE_COUPON_EXPIRED','Coupon expiry must be in the future.',422);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'commerce:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const rule = await tx.commerceDiscountRule.findFirst({ where: { workspaceId: actor.workspaceId,id } });
      if (!rule) throw new AppError('COMMERCE_PROMOTION_NOT_FOUND','Promotion was not found.',404);
      await this.stores.store(tx,actor,rule.storeId,'COMMERCE.PROMOTION_MANAGE');
      const row = await tx.commerceCoupon.create({ data: { workspaceId: actor.workspaceId,storeId: rule.storeId,ruleId: id,codeHash: couponHash(rule.storeId,input.code),
        usageLimit: input.usageLimit,perCustomerLimit: input.perCustomerLimit,expiresAt: input.expiresAt ? new Date(input.expiresAt) : null } });
      await tx.commerceStore.update({ where: { id: rule.storeId },data: { version: { increment: 1 } } });
      await evidence(tx,actor,'COMMERCE_PROMOTION',id,'COMMERCE_COUPON_CREATED',{ couponId: row.id,storeId: rule.storeId });
      return { id: row.id,ruleId: id,code: input.code,usageLimit: row.usageLimit,perCustomerLimit: row.perCustomerLimit,expiresAt: row.expiresAt,active: row.active };
    });
  }
  async tax(actor: Principal,raw: unknown,storeId?: string,id?: string) {
    if (storeId) parse(uuid,storeId); if (id) parse(uuid,id);
    const input = id ? parse(z.strictObject({ expectedVersion: commerceVersion,effectiveTo: z.iso.datetime({ offset: true }) }),raw)
      : parse(z.strictObject({ region: z.string().regex(/^(?:\*|[A-Z]{2}(?:-[A-Z0-9]{1,10})?)$/),categoryId: uuid.optional(),rate: decimal.refine(value => exact(value).lte(100)),
        priceBasis: z.enum(['INCLUSIVE','EXCLUSIVE']),effectiveFrom: z.iso.datetime({ offset: true }),effectiveTo: z.iso.datetime({ offset: true }).optional() }),raw);
    return this.db.$transaction(async tx => {
      await lock(tx,actor.workspaceId,'commerce:configuration'); actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const current = id ? await tx.commerceTaxRule.findFirst({ where: { workspaceId: actor.workspaceId,id } }) : null;
      if (id && !current) throw new AppError('COMMERCE_TAX_RULE_INVALID','Tax rule was not found.',404);
      const store = await this.stores.store(tx,actor,current?.storeId ?? storeId!,'COMMERCE.TAX_MANAGE');
      if (current && 'expectedVersion' in input) {
        assertCommerceVersion(current.version,input.expectedVersion);
        const end = new Date(input.effectiveTo);
        if (end<=new Date() || end<=current.effectiveFrom || current.effectiveTo && current.effectiveTo<=new Date()) throw new AppError('COMMERCE_TAX_RULE_INVALID','Only an effective rule can receive a future closing date.',422);
        if (await tx.commerceTaxRule.count({ where: { workspaceId: actor.workspaceId,storeId: store.id,id: { not: current.id },region: current.region,categoryId: current.categoryId,
          effectiveFrom: { lt: end },OR: [{ effectiveTo: null },{ effectiveTo: { gt: current.effectiveFrom } }] } })) throw new AppError('COMMERCE_TAX_RULE_INVALID','Closing date overlaps another tax rule.',409);
        const row = await tx.commerceTaxRule.update({ where: { id: current.id },data: { effectiveTo: end,version: { increment: 1 } } });
        await tx.commerceStore.update({ where: { id: store.id },data: { version: { increment: 1 } } });
        await evidence(tx,actor,'COMMERCE_TAX_RULE',row.id,'COMMERCE_TAX_RULE_CLOSED',{ before: { effectiveTo: current.effectiveTo?.toISOString() ?? null },after: { effectiveTo: end.toISOString() },version: row.version.toString() }); return row;
      }
      if (!('region' in input)) throw new AppError('COMMERCE_TAX_RULE_INVALID','Tax rule creation input is invalid.',400);
      const start = new Date(input.effectiveFrom),end = input.effectiveTo ? new Date(input.effectiveTo) : null;
      if (end && start>=end) throw new AppError('COMMERCE_TAX_RULE_INVALID','Tax validity window is invalid.',422);
      if (input.categoryId) (await commerceCatalogPort(tx,actor.workspaceId,actor)).references(store.catalogId,{ categoryIds: [input.categoryId] });
      const overlap = await tx.commerceTaxRule.count({ where: { workspaceId: actor.workspaceId,storeId: store.id,region: input.region,categoryId: input.categoryId ?? null,
        ...(end ? { effectiveFrom: { lt: end } } : {}),OR: [{ effectiveTo: null },{ effectiveTo: { gt: start } }] } });
      if (overlap) throw new AppError('COMMERCE_TAX_RULE_INVALID','An effective tax rule overlaps this region/category window.',409);
      const row = await tx.commerceTaxRule.create({ data: { workspaceId: actor.workspaceId,storeId: store.id,region: input.region,categoryId: input.categoryId,rate: input.rate,
        priceBasis: input.priceBasis,effectiveFrom: start,effectiveTo: end } });
      await tx.commerceStore.update({ where: { id: store.id },data: { version: { increment: 1 } } });
      await evidence(tx,actor,'COMMERCE_TAX_RULE',row.id,'COMMERCE_TAX_RULE_CREATED',{ storeId: store.id,region: row.region,rate: row.rate.toFixed(6),priceBasis: row.priceBasis,effectiveFrom: row.effectiveFrom.toISOString(),effectiveTo: row.effectiveTo?.toISOString() ?? null,version: row.version.toString() }); return row;
    },{ timeout: 60000 });
  }
}
