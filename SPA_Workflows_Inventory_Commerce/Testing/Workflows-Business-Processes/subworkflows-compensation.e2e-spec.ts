/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('Subworkflows, Error Routing and Saga Compensation — REST E2E contract', () => {
  it('GET /api/v1/workflow-executions/:executionId/children verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/workflow-executions/:executionId/children'); });
  it('GET /api/v1/workflow-executions/:executionId/compensations verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/workflow-executions/:executionId/compensations'); });
  it('POST /api/v1/workflow-executions/:executionId/compensate verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflow-executions/:executionId/compensate'); });
  it('POST /api/v1/workflow-executions/:executionId/compensations/:actionId/retry verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflow-executions/:executionId/compensations/:actionId/retry'); });
});
