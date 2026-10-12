/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('SPA Relations, Shared Business Bindings and Views — REST E2E contract', () => {
  it('GET /api/v1/spa/types/:typeId/relation-definitions verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types/:typeId/relation-definitions'); });
  it('POST /api/v1/spa/types/:typeId/relation-definitions verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/relation-definitions'); });
  it('GET /api/v1/spa/types/:typeId/items/:itemId/relations verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types/:typeId/items/:itemId/relations'); });
  it('POST /api/v1/spa/types/:typeId/items/:itemId/relations verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/items/:itemId/relations'); });
  it('DELETE /api/v1/spa/types/:typeId/items/:itemId/relations/:relationId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('DELETE /api/v1/spa/types/:typeId/items/:itemId/relations/:relationId'); });
  it('GET /api/v1/spa/types/:typeId/layouts verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types/:typeId/layouts'); });
  it('PUT /api/v1/spa/types/:typeId/layouts/:layoutId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PUT /api/v1/spa/types/:typeId/layouts/:layoutId'); });
  it('GET /api/v1/spa/types/:typeId/views verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types/:typeId/views'); });
  it('PUT /api/v1/spa/types/:typeId/views/me verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PUT /api/v1/spa/types/:typeId/views/me'); });
});
