import { spaHttpContract } from '@/tests/support/spa-http-contract';
const contract = spaHttpContract();

describe('SPA Items, Assignments and Item History — REST E2E contract', () => {
  it('POST /api/v1/spa/types/:typeId/items verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/spa/types/:typeId/items'); });
  it('GET /api/v1/spa/types/:typeId/items verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/spa/types/:typeId/items'); });
  it('GET /api/v1/spa/types/:typeId/items/:itemId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/spa/types/:typeId/items/:itemId'); });
  it('PUT /api/v1/spa/types/:typeId/items/:itemId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('PUT /api/v1/spa/types/:typeId/items/:itemId'); });
  it('PATCH /api/v1/spa/types/:typeId/items/:itemId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('PATCH /api/v1/spa/types/:typeId/items/:itemId'); });
  it('PATCH /api/v1/spa/types/:typeId/items/:itemId/assign verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('PATCH /api/v1/spa/types/:typeId/items/:itemId/assign'); });
  it('POST /api/v1/spa/types/:typeId/items/:itemId/observers verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/spa/types/:typeId/items/:itemId/observers'); });
  it('DELETE /api/v1/spa/types/:typeId/items/:itemId/observers/:userId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('DELETE /api/v1/spa/types/:typeId/items/:itemId/observers/:userId'); });
  it('GET /api/v1/spa/types/:typeId/items/:itemId/history verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/spa/types/:typeId/items/:itemId/history'); });
  it('DELETE /api/v1/spa/types/:typeId/items/:itemId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('DELETE /api/v1/spa/types/:typeId/items/:itemId'); });
  it('POST /api/v1/spa/types/:typeId/items/:itemId/restore verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/spa/types/:typeId/items/:itemId/restore'); });
});

export {};


