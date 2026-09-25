import type { AccessService } from '../access-service';
import type { CrmCoreService } from '../crm-core-service';
import type { FieldEngine } from '../fields/field-engine';
import type { FieldEntityRegistry } from '../fields/entity-registry';
import type { FilePort } from '../ports';
import type { RealtimeHub } from '../realtime';
import type { InMemoryStore } from '../store';
import { CatalogService, CategoryService } from './catalog-service';
import { CrmProductRowOwnerAdapter, ProductRowService } from './commercial';
import { PriceTypeService, UnitService } from './master-data-service';
import { ProductPriceService } from './price-service';
import { ProductService } from './product-service';
import { ProductFieldEntityAdapter, PropertyService } from './property-service';
import { CatalogSupport } from './support';
import { VariantMatrixService } from './variant-matrix';

/**
 * Products & Catalog composition root. Catalog owns Product master data only: stock (Inventory), carts/orders (Commerce),
 * Deal lifecycle (CRM) and Estimate/Invoice lifecycle stay with their owners and reach Catalog through Product ids,
 * the ProductRowOwner adapter and the usage-checker registry.
 */
export class CatalogModule {
  readonly support: CatalogSupport;
  readonly catalogs: CatalogService;
  readonly categories: CategoryService;
  readonly units: UnitService;
  readonly priceTypes: PriceTypeService;
  readonly prices: ProductPriceService;
  readonly properties: PropertyService;
  readonly products: ProductService;
  readonly matrix: VariantMatrixService;
  readonly rows: ProductRowService;

  constructor(deps: {
    store: InMemoryStore;
    access: AccessService;
    realtime: RealtimeHub;
    fields: FieldEngine;
    registry: FieldEntityRegistry;
    crmCore: CrmCoreService;
    files: () => FilePort;
  }) {
    this.support = new CatalogSupport(deps.store, deps.access, deps.realtime, deps.files);
    this.catalogs = new CatalogService(this.support);
    this.categories = new CategoryService(this.support);
    this.units = new UnitService(this.support);
    this.priceTypes = new PriceTypeService(this.support);
    this.prices = new ProductPriceService(this.support);
    this.properties = new PropertyService(this.support, deps.fields);
    this.products = new ProductService(this.support, this.categories, this.units, this.prices, this.properties, deps.fields);
    this.matrix = new VariantMatrixService(this.support, this.products, this.properties);
    this.rows = new ProductRowService(this.support, this.products, this.prices)
      .registerOwner(new CrmProductRowOwnerAdapter('DEAL', 'Deal', deps.access, deps.crmCore))
      .registerOwner(new CrmProductRowOwnerAdapter('LEAD', 'Lead', deps.access, deps.crmCore));

    // Product properties are shared typed Custom Fields: register the entity, and report Catalog dependencies to the field engine.
    deps.registry.register(new ProductFieldEntityAdapter(this.support));
    deps.fields.definitions.registerDependencyProvider(this.properties.dependencyProvider);
  }
}
