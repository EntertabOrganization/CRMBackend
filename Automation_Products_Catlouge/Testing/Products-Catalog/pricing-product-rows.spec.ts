const contract = (behavior: string): never => {
  throw new Error(`CONTRACT NOT WIRED: ${behavior}`);
};


describe('Pricing, units, tax and commercial product rows', () => {
  it('enforces one base Price Type per workspace', () => contract('base Price Type invariant'));
  it('stores precise current Product price with explicit currency', () => contract('no floating point money persistence'));
  it('allows authorized alternate Price Type selection', () => contract('base default plus explicit alternate price type'));
  it('rejects zero/negative unit ratios', () => contract('ratio must be positive'));
  it('snapshots unit and ratio into commercial row when required', () => contract('later Unit config change does not rewrite row'));
  it('creates a catalog-backed Product Row snapshot', () => contract('name/SKU/unit/price/discount/tax values are snapshotted'));
  it('creates manual row without Product master ID', () => contract('one-off commercial row'));
  it('does not rewrite Product Row after master price change', () => contract('historical transaction price stable'));
  it('does not rewrite Product Row after master tax change', () => contract('historical tax snapshot stable'));
  it('requires dedicated permission for price override', () => contract('PRODUCT_ROW.EDIT_PRICE effective server check'));
  it('requires dedicated permission for discount override', () => contract('PRODUCT_ROW.EDIT_DISCOUNT effective server check'));
  it('requires dedicated permission for tax override', () => contract('PRODUCT_ROW.EDIT_TAX effective server check'));
  it('calculates totals server-side with precise decimals', () => contract('client totals are non-authoritative'));
});
