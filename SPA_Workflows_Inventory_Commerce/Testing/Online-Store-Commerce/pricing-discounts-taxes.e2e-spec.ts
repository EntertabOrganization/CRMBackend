/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('Pricing, Promotions, Coupons and Tax Snapshot — REST E2E contract', () => {
  it('GET /api/v1/commerce/stores/:storeId/promotions verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/commerce/stores/:storeId/promotions'); });
  it('POST /api/v1/commerce/stores/:storeId/promotions verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/stores/:storeId/promotions'); });
  it('PATCH /api/v1/commerce/promotions/:promotionId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PATCH /api/v1/commerce/promotions/:promotionId'); });
  it('POST /api/v1/commerce/promotions/:promotionId/coupons verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/promotions/:promotionId/coupons'); });
  it('POST /api/v1/storefront/:storeSlug/coupons/validate verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/storefront/:storeSlug/coupons/validate'); });
  it('GET /api/v1/commerce/stores/:storeId/tax-rules verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/commerce/stores/:storeId/tax-rules'); });
  it('POST /api/v1/commerce/stores/:storeId/tax-rules verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/commerce/stores/:storeId/tax-rules'); });
  it('PATCH /api/v1/commerce/tax-rules/:taxRuleId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PATCH /api/v1/commerce/tax-rules/:taxRuleId'); });
});
