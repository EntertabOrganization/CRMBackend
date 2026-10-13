/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('Workflow Security, Templates and Execution Governance — unit/integration contract', () => {
  it('nonadmin cannot inspect other workflow sensitive logs', async () => { contract('nonadmin cannot inspect other workflow sensitive logs'); });
  it('SECRET tokens never persist to logs', async () => { contract('SECRET tokens never persist to logs'); });
  it('completed log retention respects legal hold', async () => { contract('completed log retention respects legal hold'); });
  it('archiving template does not affect instantiated definitions', async () => { contract('archiving template does not affect instantiated definitions'); });
  it('template copied to another Workspace removes hardcoded target IDs/secrets', async () => { contract('template copied to another Workspace removes hardcoded target IDs/secrets'); });
  it('reconcile command does not double-run completed node', async () => { contract('reconcile command does not double-run completed node'); });
});

export {};
