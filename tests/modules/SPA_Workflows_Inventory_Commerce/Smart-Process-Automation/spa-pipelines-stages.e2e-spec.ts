import { spaHttpContract } from '@/tests/support/spa-http-contract';
const contract = spaHttpContract();

describe('SPA Pipelines, Stages, Kanban and Transitions — REST E2E contract', () => {
  it('GET /api/v1/spa/types/:typeId/pipelines verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/spa/types/:typeId/pipelines'); });
  it('POST /api/v1/spa/types/:typeId/pipelines verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/spa/types/:typeId/pipelines'); });
  it('PATCH /api/v1/spa/types/:typeId/pipelines/:pipelineId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('PATCH /api/v1/spa/types/:typeId/pipelines/:pipelineId'); });
  it('POST /api/v1/spa/types/:typeId/pipelines/:pipelineId/archive verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/spa/types/:typeId/pipelines/:pipelineId/archive'); });
  it('GET /api/v1/spa/types/:typeId/pipelines/:pipelineId/stages verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/spa/types/:typeId/pipelines/:pipelineId/stages'); });
  it('POST /api/v1/spa/types/:typeId/pipelines/:pipelineId/stages verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/spa/types/:typeId/pipelines/:pipelineId/stages'); });
  it('PATCH /api/v1/spa/types/:typeId/pipelines/:pipelineId/stages/:stageId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('PATCH /api/v1/spa/types/:typeId/pipelines/:pipelineId/stages/:stageId'); });
  it('POST /api/v1/spa/types/:typeId/pipelines/:pipelineId/stages/:stageId/archive verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/spa/types/:typeId/pipelines/:pipelineId/stages/:stageId/archive'); });
  it('POST /api/v1/spa/types/:typeId/items/:itemId/transition verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/spa/types/:typeId/items/:itemId/transition'); });
  it('GET /api/v1/spa/types/:typeId/kanban verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/spa/types/:typeId/kanban'); });
});

export {};


