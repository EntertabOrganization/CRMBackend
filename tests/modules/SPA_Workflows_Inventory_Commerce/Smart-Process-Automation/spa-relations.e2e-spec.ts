import { spaHttpContract } from '@/tests/support/spa-http-contract';
const contract = spaHttpContract();

describe('SPA Relations, Shared Business Bindings and Views — REST E2E contract', () => {
  it('GET /api/v1/spa/types/:typeId/relation-definitions verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/spa/types/:typeId/relation-definitions'); });
  it('POST /api/v1/spa/types/:typeId/relation-definitions verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/spa/types/:typeId/relation-definitions'); });
  it('GET /api/v1/spa/types/:typeId/items/:itemId/relations verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/spa/types/:typeId/items/:itemId/relations'); });
  it('POST /api/v1/spa/types/:typeId/items/:itemId/relations verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/spa/types/:typeId/items/:itemId/relations'); });
  it('DELETE /api/v1/spa/types/:typeId/items/:itemId/relations/:relationId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('DELETE /api/v1/spa/types/:typeId/items/:itemId/relations/:relationId'); });
  it('GET /api/v1/spa/types/:typeId/layouts verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/spa/types/:typeId/layouts'); });
  it('PUT /api/v1/spa/types/:typeId/layouts/:layoutId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('PUT /api/v1/spa/types/:typeId/layouts/:layoutId'); });
  it('GET /api/v1/spa/types/:typeId/views verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/spa/types/:typeId/views'); });
  it('PUT /api/v1/spa/types/:typeId/views/me verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('PUT /api/v1/spa/types/:typeId/views/me'); });
});

export {};


