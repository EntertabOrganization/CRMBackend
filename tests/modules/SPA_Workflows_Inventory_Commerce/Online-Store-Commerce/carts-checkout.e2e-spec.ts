/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('Public Cart, Checkout, Server Prices and Idempotency — REST E2E contract', () => {
  it('POST /api/v1/storefront/:storeSlug/carts verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/storefront/:storeSlug/carts'); });
  it('GET /api/v1/storefront/:storeSlug/carts/:cartToken verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/storefront/:storeSlug/carts/:cartToken'); });
  it('POST /api/v1/storefront/:storeSlug/carts/:cartToken/items verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/storefront/:storeSlug/carts/:cartToken/items'); });
  it('PATCH /api/v1/storefront/:storeSlug/carts/:cartToken/items/:itemId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PATCH /api/v1/storefront/:storeSlug/carts/:cartToken/items/:itemId'); });
  it('DELETE /api/v1/storefront/:storeSlug/carts/:cartToken/items/:itemId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('DELETE /api/v1/storefront/:storeSlug/carts/:cartToken/items/:itemId'); });
  it('POST /api/v1/storefront/:storeSlug/checkout-sessions verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/storefront/:storeSlug/checkout-sessions'); });
  it('POST /api/v1/storefront/:storeSlug/checkout-sessions/:sessionId/quote verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/storefront/:storeSlug/checkout-sessions/:sessionId/quote'); });
  it('POST /api/v1/storefront/:storeSlug/checkout-sessions/:sessionId/place-order verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/storefront/:storeSlug/checkout-sessions/:sessionId/place-order'); });
  it('GET /api/v1/storefront/:storeSlug/checkout-sessions/:sessionId/status verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/storefront/:storeSlug/checkout-sessions/:sessionId/status'); });
});

export {};
