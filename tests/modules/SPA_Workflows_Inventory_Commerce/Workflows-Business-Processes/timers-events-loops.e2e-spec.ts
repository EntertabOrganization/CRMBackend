/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('Durable Timers, Events, Parallelism and Bounded Loops — REST E2E contract', () => {
  it('GET /api/v1/workflows/:workflowId/triggers verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/workflows/:workflowId/triggers'); });
  it('PUT /api/v1/workflows/:workflowId/triggers verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PUT /api/v1/workflows/:workflowId/triggers'); });
  it('GET /api/v1/workflow-executions/:executionId/waits verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/workflow-executions/:executionId/waits'); });
  it('GET /api/v1/workflows/runtime-limits verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/workflows/runtime-limits'); });
  it('PUT /api/v1/workflows/runtime-limits verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PUT /api/v1/workflows/runtime-limits'); });
});

export {};
