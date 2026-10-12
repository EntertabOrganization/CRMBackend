/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('Workflow Security, Templates and Execution Governance — REST E2E contract', () => {
  it('GET /api/v1/workflow-templates verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/workflow-templates'); });
  it('POST /api/v1/workflow-templates verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflow-templates'); });
  it('POST /api/v1/workflow-templates/:templateId/instantiate verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflow-templates/:templateId/instantiate'); });
  it('GET /api/v1/workflow-executions/:executionId/discussion verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/workflow-executions/:executionId/discussion'); });
  it('GET /api/v1/workflows/admin/health verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/workflows/admin/health'); });
  it('POST /api/v1/workflows/admin/reconcile verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflows/admin/reconcile'); });
});
