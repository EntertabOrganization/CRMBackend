const contract = (behavior: string): never => {
  throw new Error(`CONTRACT NOT WIRED: ${behavior}`);
};


describe('Products, Catalogs, Categories and Variants', () => {
  it('enforces one default Catalog per workspace', () => contract('setting new default atomically replaces previous default'));
  it('prevents cross-workspace and cross-catalog category parenting', () => contract('category hierarchy scope constraints'));
  it('rejects category cycles', () => contract('moving parent under descendant fails'));
  it('supports multiple categories with one primary membership', () => contract('Product memberships and primary category invariant'));
  it('enforces workspace-wide sellable SKU uniqueness', () => contract('duplicate SKU is rejected including archived policy'));
  it('supports SIMPLE_PRODUCT, PRODUCT_WITH_VARIANTS, VARIANT and SERVICE semantics', () => contract('type-specific validation'));
  it('requires Variant parent of correct type/scope', () => contract('Variant belongs to one local parent Product'));
  it('resolves parent inheritance and explicit Variant overrides', () => contract('effective Variant values use override then parent'));
  it('generates missing Variant matrix combinations idempotently', () => contract('matrix generation does not duplicate existing combinations'));
  it('does not silently delete Variants when axis configuration changes', () => contract('Variant lifecycle is explicit'));
  it('blocks category deletion with children/products', () => contract('dependency-safe category deletion'));
  it('archives used Product rather than hard deleting it', () => contract('historical dependencies preserve Product identity'));
});
