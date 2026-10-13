/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('Workflow Graph, Designer and Safe Expressions — REST E2E contract', () => {
  it('GET /api/v1/workflows/:workflowId/versions/:versionId/graph verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/workflows/:workflowId/versions/:versionId/graph'); });
  it('PUT /api/v1/workflows/:workflowId/versions/:versionId/graph verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PUT /api/v1/workflows/:workflowId/versions/:versionId/graph'); });
  it('POST /api/v1/workflows/:workflowId/versions/:versionId/graph/nodes verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflows/:workflowId/versions/:versionId/graph/nodes'); });
  it('PATCH /api/v1/workflows/:workflowId/versions/:versionId/graph/nodes/:nodeId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PATCH /api/v1/workflows/:workflowId/versions/:versionId/graph/nodes/:nodeId'); });
  it('DELETE /api/v1/workflows/:workflowId/versions/:versionId/graph/nodes/:nodeId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('DELETE /api/v1/workflows/:workflowId/versions/:versionId/graph/nodes/:nodeId'); });
  it('POST /api/v1/workflows/:workflowId/versions/:versionId/graph/edges verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflows/:workflowId/versions/:versionId/graph/edges'); });
  it('POST /api/v1/workflows/:workflowId/versions/:versionId/graph/preview verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflows/:workflowId/versions/:versionId/graph/preview'); });
});

export {};
