/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('Stock Availability, Immutable Ledger and Rebuild — REST E2E contract', () => {
  it('GET /api/v1/inventory/stock verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/stock'); });
  it('GET /api/v1/inventory/availability verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/availability'); });
  it('GET /api/v1/inventory/movements verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/movements'); });
  it('GET /api/v1/inventory/movements/:movementId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/movements/:movementId'); });
  it('POST /api/v1/inventory/stock/reconciliation-jobs verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/inventory/stock/reconciliation-jobs'); });
  it('GET /api/v1/inventory/stock/reconciliation-jobs/:jobId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/stock/reconciliation-jobs/:jobId'); });
});
