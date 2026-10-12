/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('SPA Fields, Schema Drafts and Publication — REST E2E contract', () => {
  it('GET /api/v1/spa/types/:typeId/fields verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types/:typeId/fields'); });
  it('POST /api/v1/spa/types/:typeId/fields verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/fields'); });
  it('PATCH /api/v1/spa/types/:typeId/fields/:fieldId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PATCH /api/v1/spa/types/:typeId/fields/:fieldId'); });
  it('POST /api/v1/spa/types/:typeId/fields/:fieldId/deactivate verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/fields/:fieldId/deactivate'); });
  it('GET /api/v1/spa/types/:typeId/schema/draft verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types/:typeId/schema/draft'); });
  it('PATCH /api/v1/spa/types/:typeId/schema/draft verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PATCH /api/v1/spa/types/:typeId/schema/draft'); });
  it('POST /api/v1/spa/types/:typeId/schema/validate verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/schema/validate'); });
  it('POST /api/v1/spa/types/:typeId/schema/publish verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/schema/publish'); });
  it('GET /api/v1/spa/types/:typeId/schema/versions verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types/:typeId/schema/versions'); });
  it('POST /api/v1/spa/types/:typeId/schema/migrations verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/schema/migrations'); });
  it('POST /api/v1/spa/types/:typeId/unique-constraints verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/unique-constraints'); });
});
