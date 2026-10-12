/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('SPA Pipelines, Stages, Kanban and Transitions — REST E2E contract', () => {
  it('GET /api/v1/spa/types/:typeId/pipelines verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types/:typeId/pipelines'); });
  it('POST /api/v1/spa/types/:typeId/pipelines verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/pipelines'); });
  it('PATCH /api/v1/spa/types/:typeId/pipelines/:pipelineId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PATCH /api/v1/spa/types/:typeId/pipelines/:pipelineId'); });
  it('POST /api/v1/spa/types/:typeId/pipelines/:pipelineId/archive verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/pipelines/:pipelineId/archive'); });
  it('GET /api/v1/spa/types/:typeId/pipelines/:pipelineId/stages verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types/:typeId/pipelines/:pipelineId/stages'); });
  it('POST /api/v1/spa/types/:typeId/pipelines/:pipelineId/stages verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/pipelines/:pipelineId/stages'); });
  it('PATCH /api/v1/spa/types/:typeId/pipelines/:pipelineId/stages/:stageId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PATCH /api/v1/spa/types/:typeId/pipelines/:pipelineId/stages/:stageId'); });
  it('POST /api/v1/spa/types/:typeId/pipelines/:pipelineId/stages/:stageId/archive verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/pipelines/:pipelineId/stages/:stageId/archive'); });
  it('POST /api/v1/spa/types/:typeId/items/:itemId/transition verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/spa/types/:typeId/items/:itemId/transition'); });
  it('GET /api/v1/spa/types/:typeId/kanban verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/spa/types/:typeId/kanban'); });
});
