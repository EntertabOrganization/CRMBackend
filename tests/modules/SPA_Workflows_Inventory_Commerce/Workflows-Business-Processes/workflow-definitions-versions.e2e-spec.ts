/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('Workflow Definitions, Versions and Publication — REST E2E contract', () => {
  it('POST /api/v1/workflows verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflows'); });
  it('GET /api/v1/workflows verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/workflows'); });
  it('GET /api/v1/workflows/:workflowId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/workflows/:workflowId'); });
  it('PATCH /api/v1/workflows/:workflowId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PATCH /api/v1/workflows/:workflowId'); });
  it('POST /api/v1/workflows/:workflowId/versions verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflows/:workflowId/versions'); });
  it('GET /api/v1/workflows/:workflowId/versions verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/workflows/:workflowId/versions'); });
  it('GET /api/v1/workflows/:workflowId/versions/:versionId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/workflows/:workflowId/versions/:versionId'); });
  it('POST /api/v1/workflows/:workflowId/versions/:versionId/validate verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflows/:workflowId/versions/:versionId/validate'); });
  it('POST /api/v1/workflows/:workflowId/versions/:versionId/publish verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflows/:workflowId/versions/:versionId/publish'); });
  it('POST /api/v1/workflows/:workflowId/pause verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflows/:workflowId/pause'); });
  it('POST /api/v1/workflows/:workflowId/archive verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflows/:workflowId/archive'); });
});

export {};
