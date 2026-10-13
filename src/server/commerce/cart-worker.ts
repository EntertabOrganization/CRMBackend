import type { PrismaClient } from '@prisma/client';
import { lock } from '../process-platform/context';
import { publicCommerceEvent } from './cart-service';

/** Abandonment/expiry uses durable cart state; competing workers fence the same token identity. */
export class CommerceCartWorker {
  constructor(private readonly db: PrismaClient) {}
  async tick(limit = 50) {
    const candidates = await this.db.$queryRaw<{ id: string;workspaceId: string;tokenHash: string }[]>`
      SELECT c.id,c.workspace_id AS "workspaceId",c.token_hash AS "tokenHash" FROM commerce_carts c
      JOIN commerce_stores s ON s.workspace_id=c.workspace_id AND s.id=c.store_id
      WHERE (c.status IN ('ACTIVE','CHECKOUT') AND (c.expires_at<=CURRENT_TIMESTAMP
        OR c.last_activity_at<=CURRENT_TIMESTAMP-make_interval(mins=>s.abandoned_after_minutes)))
        OR (c.status='ABANDONED' AND c.expires_at<=CURRENT_TIMESTAMP)
      ORDER BY c.last_activity_at,c.id LIMIT ${limit}`;
    let changed = 0;
    for (const candidate of candidates) changed += await this.db.$transaction(async tx => {
      await lock(tx,candidate.workspaceId,'commerce:configuration');
      await lock(tx,candidate.workspaceId,'commerce:cart:'+candidate.tokenHash);
      const cart = await tx.commerceCart.findFirst({ where: { workspaceId: candidate.workspaceId,id: candidate.id,status: { in: ['ACTIVE','CHECKOUT','ABANDONED'] } } });
      if (!cart) return 0;
      const store = await tx.commerceStore.findUniqueOrThrow({ where: { id: cart.storeId } }),now = new Date();
      const expired = cart.expiresAt<=now;
      if (!expired && cart.status==='ABANDONED') return 0;
      if (!expired && cart.lastActivityAt.getTime()>now.getTime()-store.abandonedAfterMinutes*60000) return 0;
      const updated = await tx.commerceCart.update({ where: { id: cart.id },data: { status: expired ? 'EXPIRED' : 'ABANDONED',version: { increment: 1 } } });
      await publicCommerceEvent(tx,cart.workspaceId,'COMMERCE_CART',cart.id,expired ? 'CART_EXPIRED' : 'CART_ABANDONED',{ storeId: cart.storeId,version: updated.version.toString() });
      return 1;
    });
    return { changed };
  }
}
