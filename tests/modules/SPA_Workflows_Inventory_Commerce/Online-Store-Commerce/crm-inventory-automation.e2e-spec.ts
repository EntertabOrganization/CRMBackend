/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('Commerce CRM/Inventory Integration, Cart Abandonment and Events — REST E2E contract', () => {
  it('GET /api/v1/commerce/orders/:orderId/integrations verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/commerce/orders/:orderId/integrations'); });
  it('POST /api/v1/commerce/orders/:orderId/crm-sync verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/orders/:orderId/crm-sync'); });
  it('GET /api/v1/commerce/stores/:storeId/automation-settings verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/commerce/stores/:storeId/automation-settings'); });
  it('PATCH /api/v1/commerce/stores/:storeId/automation-settings verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PATCH /api/v1/commerce/stores/:storeId/automation-settings'); });
  it('POST /api/v1/commerce/orders/:orderId/reconcile verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/orders/:orderId/reconcile'); });
  it('GET /api/v1/commerce/reconciliation-jobs/:jobId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/commerce/reconciliation-jobs/:jobId'); });
});

export {};
