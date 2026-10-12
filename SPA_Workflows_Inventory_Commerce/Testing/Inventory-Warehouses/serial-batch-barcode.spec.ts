/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('Barcodes, Serial and Batch Tracking — unit/integration contract', () => {
  it('duplicate active barcode in workspace rejected', async () => { contract('duplicate active barcode in workspace rejected'); });
  it('serial cannot be simultaneously in two warehouses', async () => { contract('serial cannot be simultaneously in two warehouses'); });
  it('issuing sold serial twice rejected', async () => { contract('issuing sold serial twice rejected'); });
  it('expired batch cannot fulfill when expiry enforcement enabled', async () => { contract('expired batch cannot fulfill when expiry enforcement enabled'); });
  it('scanner lookup cannot mutate stock', async () => { contract('scanner lookup cannot mutate stock'); });
  it('cross-workspace serial/batch hidden', async () => { contract('cross-workspace serial/batch hidden'); });
  it('service product denied stock-tracking', async () => { contract('service product denied stock-tracking'); });
});
