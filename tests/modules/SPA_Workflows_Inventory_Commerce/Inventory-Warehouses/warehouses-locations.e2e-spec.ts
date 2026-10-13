/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('Warehouses, Locations and Scoped Access — REST E2E contract', () => {
  it('POST /api/v1/inventory/warehouses verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/inventory/warehouses'); });
  it('GET /api/v1/inventory/warehouses verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/warehouses'); });
  it('GET /api/v1/inventory/warehouses/:warehouseId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/warehouses/:warehouseId'); });
  it('PATCH /api/v1/inventory/warehouses/:warehouseId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PATCH /api/v1/inventory/warehouses/:warehouseId'); });
  it('POST /api/v1/inventory/warehouses/:warehouseId/archive verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/inventory/warehouses/:warehouseId/archive'); });
  it('GET /api/v1/inventory/warehouses/:warehouseId/locations verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/warehouses/:warehouseId/locations'); });
  it('POST /api/v1/inventory/warehouses/:warehouseId/locations verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/inventory/warehouses/:warehouseId/locations'); });
  it('PATCH /api/v1/inventory/warehouses/:warehouseId/locations/:locationId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PATCH /api/v1/inventory/warehouses/:warehouseId/locations/:locationId'); });
  it('GET /api/v1/inventory/warehouses/:warehouseId/permissions verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/warehouses/:warehouseId/permissions'); });
  it('PUT /api/v1/inventory/warehouses/:warehouseId/permissions verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PUT /api/v1/inventory/warehouses/:warehouseId/permissions'); });
});

export {};
