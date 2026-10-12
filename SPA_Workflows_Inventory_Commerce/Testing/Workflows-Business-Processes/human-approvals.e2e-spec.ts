/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('Human Approvals, Information Requests and Delegation — REST E2E contract', () => {
  it('GET /api/v1/workflow-assignments/my verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/workflow-assignments/my'); });
  it('GET /api/v1/workflow-assignments/:assignmentId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/workflow-assignments/:assignmentId'); });
  it('POST /api/v1/workflow-assignments/:assignmentId/decide verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflow-assignments/:assignmentId/decide'); });
  it('POST /api/v1/workflow-assignments/:assignmentId/delegate verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflow-assignments/:assignmentId/delegate'); });
  it('POST /api/v1/workflow-assignments/:assignmentId/submit-information verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/workflow-assignments/:assignmentId/submit-information'); });
  it('GET /api/v1/workflow-assignments/:assignmentId/history verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/workflow-assignments/:assignmentId/history'); });
});
