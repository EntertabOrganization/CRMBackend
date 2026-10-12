/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('SPA Scoped Roles, Stage/Field Access and Schema Security — unit/integration contract', () => {
  it('role with OWN scope sees only eligible Items', async () => { contract('role with OWN scope sees only eligible Items'); });
  it('stage edit policy can deny update despite Type update grant', async () => { contract('stage edit policy can deny update despite Type update grant'); });
  it('field hidden from viewer absent from GET/list/export', async () => { contract('field hidden from viewer absent from GET/list/export'); });
  it('field invisible cannot be used to infer value through filters', async () => { contract('field invisible cannot be used to infer value through filters'); });
  it('observer read does not enable edit', async () => { contract('observer read does not enable edit'); });
  it('permission update audited and cache invalidated', async () => { contract('permission update audited and cache invalidated'); });
  it('forged other Workspace role ID denied', async () => { contract('forged other Workspace role ID denied'); });
});
