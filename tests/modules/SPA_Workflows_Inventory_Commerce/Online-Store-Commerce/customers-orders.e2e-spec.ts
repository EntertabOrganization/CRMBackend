/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('Commerce Customers, Orders, Snapshots and History — REST E2E contract', () => {
  it('GET /api/v1/commerce/orders verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/commerce/orders'); });
  it('GET /api/v1/commerce/orders/:orderId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/commerce/orders/:orderId'); });
  it('PATCH /api/v1/commerce/orders/:orderId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PATCH /api/v1/commerce/orders/:orderId'); });
  it('POST /api/v1/commerce/orders/:orderId/cancel verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/orders/:orderId/cancel'); });
  it('POST /api/v1/commerce/orders/:orderId/archive verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/orders/:orderId/archive'); });
  it('GET /api/v1/commerce/orders/:orderId/history verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/commerce/orders/:orderId/history'); });
  it('GET /api/v1/commerce/customers verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/commerce/customers'); });
  it('GET /api/v1/commerce/customers/:customerId/orders verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/commerce/customers/:customerId/orders'); });
  it('POST /api/v1/commerce/customers/:customerId/crm-link verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/customers/:customerId/crm-link'); });
  it('GET /api/v1/storefront/:storeSlug/account/orders verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/storefront/:storeSlug/account/orders'); });
  it('POST /api/v1/storefront/:storeSlug/orders/:orderId/reorder verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/storefront/:storeSlug/orders/:orderId/reorder'); });
});

export {};
