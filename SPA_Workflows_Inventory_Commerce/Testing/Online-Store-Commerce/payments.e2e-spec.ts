/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('Commerce Payments, Authorization, Capture and Disputes — REST E2E contract', () => {
  it('GET /api/v1/commerce/orders/:orderId/payments verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/commerce/orders/:orderId/payments'); });
  it('POST /api/v1/commerce/orders/:orderId/payments verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/orders/:orderId/payments'); });
  it('POST /api/v1/commerce/payments/:paymentId/capture verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/payments/:paymentId/capture'); });
  it('POST /api/v1/commerce/payments/:paymentId/void verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/payments/:paymentId/void'); });
  it('GET /api/v1/commerce/payments/:paymentId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/commerce/payments/:paymentId'); });
  it('POST /api/v1/commerce/payment-providers/:providerCode/webhook verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/payment-providers/:providerCode/webhook'); });
  it('GET /api/v1/commerce/payment-disputes verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/commerce/payment-disputes'); });
  it('GET /api/v1/commerce/payment-disputes/:disputeId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/commerce/payment-disputes/:disputeId'); });
});
