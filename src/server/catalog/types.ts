/**
 * Row shapes for Products & Catalog. They mirror the Prisma models 1:1 (persistence upserts these objects as-is).
 * Every business decimal (money, quantity, ratio, rate, dimensions) is carried as a canonical decimal STRING so binary
 * floating point never touches persisted values.
 */

export const PRODUCT_TYPES = ['SIMPLE_PRODUCT', 'PRODUCT_WITH_VARIANTS', 'VARIANT', 'SERVICE'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const PRODUCT_STATES = ['ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
export type ProductState = (typeof PRODUCT_STATES)[number];

export type CatalogSettings = {
  id: string;
  workspaceId: string;
  defaultCatalogId: string | null;
  basePriceTypeId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type Catalog = {
  id: string;
  workspaceId: string;
  name: string;
  normalizedName: string;
  code: string | null;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  version: number;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CatalogCategory = {
  id: string;
  workspaceId: string;
  catalogId: string;
  parentId: string | null;
  name: string;
  code: string | null;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ProductCategoryMembership = {
  id: string;
  workspaceId: string;
  productId: string;
  categoryId: string;
  sortOrder: number;
  createdAt: Date;
};

/** Attributes a Variant may override; anything not listed in `overrides` resolves from the parent. */
export const INHERITABLE_ATTRIBUTES = ['name', 'description', 'shortDescription', 'primaryUnitId', 'tax', 'dimensions', 'media', 'prices'] as const;
export type InheritableAttribute = (typeof INHERITABLE_ATTRIBUTES)[number];

export type AxisValue = { fieldId: string; optionId: string };

export type Product = {
  id: string;
  workspaceId: string;
  catalogId: string;
  type: ProductType;
  parentId: string | null;
  name: string;
  sku: string | null;
  skuKey: string | null;
  description: string | null;
  shortDescription: string | null;
  state: ProductState;
  archiveCause: 'DIRECT' | 'PARENT' | null;
  archivedAt: Date | null;
  archivedByUserId: string | null;
  primaryCategoryId: string | null;
  primaryUnitId: string | null;
  taxable: boolean;
  taxRate: string | null;
  taxIncluded: boolean;
  taxCode: string | null;
  weight: string | null;
  length: string | null;
  width: string | null;
  height: string | null;
  barcode: string | null;
  variantAxes: string[];
  axisKey: string | null;
  axisValues: AxisValue[] | null;
  overrides: InheritableAttribute[];
  version: number;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CatalogUnit = {
  id: string;
  workspaceId: string;
  code: string;
  name: string;
  symbol: string | null;
  precision: number;
  isActive: boolean;
  isSystem: boolean;
  sortOrder: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ProductUnitRatio = {
  id: string;
  workspaceId: string;
  productId: string;
  unitId: string;
  baseUnitId: string;
  ratio: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PriceType = {
  id: string;
  workspaceId: string;
  code: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ProductPrice = {
  id: string;
  workspaceId: string;
  productId: string;
  priceTypeId: string;
  amount: string;
  currency: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export const PROPERTY_APPLIES_TO = ['PARENT', 'SELLABLE', 'BOTH'] as const;
export type PropertyAppliesTo = (typeof PROPERTY_APPLIES_TO)[number];

export type PropertyProfile = {
  id: string;
  workspaceId: string;
  fieldId: string;
  appliesTo: PropertyAppliesTo;
  variantAxis: boolean;
  filterable: boolean;
  searchable: boolean;
  displayOnCard: boolean;
  displayInList: boolean;
  storefrontVisible: boolean;
  categoryIds: string[];
  allowedTypes: ProductType[];
  sortOrder: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ProductMedia = {
  id: string;
  workspaceId: string;
  productId: string;
  fileId: string;
  altText: string | null;
  sortOrder: number;
  createdAt: Date;
};

export type DiscountType = 'NONE' | 'PERCENT' | 'AMOUNT';

export type CommercialProductRow = {
  id: string;
  workspaceId: string;
  ownerType: string;
  ownerId: string;
  productId: string | null;
  parentProductId: string | null;
  isManual: boolean;
  nameSnapshot: string;
  skuSnapshot: string | null;
  variantSnapshot: string | null;
  unitId: string | null;
  unitCodeSnapshot: string | null;
  unitNameSnapshot: string | null;
  unitRatioSnapshot: string | null;
  baseUnitCodeSnapshot: string | null;
  quantity: string;
  priceTypeId: string | null;
  priceTypeCodeSnapshot: string | null;
  unitPrice: string;
  currency: string;
  discountType: DiscountType;
  discountValue: string;
  discountAmount: string;
  taxable: boolean;
  taxRate: string;
  taxIncluded: boolean;
  taxCodeSnapshot: string | null;
  subtotal: string;
  taxAmount: string;
  total: string;
  priceOverridden: boolean;
  discountOverridden: boolean;
  taxOverridden: boolean;
  sortOrder: number;
  version: number;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CommercialRowSet = {
  id: string;
  workspaceId: string;
  ownerType: string;
  ownerId: string;
  version: number;
  currency: string | null;
  subtotal: string;
  taxTotal: string;
  total: string;
  updatedByUserId: string | null;
  updatedAt: Date;
};

/** Catalog permission keys (the repository's equivalent of the spec's CATALOG.* / PRODUCT.* / PRODUCT_ROW.* capabilities). */
export const CATALOG_PERMISSIONS = {
  catalogRead: 'catalog.read',
  catalogManage: 'catalog.manage',
  categoryManage: 'category.manage',
  productRead: 'product.read',
  productCreate: 'product.create',
  productUpdate: 'product.update',
  productArchive: 'product.archive',
  productDelete: 'product.delete',
  propertyManage: 'product_property.manage',
  unitManage: 'unit.manage',
  priceTypeManage: 'price_type.manage',
  priceManage: 'product_price.manage',
  rowManage: 'product_row.manage',
  rowEditPrice: 'product_row.edit_price',
  rowEditDiscount: 'product_row.edit_discount',
  rowEditTax: 'product_row.edit_tax',
} as const;
