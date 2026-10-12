/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('Inventory Policies, Reorder Alerts and Controlled Reset — REST E2E contract', () => {
  it('GET /api/v1/inventory/settings verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/settings'); });
  it('PATCH /api/v1/inventory/settings verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PATCH /api/v1/inventory/settings'); });
  it('GET /api/v1/inventory/reorder-rules verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/reorder-rules'); });
  it('PUT /api/v1/inventory/reorder-rules/:ruleId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PUT /api/v1/inventory/reorder-rules/:ruleId'); });
  it('GET /api/v1/inventory/low-stock-alerts verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/low-stock-alerts'); });
  it('PUT /api/v1/inventory/numbering/:documentType verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PUT /api/v1/inventory/numbering/:documentType'); });
  it('POST /api/v1/inventory/reset/preview verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/inventory/reset/preview'); });
  it('POST /api/v1/inventory/reset/apply verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/inventory/reset/apply'); });
});
