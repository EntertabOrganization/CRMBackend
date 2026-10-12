/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('Stores, Storefronts and Catalog Publication — unit/integration contract', () => {
  it('store code unique within workspace and slug collision handled', async () => { contract('store code unique within workspace and slug collision handled'); });
  it('Store activation validates catalog/payment/delivery prerequisites', async () => { contract('Store activation validates catalog/payment/delivery prerequisites'); });
  it('unpublished product absent from public listing and direct detail', async () => { contract('unpublished product absent from public listing and direct detail'); });
  it('public catalog hides warehouse balance and internal cost', async () => { contract('public catalog hides warehouse balance and internal cost'); });
  it('suspended Store blocks checkout but admin retains Order access', async () => { contract('suspended Store blocks checkout but admin retains Order access'); });
  it('WEB and HEADLESS available; unsupported type activation denied in V1', async () => { contract('WEB and HEADLESS available; unsupported type activation denied in V1'); });
  it('wrong workspace Store/warehouse/catalog reference denied', async () => { contract('wrong workspace Store/warehouse/catalog reference denied'); });
});
