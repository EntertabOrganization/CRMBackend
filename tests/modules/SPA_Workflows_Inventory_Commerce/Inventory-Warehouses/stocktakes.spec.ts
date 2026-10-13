/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('Stocktake Sessions, Snapshots and Reconciliation — unit/integration contract', () => {
  it('counting does not freeze other warehouse stock operations', async () => { contract('counting does not freeze other warehouse stock operations'); });
  it('movement after snapshot requires reconciliation before post', async () => { contract('movement after snapshot requires reconciliation before post'); });
  it('missing count line blocks post unless explicit approved skip', async () => { contract('missing count line blocks post unless explicit approved skip'); });
  it('posting makes adjustment document and append-only movement', async () => { contract('posting makes adjustment document and append-only movement'); });
  it('concurrent double post creates one adjustment only', async () => { contract('concurrent double post creates one adjustment only'); });
  it('counting rights do not grant posting rights', async () => { contract('counting rights do not grant posting rights'); });
  it('post failure rolls back all adjustment lines', async () => { contract('post failure rolls back all adjustment lines'); });
});

export {};
