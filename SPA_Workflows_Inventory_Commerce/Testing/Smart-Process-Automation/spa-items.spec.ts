/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('SPA Items, Assignments and Item History — unit/integration contract', () => {
  it('create Item persists number, values and history atomically', async () => { contract('create Item persists number, values and history atomically'); });
  it('unknown field or wrong metadata type rejects before DB mutation', async () => { contract('unknown field or wrong metadata type rejects before DB mutation'); });
  it('invalid assignment user in different workspace denied', async () => { contract('invalid assignment user in different workspace denied'); });
  it('SPA Item view redacts restricted fields even with base read access', async () => { contract('SPA Item view redacts restricted fields even with base read access'); });
  it('optimistic version conflict returns 409 without partial field writes', async () => { contract('optimistic version conflict returns 409 without partial field writes'); });
  it('observer read grant does not confer field edit', async () => { contract('observer read grant does not confer field edit'); });
  it('trash and restore preserve audit and linked shared files', async () => { contract('trash and restore preserve audit and linked shared files'); });
  it('creating Item on archived Type fails', async () => { contract('creating Item on archived Type fails'); });
  it('search filters do not reveal unauthorized field values', async () => { contract('search filters do not reveal unauthorized field values'); });
});
