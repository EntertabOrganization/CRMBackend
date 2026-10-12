/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('Delivery Methods, Shipment Lifecycle and Fulfillment — REST E2E contract', () => {
  it('GET /api/v1/commerce/stores/:storeId/delivery-services verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/commerce/stores/:storeId/delivery-services'); });
  it('POST /api/v1/commerce/stores/:storeId/delivery-services verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/stores/:storeId/delivery-services'); });
  it('GET /api/v1/commerce/orders/:orderId/shipments verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/commerce/orders/:orderId/shipments'); });
  it('POST /api/v1/commerce/orders/:orderId/shipments verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/orders/:orderId/shipments'); });
  it('GET /api/v1/commerce/shipments/:shipmentId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/commerce/shipments/:shipmentId'); });
  it('PATCH /api/v1/commerce/shipments/:shipmentId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PATCH /api/v1/commerce/shipments/:shipmentId'); });
  it('POST /api/v1/commerce/shipments/:shipmentId/ship verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/shipments/:shipmentId/ship'); });
  it('POST /api/v1/commerce/shipments/:shipmentId/deliver verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/shipments/:shipmentId/deliver'); });
  it('POST /api/v1/commerce/shipments/:shipmentId/cancel verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/shipments/:shipmentId/cancel'); });
  it('POST /api/v1/commerce/delivery-providers/:providerCode/webhook verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/delivery-providers/:providerCode/webhook'); });
});
