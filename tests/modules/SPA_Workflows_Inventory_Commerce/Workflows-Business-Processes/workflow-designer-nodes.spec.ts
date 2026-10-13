/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('Workflow Graph, Designer and Safe Expressions — unit/integration contract', () => {
  it('graph replacement rejects unknown node types and cross-version edges', async () => { contract('graph replacement rejects unknown node types and cross-version edges'); });
  it('arbitrary cycles without bounded loop rejected', async () => { contract('arbitrary cycles without bounded loop rejected'); });
  it('expression cannot execute arbitrary code, SQL or filesystem access', async () => { contract('expression cannot execute arbitrary code, SQL or filesystem access'); });
  it('HTTP_REQUEST rejects loopback/private/metadata address and redirect bypass', async () => { contract('HTTP_REQUEST rejects loopback/private/metadata address and redirect bypass'); });
  it('publish validator rejects no START or dead-end branch', async () => { contract('publish validator rejects no START or dead-end branch'); });
  it('preview mode never sends notifications/HTTP or writes business records', async () => { contract('preview mode never sends notifications/HTTP or writes business records'); });
  it('immutable published version graph cannot change', async () => { contract('immutable published version graph cannot change'); });
});

export {};
