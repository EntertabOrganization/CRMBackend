/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('SPA Import, Export, Recycle and Retention — REST E2E contract', () => {
  it('POST /api/v1/spa/types/:typeId/imports verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/imports'); });
  it('GET /api/v1/spa/types/:typeId/imports/:jobId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types/:typeId/imports/:jobId'); });
  it('POST /api/v1/spa/types/:typeId/imports/:jobId/cancel verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/imports/:jobId/cancel'); });
  it('POST /api/v1/spa/types/:typeId/exports verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/exports'); });
  it('GET /api/v1/spa/types/:typeId/exports/:jobId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types/:typeId/exports/:jobId'); });
  it('GET /api/v1/spa/types/:typeId/trash verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types/:typeId/trash'); });
  it('POST /api/v1/spa/types/:typeId/items/:itemId/purge verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/items/:itemId/purge'); });
});
