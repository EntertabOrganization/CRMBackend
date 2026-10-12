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
import type { Principal,Tx } from '../process-platform/context';

/** Only the owning Catalog services calculate effective variant values and prices.
 * Employee access is checked for configuration; a published Store authorizes the separate public projection. */
export async function commerceCatalogPort(tx: Tx,workspaceId: string,actor?: Principal) {
  const store = new InMemoryStore(await hydrateState(tx)),access = new AccessService(store),realtime = new RealtimeHub();
  const registry = createCrmFieldEntityRegistry(store,access),files = new UnconfiguredFilePort(),fields = new FieldEngine({ store,access,registry,realtime,files });
  const catalog = new CatalogModule({ store,access,realtime,registry,fields,crmCore: new CrmCoreService(store,fields),files: () => files });
  const user = actor ? store.state.users.find(row => row.id===actor.userId && !row.isDeleted && row.status==='ACTIVE') : undefined;
  if (actor && (actor.workspaceId!==workspaceId || !user)) throw new AppError('PERMISSION_DENIED','Catalog principal is unavailable.',403);
  return {
    references(catalogId: string,input: { productIds?: string[];categoryIds?: string[] }) {
      if (!user) throw new AppError('PERMISSION_DENIED','Catalog configuration requires an employee principal.',403);
      for (const id of input.productIds ?? []) {
        const product = store.state.catalogProducts.find(row => row.workspaceId===workspaceId && row.id===id && row.catalogId===catalogId);
        if (!product) throw new AppError('COMMERCE_ITEM_NOT_AVAILABLE','Eligibility SKU is unavailable.',404);
        catalog.products.get(user,workspaceId,id,product.type==='VARIANT' ? 'VARIANT' : 'PRODUCT');
      }
      for (const id of input.categoryIds ?? []) catalog.categories.get(user,workspaceId,catalogId,id);
    },
    identity(catalogId: string,productId: string,variantId: string | null) {
      if (!user) throw new AppError('PERMISSION_DENIED','Publication requires an employee principal.',403);
      catalog.products.get(user,workspaceId,productId,'PRODUCT');
      if (variantId) catalog.products.get(user,workspaceId,variantId,'VARIANT');
      const product = catalog.products.product(workspaceId,productId,'PRODUCT'),variant = variantId ? catalog.products.product(workspaceId,variantId,'VARIANT') : undefined;
      if (product.catalogId!==catalogId || (variant ? variant.parentId!==productId || product.type!=='PRODUCT_WITH_VARIANTS' : !['SIMPLE_PRODUCT','SERVICE'].includes(product.type)))
        throw new AppError('COMMERCE_ITEM_NOT_AVAILABLE','Select a sellable SKU in this Store catalog.',422);
      return { inventoryKey: variantId ?? productId };
    },
    configuration(catalogId: string,priceTypeId?: string | null) {
      if (!user) throw new AppError('PERMISSION_DENIED','Catalog configuration requires an employee principal.',403);
      catalog.catalogs.get(user,workspaceId,catalogId);
      const source = store.state.catalogs.find(row => row.workspaceId===workspaceId && row.id===catalogId);
      if (!source?.isActive) throw new AppError('COMMERCE_STORE_NOT_READY','Catalog is not active.',422);
      const effective = priceTypeId ?? store.state.catalogSettings.find(row => row.workspaceId===workspaceId)?.basePriceTypeId;
      if (effective) catalog.priceTypes.get(user,workspaceId,effective);
      return { catalogId,priceTypeId: effective ?? null };
    },
    product(catalogId: string,productId: string,variantId: string | null,priceTypeId: string | null,currency: string) {
      const id = variantId ?? productId;
      if (user) { catalog.products.get(user,workspaceId,productId,'PRODUCT'); if (variantId) catalog.products.get(user,workspaceId,variantId,'VARIANT'); }
      const sellable = catalog.products.sellable(workspaceId,id);
      if (!sellable || sellable.product.catalogId!==catalogId || (variantId ? sellable.parent?.id!==productId : sellable.product.id!==productId))
        throw new AppError('COMMERCE_ITEM_NOT_AVAILABLE','Catalog SKU is not sellable.',404);
      const type = priceTypeId && store.state.catalogPriceTypes.find(row => row.workspaceId===workspaceId && row.id===priceTypeId && row.isActive);
      if (!type) throw new AppError('COMMERCE_PRICE_MISSING','Store price type is unavailable.',422);
      const price = catalog.prices.resolve(sellable.product,sellable.parent,type.id,currency);
      if (!price || price.currency!==currency) throw new AppError('COMMERCE_PRICE_MISSING','SKU has no price in the Store currency.',422);
      const { values } = catalog.products.effective(sellable.product);
      const categoryIds = store.state.catalogProductCategories.filter(row => row.workspaceId===workspaceId && row.productId===(sellable.parent?.id ?? sellable.product.id)).map(row => row.categoryId);
      return { productId,variantId,inventoryKey: id,name: sellable.name,sku: sellable.sku,variantLabel: sellable.variantLabel,
        description: values.description,unitPrice: price.amount,currency: price.currency,unit: sellable.unit ? { id: sellable.unit.id,code: sellable.unit.code,precision: sellable.unit.precision } : null,
        stockable: sellable.product.type!=='SERVICE',tax: sellable.tax,categoryIds,
        revision: { product: sellable.product.version,parent: sellable.parent?.version ?? null,price: price.version,priceType: type.version } };
    },
  };
}
