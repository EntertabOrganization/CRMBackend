import { AccessService } from '../access-service';
import { hydrateState } from '../persistence';
import { InMemoryStore } from '../store';
import { RealtimeHub } from '../realtime';
import { FieldEngine } from '../fields/field-engine';
import { createCrmFieldEntityRegistry } from '../fields/entity-registry';
import { CrmCoreService } from '../crm-core-service';
import { UnconfiguredFilePort } from '../ports';
import { CatalogModule } from '../catalog';
import { AppError } from '../errors';
import { parse,uuid } from '../process-platform/dto';
import type { Principal,Tx } from '../process-platform/context';
import { exact,numeric24 } from './decimal';
import { CommerceService } from '../commercial/commerce-service';
import { RequisiteService } from '../commercial/requisite-service';
import { PaymentProviderRegistry } from '../commercial/payment-providers';

/** Read-only owning Catalog application services; never persists the hydrated platform state. */
export async function inventoryCatalogPort(tx: Tx,actor: Principal) {
  const store = new InMemoryStore(await hydrateState(tx)),access = new AccessService(store),realtime = new RealtimeHub();
  const registry = createCrmFieldEntityRegistry(store,access),files = new UnconfiguredFilePort();
  const fields = new FieldEngine({ store,access,registry,realtime,files });
  const catalog = new CatalogModule({ store,access,realtime,registry,fields,crmCore: new CrmCoreService(store,fields),files: () => files });
  const user = store.state.users.find(u => u.id===actor.userId && !u.isDeleted && u.status==='ACTIVE');
  if (!user) throw new AppError('PERMISSION_DENIED','Catalog principal is unavailable.',403);
  return {
    identityForKey(id: string) {
      parse(uuid,id);
      const row = store.state.catalogProducts.find(product => product.workspaceId===actor.workspaceId && product.id===id);
      if (!row) throw new AppError('INVENTORY_LINE_INVALID','Catalog SKU is unavailable.',404);
      catalog.products.get(user,actor.workspaceId,id,row.type==='VARIANT' ? 'VARIANT' : 'PRODUCT');
      return { productId: row.type==='VARIANT' ? row.parentId! : row.id,variantId: row.type==='VARIANT' ? row.id : undefined };
    },
    variantParent(id: string) {
      catalog.products.get(user,actor.workspaceId,id,'VARIANT');
      const variant = catalog.products.product(actor.workspaceId,id,'VARIANT');
      if (!variant.parentId) throw new AppError('INVENTORY_LINE_INVALID','Variant parent is unavailable.',422);
      return variant.parentId;
    },
    deal(id: string,inventoryKey?: string) {
      const view = catalog.rows.list(user,actor.workspaceId,'DEAL',id);
      return inventoryKey ? { plannedQuantity: numeric24(view.rows.filter(row => row.productId===inventoryKey).reduce((sum,row) => sum.plus(exact(row.quantity).mul(row.unitRatio ?? '1')),exact('0'))) } : {};
    },
    invoice(id: string,inventoryKey?: string) {
      const owner = new CommerceService(store,access,new RequisiteService(store,access),new PaymentProviderRegistry());
      const invoice = owner.getInvoice(access.actor(user,actor.workspaceId),id);
      if (['CANCELLED','VOID'].includes(invoice.semanticStatus)) throw new AppError('RESERVATION_SOURCE_INVALID','Invoice is closed.',409);
      return inventoryKey ? { plannedQuantity: numeric24(invoice.lines.filter(line => line.productId===inventoryKey).reduce((sum,line) => sum.plus(line.quantity),exact('0'))) } : {};
    },
    sku(productId: string,variantId?: string,active = true) {
      parse(uuid,productId); if (variantId) parse(uuid,variantId);
      catalog.products.get(user,actor.workspaceId,productId,'PRODUCT');
      if (variantId) catalog.products.get(user,actor.workspaceId,variantId,'VARIANT');
      const parent = catalog.products.product(actor.workspaceId,productId,'PRODUCT'),product = variantId ? catalog.products.product(actor.workspaceId,variantId,'VARIANT') : parent;
      if (parent.type==='SERVICE' || product.type==='SERVICE') throw new AppError('STOCK_SERVICE_NOT_TRACKABLE','Service products cannot carry stock.',422);
      if (variantId ? parent.type!=='PRODUCT_WITH_VARIANTS' || product.parentId!==parent.id : parent.type!=='SIMPLE_PRODUCT')
        throw new AppError('INVENTORY_LINE_INVALID','Select a stockable Catalog SKU.',422);
      const sellable = catalog.products.sellable(actor.workspaceId,product.id,{ allowArchived: !active });
      if (active && (!sellable || parent.state!=='ACTIVE' || product.state!=='ACTIVE')) throw new AppError('INVENTORY_LINE_INVALID','SKU is not active.',422);
      return { productId: parent.id,variantId: variantId ?? null,inventoryKey: product.id,name: sellable?.name ?? product.name,sku: product.sku,
        unitPrecision: sellable?.unit?.precision ?? 6 };
    },
  };
}
