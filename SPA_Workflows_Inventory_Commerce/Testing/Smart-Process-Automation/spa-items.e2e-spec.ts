/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('SPA Items, Assignments and Item History — REST E2E contract', () => {
  it('POST /api/v1/spa/types/:typeId/items verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/items'); });
  it('GET /api/v1/spa/types/:typeId/items verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types/:typeId/items'); });
  it('GET /api/v1/spa/types/:typeId/items/:itemId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types/:typeId/items/:itemId'); });
  it('PUT /api/v1/spa/types/:typeId/items/:itemId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PUT /api/v1/spa/types/:typeId/items/:itemId'); });
  it('PATCH /api/v1/spa/types/:typeId/items/:itemId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PATCH /api/v1/spa/types/:typeId/items/:itemId'); });
  it('PATCH /api/v1/spa/types/:typeId/items/:itemId/assign verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PATCH /api/v1/spa/types/:typeId/items/:itemId/assign'); });
  it('POST /api/v1/spa/types/:typeId/items/:itemId/observers verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/items/:itemId/observers'); });
  it('DELETE /api/v1/spa/types/:typeId/items/:itemId/observers/:userId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('DELETE /api/v1/spa/types/:typeId/items/:itemId/observers/:userId'); });
  it('GET /api/v1/spa/types/:typeId/items/:itemId/history verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types/:typeId/items/:itemId/history'); });
  it('DELETE /api/v1/spa/types/:typeId/items/:itemId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('DELETE /api/v1/spa/types/:typeId/items/:itemId'); });
  it('POST /api/v1/spa/types/:typeId/items/:itemId/restore verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/items/:itemId/restore'); });
});
