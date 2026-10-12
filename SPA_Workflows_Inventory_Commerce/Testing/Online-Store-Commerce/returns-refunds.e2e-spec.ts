/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('Returns, Disposition, Refunds and Financial Approval — REST E2E contract', () => {
  it('POST /api/v1/commerce/orders/:orderId/returns verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/orders/:orderId/returns'); });
  it('GET /api/v1/commerce/returns verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/commerce/returns'); });
  it('GET /api/v1/commerce/returns/:returnId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/commerce/returns/:returnId'); });
  it('POST /api/v1/commerce/returns/:returnId/approve verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/returns/:returnId/approve'); });
  it('POST /api/v1/commerce/returns/:returnId/receive verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/returns/:returnId/receive'); });
  it('POST /api/v1/commerce/returns/:returnId/inspect verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/returns/:returnId/inspect'); });
  it('POST /api/v1/commerce/orders/:orderId/refunds verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/orders/:orderId/refunds'); });
  it('POST /api/v1/commerce/refunds/:refundId/approve verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/refunds/:refundId/approve'); });
  it('POST /api/v1/commerce/refunds/:refundId/process verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/refunds/:refundId/process'); });
  it('GET /api/v1/commerce/refunds/:refundId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/commerce/refunds/:refundId'); });
});
