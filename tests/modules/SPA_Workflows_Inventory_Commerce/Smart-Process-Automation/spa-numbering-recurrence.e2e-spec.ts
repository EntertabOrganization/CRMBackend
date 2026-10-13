/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('SPA Numbering, Recurrence and Idempotent Generation — REST E2E contract', () => {
  it('GET /api/v1/spa/types/:typeId/numbering verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types/:typeId/numbering'); });
  it('PUT /api/v1/spa/types/:typeId/numbering verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PUT /api/v1/spa/types/:typeId/numbering'); });
  it('GET /api/v1/spa/types/:typeId/recurrence verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types/:typeId/recurrence'); });
  it('POST /api/v1/spa/types/:typeId/recurrence verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/recurrence'); });
  it('PATCH /api/v1/spa/types/:typeId/recurrence/:ruleId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PATCH /api/v1/spa/types/:typeId/recurrence/:ruleId'); });
  it('POST /api/v1/spa/types/:typeId/recurrence/:ruleId/pause verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/recurrence/:ruleId/pause'); });
  it('POST /api/v1/spa/types/:typeId/recurrence/:ruleId/resume verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/recurrence/:ruleId/resume'); });
  it('GET /api/v1/spa/types/:typeId/recurrence/:ruleId/instances verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types/:typeId/recurrence/:ruleId/instances'); });
});

export {};
