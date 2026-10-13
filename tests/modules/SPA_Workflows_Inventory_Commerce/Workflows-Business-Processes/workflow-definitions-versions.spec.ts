/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('Workflow Definitions, Versions and Publication — unit/integration contract', () => {
  it('publishing V2 leaves running V1 execution graph unchanged', async () => { contract('publishing V2 leaves running V1 execution graph unchanged'); });
  it('cannot modify published graph or parameter schema', async () => { contract('cannot modify published graph or parameter schema'); });
  it('validator rejects no start/end, dangling edges or unsafe action', async () => { contract('validator rejects no start/end, dangling edges or unsafe action'); });
  it('publishing increments definition version and emits once', async () => { contract('publishing increments definition version and emits once'); });
  it('archived definition rejects new manual/event starts but historical logs remain', async () => { contract('archived definition rejects new manual/event starts but historical logs remain'); });
  it('service-account change requires permission and central audit', async () => { contract('service-account change requires permission and central audit'); });
  it('cross-workspace bound entity denied', async () => { contract('cross-workspace bound entity denied'); });
});

export {};
