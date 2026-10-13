/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('SPA Types and Capabilities — REST E2E contract', () => {
  it('POST /api/v1/spa/types verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types'); });
  it('GET /api/v1/spa/types verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types'); });
  it('GET /api/v1/spa/types/:typeId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types/:typeId'); });
  it('PATCH /api/v1/spa/types/:typeId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PATCH /api/v1/spa/types/:typeId'); });
  it('POST /api/v1/spa/types/:typeId/activate verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/activate'); });
  it('POST /api/v1/spa/types/:typeId/archive verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/archive'); });
  it('POST /api/v1/spa/types/:typeId/restore verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/restore'); });
  it('GET /api/v1/spa/types/:typeId/capabilities verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types/:typeId/capabilities'); });
  it('PUT /api/v1/spa/types/:typeId/capabilities/:key verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PUT /api/v1/spa/types/:typeId/capabilities/:key'); });
});

export {};
