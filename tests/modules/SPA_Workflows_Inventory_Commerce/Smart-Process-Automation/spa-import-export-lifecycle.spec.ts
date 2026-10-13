/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('SPA Import, Export, Recycle and Retention — unit/integration contract', () => {
  it('CREATE_ONLY import reports duplicate external key without title merge', async () => { contract('CREATE_ONLY import reports duplicate external key without title merge'); });
  it('UPSERT keyed retry does not duplicate records', async () => { contract('UPSERT keyed retry does not duplicate records'); });
  it('unknown mapping target is a per-row validation failure', async () => { contract('unknown mapping target is a per-row validation failure'); });
  it('partial import results include each row and avoid false all-or-nothing report', async () => { contract('partial import results include each row and avoid false all-or-nothing report'); });
  it('export excludes hidden salary and unauthorized items', async () => { contract('export excludes hidden salary and unauthorized items'); });
  it('import/export jobs require own or admin authorization', async () => { contract('import/export jobs require own or admin authorization'); });
  it('purge blocked under legal hold', async () => { contract('purge blocked under legal hold'); });
  it('trash expires per workspace policy but keeps audit', async () => { contract('trash expires per workspace policy but keeps audit'); });
});

export {};
