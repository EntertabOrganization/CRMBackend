import type { PrismaClient } from '@prisma/client';
import { AppError } from '../errors';
import { parse,uuid } from '../process-platform/dto';
import { requirePermission,resolvePrincipal,type Principal,type Tx } from '../process-platform/context';
import { SharedPaymentReadService } from '../commercial/payment-read-service';
import { CommerceOrderService } from './order-service';

/** Order/payment relations belong to Commerce; financial settlement belongs to shared Payments. */
export class CommercePaymentQueryService {
  constructor(private readonly db: PrismaClient,readonly orders = new CommerceOrderService(db),readonly payments = new SharedPaymentReadService()) {}
  private async allocations(tx: Tx,actor: Principal,paymentId: string) {
    const bindings = await tx.commerceOrderPaymentBinding.findMany({ where: { workspaceId: actor.workspaceId,paymentId },orderBy: [{ createdAt: 'asc' },{ id: 'asc' }] });
    const visible = [];
    for (const binding of bindings) {
      try {
        const order = await this.orders.load(tx,actor,binding.orderId,'COMMERCE.PAYMENT_VIEW');
        visible.push({ orderId: binding.orderId,storeId: binding.storeId,currency: order.currency,allocatedAmount: binding.amount.toFixed(6) });
      } catch (error) { if (!(error instanceof AppError) || ![403,404].includes(error.status)) throw error; }
    }
    return visible;
  }
  async list(actor: Principal,orderId: string) {
    parse(uuid,orderId);
    return this.db.$transaction(async tx => {
      actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId);
      const order = await this.orders.load(tx,actor,orderId,'COMMERCE.PAYMENT_VIEW');
      requirePermission(actor,'payment.read');
      const bindings = await tx.commerceOrderPaymentBinding.findMany({ where: { workspaceId: actor.workspaceId,orderId },orderBy: [{ createdAt: 'asc' },{ id: 'asc' }] });
      const result = [];
      for (const binding of bindings) {
        const payment = await this.payments.read(tx,actor,binding.paymentId);
        if (payment.currency!==order.currency) throw new AppError('PAYMENT_CURRENCY_MISMATCH','Order payment requires reconciliation.',409);
        result.push({ ...payment,allocatedAmount: binding.amount.toFixed(6) });
      }
      return result;
    },{ timeout: 60000 });
  }
  async get(actor: Principal,paymentId: string) {
    parse(uuid,paymentId);
    return this.db.$transaction(async tx => {
      actor = await resolvePrincipal(tx,actor.workspaceId,actor.userId); requirePermission(actor,'COMMERCE.PAYMENT_VIEW');
      const allocations = await this.allocations(tx,actor,paymentId);
      if (!allocations.length) throw new AppError('PAYMENT_NOT_FOUND','Payment was not found.',404);
      const payment = await this.payments.read(tx,actor,paymentId);
      if (allocations.some(row => row.currency!==payment.currency)) throw new AppError('PAYMENT_CURRENCY_MISMATCH','Order payment requires reconciliation.',409);
      return { ...payment,allocations: allocations.map(({ currency,...row }) => row) };
    },{ timeout: 60000 });
  }
}
