/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('SPA Relations, Shared Business Bindings and Views — unit/integration contract', () => {
  it('ONE relation enforces cardinality under concurrent writes', async () => { contract('ONE relation enforces cardinality under concurrent writes'); });
  it('cross-workspace target cannot be linked', async () => { contract('cross-workspace target cannot be linked'); });
  it('item list hides relation to inaccessible target', async () => { contract('item list hides relation to inaccessible target'); });
  it('relation unlink does not delete target entity', async () => { contract('relation unlink does not delete target entity'); });
  it('inverse relation is query view not duplicate row', async () => { contract('inverse relation is query view not duplicate row'); });
  it('layout rejects missing fields and preserves versions', async () => { contract('layout rejects missing fields and preserves versions'); });
  it('user view preferences cannot affect coworkers', async () => { contract('user view preferences cannot affect coworkers'); });
});

export {};
