/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('Inventory FIFO and Average Cost Valuation — REST E2E contract', () => {
  it('GET /api/v1/inventory/costing/policy verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/costing/policy'); });
  it('POST /api/v1/inventory/costing/initialize verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/inventory/costing/initialize'); });
  it('GET /api/v1/inventory/valuation verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/valuation'); });
  it('POST /api/v1/inventory/costing/migration-preview verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/inventory/costing/migration-preview'); });
  it('POST /api/v1/inventory/costing/migrate verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/inventory/costing/migrate'); });
  it('GET /api/v1/inventory/costing/migrations/:jobId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/costing/migrations/:jobId'); });
});

export {};
