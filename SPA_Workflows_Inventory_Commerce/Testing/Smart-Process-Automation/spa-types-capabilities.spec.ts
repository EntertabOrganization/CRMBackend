/** Contract scenarios MUST be wired to real NestJS services, repositories, transactions and a test DB.
 * Deliberately FAIL CLOSED until each scenario has real assertions. Do not skip/todo. */
const contract = (scenario: string): never => { throw new Error(`CONTRACT NOT WIRED: ${scenario}`); };

describe('SPA Types and Capabilities — unit/integration contract', () => {
  it('create type with unique code, draft state and capability defaults', async () => { contract('create type with unique code, draft state and capability defaults'); });
  it('activate type with valid published schema and default pipeline', async () => { contract('activate type with valid published schema and default pipeline'); });
  it('reject duplicate code and invalid code format', async () => { contract('reject duplicate code and invalid code format'); });
  it('reject KANBAN when pipelines disabled', async () => { contract('reject KANBAN when pipelines disabled'); });
  it('reject disable capabilities while live dependent data remain', async () => { contract('reject disable capabilities while live dependent data remain'); });
  it('archived type rejects item creation but permits authorized historical read', async () => { contract('archived type rejects item creation but permits authorized historical read'); });
  it('cross-workspace type ID not accessible', async () => { contract('cross-workspace type ID not accessible'); });
  it('type management denied without SPA.TYPE.MANAGE', async () => { contract('type management denied without SPA.TYPE.MANAGE'); });
  it('stale expectedVersion returns 409 and produces no outbox event', async () => { contract('stale expectedVersion returns 409 and produces no outbox event'); });
});
