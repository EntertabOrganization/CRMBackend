import { spaHttpContract } from '@/tests/support/spa-http-contract';
const contract = spaHttpContract();

describe('SPA Scoped Roles, Stage/Field Access and Schema Security — REST E2E contract', () => {
  it('GET /api/v1/spa/types/:typeId/permissions verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/spa/types/:typeId/permissions'); });
  it('PUT /api/v1/spa/types/:typeId/permissions verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('PUT /api/v1/spa/types/:typeId/permissions'); });
  it('GET /api/v1/spa/types/:typeId/items/:itemId/permissions/me verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/spa/types/:typeId/items/:itemId/permissions/me'); });
  it('GET /api/v1/spa/types/:typeId/permissions/history verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/spa/types/:typeId/permissions/history'); });
});

export {};


