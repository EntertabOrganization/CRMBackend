const contract = (behavior: string): never => {
  throw new Error(`CONTRACT NOT WIRED: ${behavior}`);
};


describe('Catalog frontend contracts', () => {
  it('manages default Catalog and nested Category tree', () => contract('Catalog/category management UI'));
  it('prevents destructive Category deletion and shows dependencies', () => contract('category dependency UX'));
  it('edits Product types and Variant family', () => contract('Product editor adapts to simple/service/parent/Variant'));
  it('previews and generates Variant matrix safely', () => contract('axis selection, combination count, existing/new states'));
  it('edits Unit ratios with unambiguous conversion text', () => contract('1 alternate unit = ratio base unit UX'));
  it('shows base/additional Price Types with permission-aware editing', () => contract('pricing UI'));
  it('lets sales user select Product/Variant and quantity', () => contract('CRM Product picker/row editor'));
  it('makes price/discount/tax override controls permission-aware', () => contract('commercial override UI does not replace backend enforcement'));
  it('displays saved Product Row snapshots after Product master changes', () => contract('historical row UI uses row data, not live Product value'));
});
