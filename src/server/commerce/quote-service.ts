import type { CommerceCart, CommerceStore } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AppError } from '../errors';
import type { Tx } from '../process-platform/context';
import { canonical, parse } from '../process-platform/dto';
import { calculateRow, currencyDecimals, fromScaled, mulDivRound, scaledHundred, toScaled } from '../catalog/money';
import { exact } from '../inventory/decimal';
import { promotionEligibility, couponHash } from './pricing-policy-service';
import type { CommerceCartService } from './cart-service';

export type QuoteContext = { region: string; customerKey: string; couponCodes: string[]; paymentMethodId: string };
export class CommerceQuoteService {
  constructor(readonly carts: CommerceCartService) {}
  async calculate(tx: Tx,store: CommerceStore,cart: CommerceCart,context: QuoteContext) {
    const now = new Date();
    const rules = await tx.commerceDiscountRule.findMany({ where: { workspaceId: store.workspaceId,storeId: store.id,active: true,
      AND: [{ OR: [{ startsAt: null },{ startsAt: { lte: now } }] },{ OR: [{ endsAt: null },{ endsAt: { gt: now } }] }] },orderBy: [{ priority: 'asc' },{ id: 'asc' }] });
    const allCoupons = await tx.commerceCoupon.findMany({ where: { workspaceId: store.workspaceId,storeId: store.id } });
    const requested = context.couponCodes.map(code => allCoupons.find(c => c.codeHash===couponHash(store.id,code)));
    if (requested.some(c => !c || !c.active || c.expiresAt && c.expiresAt<=now || !rules.some(r => r.id===c.ruleId)))
      throw new AppError('COMMERCE_COUPON_INVALID','Coupon is unavailable.',422);
    if (new Set(requested.map(c => c!.ruleId)).size!==requested.length) throw new AppError('COMMERCE_PROMOTION_CONFLICT','Only one coupon per promotion may be applied.',422);
    const taxes = await tx.commerceTaxRule.findMany({ where: { workspaceId: store.workspaceId,storeId: store.id,effectiveFrom: { lte: now },OR: [{ effectiveTo: null },{ effectiveTo: { gt: now } }] } });
    const rows = await tx.commerceCartItem.findMany({ where: { workspaceId: store.workspaceId,cartId: cart.id },orderBy: { id: 'asc' } });
    if (!rows.length) throw new AppError('COMMERCE_CHECKOUT_INVALID','Cart is empty.',422);
    const lines = [];
    for (const row of rows) {
      const product = await this.carts.product(tx,store,row.productId,row.variantId);
      const gross = calculateRow(toScaled(row.quantity.toFixed(6))!,toScaled(product.unitPrice)!,{ type: 'NONE',value: 0n },{ taxable: false,rate: 0n,included: false },store.defaultCurrency).gross;
      lines.push({ row,product,gross,net: gross,discount: 0n });
    }
    const subtotal = lines.reduce((sum,l) => sum+l.gross,0n),quantity = rows.reduce((sum,r) => sum.plus(r.quantity),exact(0));
    const applied: { ruleId: string; couponId: string|null; amount: string; version: string }[] = [];
    const groups = new Map<string,boolean>();
    for (const rule of rules) {
      const coupon = requested.find(c => c!.ruleId===rule.id);
      if (allCoupons.some(c => c.ruleId===rule.id) && !coupon) continue;
      const eligibility = parse(promotionEligibility,rule.eligibility);
      const eligible = lines.filter(l => (!eligibility.productIds?.length || eligibility.productIds.includes(l.product.productId) || eligibility.productIds.includes(l.product.inventoryKey))
        && (!eligibility.categoryIds?.length || l.product.categoryIds.some(id => eligibility.categoryIds!.includes(id))));
      const valid = eligible.length && eligibility.customerKind!=='REGISTERED' && (!eligibility.regions?.length || eligibility.regions.includes(context.region))
        && (!eligibility.minimumQuantity || quantity.gte(eligibility.minimumQuantity)) && (!eligibility.minimumSubtotal || subtotal>=toScaled(eligibility.minimumSubtotal)!);
      if (!valid) { if (coupon) throw new AppError('COMMERCE_COUPON_INVALID','Coupon is not eligible.',422); continue; }
      const previous = groups.get(rule.stackGroup);
      if (previous!==undefined && (!previous || !rule.combinable)) { if (coupon) throw new AppError('COMMERCE_PROMOTION_CONFLICT','Coupon conflicts with another promotion.',422); continue; }
      const available = async (ruleId: string,couponId: string|null,limit: number|null,perCustomer: number|null) => {
        const where = { workspaceId: store.workspaceId,storeId: store.id,...(couponId ? { couponId } : { ruleId }) };
        if (limit!==null && await tx.commerceDiscountRedemption.count({ where })>=limit || perCustomer!==null && await tx.commerceDiscountRedemption.count({ where: { ...where,customerKey: context.customerKey } })>=perCustomer)
          throw new AppError('COMMERCE_COUPON_EXHAUSTED','Promotion usage limit reached.',409);
      };
      try { await available(rule.id,null,rule.usageLimit,rule.perCustomerLimit); if (coupon) await available(rule.id,coupon.id,coupon.usageLimit,coupon.perCustomerLimit); }
      catch (error) { if (coupon) throw error; if (error instanceof AppError && error.code==='COMMERCE_COUPON_EXHAUSTED') continue; throw error; }
      if (rule.appliesTo==='SHIPPING') continue; // Pickup is free; no invented shipping charge or redemption.
      let amount = 0n;
      if (rule.kind==='PERCENT') {
        for (const line of eligible) { const discount = mulDivRound(line.net,toScaled(rule.value.toFixed(6))!,scaledHundred,currencyDecimals(store.defaultCurrency)); line.net-=discount; line.discount+=discount; amount+=discount; }
      } else if (rule.kind==='FIXED') {
        // Stable row order allocates a fixed order discount exactly once, with no rounding remainder.
        let remaining = toScaled(rule.value.toFixed(6))!;
        for (const line of eligible) {
          const discount = rule.appliesTo==='LINE' ? (line.net<toScaled(rule.value.toFixed(6))! ? line.net : toScaled(rule.value.toFixed(6))!) : (line.net<remaining ? line.net : remaining);
          line.net-=discount; line.discount+=discount; amount+=discount; remaining-=discount;
        }
      }
      if (amount>0n) { groups.set(rule.stackGroup,rule.combinable); applied.push({ ruleId: rule.id,couponId: coupon?.id ?? null,amount: fromScaled(amount),version: rule.version.toString() }); }
    }
    const result = lines.map(line => {
      const candidates = taxes.filter(t => (t.region==='*' || t.region===context.region || context.region.startsWith(t.region+'-')) && (!t.categoryId || line.product.categoryIds.includes(t.categoryId)))
        .sort((a,b) => Number(Boolean(b.categoryId))-Number(Boolean(a.categoryId)) || b.region.length-a.region.length || a.id.localeCompare(b.id));
      const tax = candidates[0],fallback = line.product.tax;
      const amounts = calculateRow(toScaled(line.row.quantity.toFixed(6))!,toScaled(line.product.unitPrice)!,{ type: 'AMOUNT',value: line.discount },
        tax ? { taxable: true,rate: toScaled(tax.rate.toFixed(6))!,included: tax.priceBasis==='INCLUSIVE' } : { taxable: fallback.taxable,rate: toScaled(fallback.rate ?? '0')!,included: fallback.included },store.defaultCurrency);
      return { itemId: line.row.id,productId: line.product.productId,variantId: line.product.variantId,inventoryKey: line.product.inventoryKey,name: line.product.name,stockable: line.product.stockable,
        quantity: line.row.quantity.toFixed(6),unitPrice: line.product.unitPrice,options: line.row.options,revision: line.product.revision,
        gross: fromScaled(amounts.gross),discount: fromScaled(amounts.discountAmount),subtotal: fromScaled(amounts.subtotal),tax: fromScaled(amounts.taxAmount),total: fromScaled(amounts.total),
        taxSnapshot: tax ? { id: tax.id,version: tax.version.toString(),rate: tax.rate.toFixed(6),priceBasis: tax.priceBasis } : { id: null,rate: fallback.rate ?? '0',priceBasis: fallback.included ? 'INCLUSIVE' : 'EXCLUSIVE' } };
    });
    const sum = (key: 'subtotal'|'discount'|'tax'|'total') => fromScaled(result.reduce((s,l) => s+toScaled(l[key])!,0n));
    if (exact(sum('total')).gte('1000000000000000000')) throw new AppError('COMMERCE_PRICE_INVALID','Order total exceeds the supported amount.',422);
    const quote = { currency: store.defaultCurrency,cartVersion: cart.version.toString(),storeVersion: store.version.toString(),paymentMethodId: context.paymentMethodId,
      lines: result,promotions: applied,subtotal: sum('subtotal'),discount: sum('discount'),tax: sum('tax'),shipping: '0',total: sum('total') };
    return { quote,hash: createHash('sha256').update(canonical(quote)).digest('hex') };
  }
}
