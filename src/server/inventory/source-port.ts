import type { PrismaClient } from '@prisma/client';
import { AppError } from '../errors';
import type { Principal,Tx } from '../process-platform/context';
import type { WorkflowEntityAuthority } from '../workflows/entity-authority';
import { inventoryCatalogPort } from './catalog-port';
import { commerceOrderSource,commerceOrderReversal } from '../commerce/order-authority';

export type InventorySourceRef = { entityType: string;entityId: string };
export type SourceReader = (tx: Tx,actor: Principal,id: string,inventoryKey?: string) => Promise<{ plannedQuantity?: string }>;
/** Source permissions stay with the source owner. Commerce/Invoice adapters are installed by composition. */
export class InventorySourceAuthority {
  private readonly readers = new Map<string,SourceReader>();
  private shared?: WorkflowEntityAuthority;
  constructor(private readonly db: PrismaClient) {}
  register(type: string,reader: SourceReader) { this.readers.set(type,reader); return this; }
  async reversible(tx: Tx,actor: Principal,source: InventorySourceRef,documentId: string) {
    if (source.entityType==='ORDER') return commerceOrderReversal(tx,actor,source.entityId,documentId);
    await this.read(tx,actor,source);
  }
  async read(tx: Tx,actor: Principal,source: InventorySourceRef,inventoryKey?: string) {
    const reader = this.readers.get(source.entityType);
    if (reader) return reader(tx,actor,source.entityId,inventoryKey);
    if (source.entityType==='ORDER') return commerceOrderSource(tx,actor,source.entityId,inventoryKey);
    if (source.entityType==='DEAL') return (await inventoryCatalogPort(tx,actor)).deal(source.entityId,inventoryKey);
    if (source.entityType==='INVOICE') return (await inventoryCatalogPort(tx,actor)).invoice(source.entityId,inventoryKey);
    if (source.entityType==='SPA_ITEM') {
      if (!this.shared) { const { WorkflowEntityAuthority } = await import('../workflows/entity-authority'); this.shared = new WorkflowEntityAuthority(this.db); }
      await this.shared.read(tx,actor,source.entityType,source.entityId); return {};
    }
    throw new AppError('RESERVATION_SOURCE_INVALID','Source owning adapter is unavailable.',503);
  }
}
