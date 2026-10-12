/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('Workflow Executions, Tokens, Dispatch and Recovery — REST E2E contract', () => {
  it('POST /api/v1/workflows/:workflowId/start verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflows/:workflowId/start'); });
  it('GET /api/v1/workflow-executions verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/workflow-executions'); });
  it('GET /api/v1/workflow-executions/:executionId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/workflow-executions/:executionId'); });
  it('GET /api/v1/workflow-executions/:executionId/nodes verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/workflow-executions/:executionId/nodes'); });
  it('GET /api/v1/workflow-executions/:executionId/logs verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/workflow-executions/:executionId/logs'); });
  it('POST /api/v1/workflow-executions/:executionId/cancel verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflow-executions/:executionId/cancel'); });
  it('POST /api/v1/workflow-executions/:executionId/suspend verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflow-executions/:executionId/suspend'); });
  it('POST /api/v1/workflow-executions/:executionId/resume verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflow-executions/:executionId/resume'); });
  it('POST /api/v1/workflow-executions/:executionId/retry verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflow-executions/:executionId/retry'); });
  it('POST /api/v1/workflow-executions/:executionId/terminate verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflow-executions/:executionId/terminate'); });
});
