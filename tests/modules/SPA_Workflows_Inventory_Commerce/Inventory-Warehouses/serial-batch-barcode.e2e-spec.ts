/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('Barcodes, Serial and Batch Tracking — REST E2E contract', () => {
  it('GET /api/v1/inventory/barcodes/resolve verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/barcodes/resolve'); });
  it('POST /api/v1/inventory/barcodes verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/inventory/barcodes'); });
  it('DELETE /api/v1/inventory/barcodes/:barcodeId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('DELETE /api/v1/inventory/barcodes/:barcodeId'); });
  it('GET /api/v1/inventory/serials verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/serials'); });
  it('POST /api/v1/inventory/serials verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/inventory/serials'); });
  it('GET /api/v1/inventory/batches verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/batches'); });
  it('POST /api/v1/inventory/batches verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/inventory/batches'); });
});

export {};
