import { spaHttpContract } from '@/tests/support/spa-http-contract';
const contract = spaHttpContract();

describe('SPA Types and Capabilities — REST E2E contract', () => {
  it('POST /api/v1/spa/types verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/spa/types'); });
  it('GET /api/v1/spa/types verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/spa/types'); });
  it('GET /api/v1/spa/types/:typeId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/spa/types/:typeId'); });
  it('PATCH /api/v1/spa/types/:typeId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('PATCH /api/v1/spa/types/:typeId'); });
  it('POST /api/v1/spa/types/:typeId/activate verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/spa/types/:typeId/activate'); });
  it('POST /api/v1/spa/types/:typeId/archive verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/spa/types/:typeId/archive'); });
  it('POST /api/v1/spa/types/:typeId/restore verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/spa/types/:typeId/restore'); });
  it('GET /api/v1/spa/types/:typeId/capabilities verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/spa/types/:typeId/capabilities'); });
  it('PUT /api/v1/spa/types/:typeId/capabilities/:key verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('PUT /api/v1/spa/types/:typeId/capabilities/:key'); });
});

export {};


