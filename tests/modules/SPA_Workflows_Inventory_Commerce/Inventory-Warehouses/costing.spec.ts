/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('Inventory FIFO and Average Cost Valuation — unit/integration contract', () => {
  it('FIFO 10 at 100 and 5 at 60, issue 12 allocates 10 at100 plus 2 at60', async () => { contract('FIFO 10 at 100 and 5 at 60, issue 12 allocates 10 at100 plus 2 at60'); });
  it('AVERAGE receipt 10 at100 then10 at120 gives average110', async () => { contract('AVERAGE receipt 10 at100 then10 at120 gives average110'); });
  it('warehouse transfer preserves total valuation without recognizing profit', async () => { contract('warehouse transfer preserves total valuation without recognizing profit'); });
  it('costing method cannot toggle after first posting with plain PATCH', async () => { contract('costing method cannot toggle after first posting with plain PATCH'); });
  it('migration preview does not mutate stock/valuation', async () => { contract('migration preview does not mutate stock/valuation'); });
  it('multi-currency valuation requires explicit policy/rate reference', async () => { contract('multi-currency valuation requires explicit policy/rate reference'); });
  it('valuation read excludes inaccessible warehouse', async () => { contract('valuation read excludes inaccessible warehouse'); });
});

export {};
