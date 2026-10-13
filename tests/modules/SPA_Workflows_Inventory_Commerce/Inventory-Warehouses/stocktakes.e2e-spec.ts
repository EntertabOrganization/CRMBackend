/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('Stocktake Sessions, Snapshots and Reconciliation — REST E2E contract', () => {
  it('POST /api/v1/inventory/stocktakes verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/inventory/stocktakes'); });
  it('GET /api/v1/inventory/stocktakes verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/stocktakes'); });
  it('GET /api/v1/inventory/stocktakes/:sessionId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/stocktakes/:sessionId'); });
  it('POST /api/v1/inventory/stocktakes/:sessionId/start verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/inventory/stocktakes/:sessionId/start'); });
  it('PUT /api/v1/inventory/stocktakes/:sessionId/lines/:lineId/count verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PUT /api/v1/inventory/stocktakes/:sessionId/lines/:lineId/count'); });
  it('POST /api/v1/inventory/stocktakes/:sessionId/reconcile verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/inventory/stocktakes/:sessionId/reconcile'); });
  it('POST /api/v1/inventory/stocktakes/:sessionId/post verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/inventory/stocktakes/:sessionId/post'); });
  it('POST /api/v1/inventory/stocktakes/:sessionId/cancel verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/inventory/stocktakes/:sessionId/cancel'); });
});

export {};
