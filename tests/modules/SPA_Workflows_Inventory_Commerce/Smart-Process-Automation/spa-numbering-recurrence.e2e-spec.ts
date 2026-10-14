import { spaHttpContract } from '@/tests/support/spa-http-contract';
const contract = spaHttpContract();

describe('SPA Numbering, Recurrence and Idempotent Generation — REST E2E contract', () => {
  it('GET /api/v1/spa/types/:typeId/numbering verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/spa/types/:typeId/numbering'); });
  it('PUT /api/v1/spa/types/:typeId/numbering verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('PUT /api/v1/spa/types/:typeId/numbering'); });
  it('GET /api/v1/spa/types/:typeId/recurrence verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/spa/types/:typeId/recurrence'); });
  it('POST /api/v1/spa/types/:typeId/recurrence verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/spa/types/:typeId/recurrence'); });
  it('PATCH /api/v1/spa/types/:typeId/recurrence/:ruleId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('PATCH /api/v1/spa/types/:typeId/recurrence/:ruleId'); });
  it('POST /api/v1/spa/types/:typeId/recurrence/:ruleId/pause verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/spa/types/:typeId/recurrence/:ruleId/pause'); });
  it('POST /api/v1/spa/types/:typeId/recurrence/:ruleId/resume verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('POST /api/v1/spa/types/:typeId/recurrence/:ruleId/resume'); });
  it('GET /api/v1/spa/types/:typeId/recurrence/:ruleId/instances verifies response, permission/token, tenant scope, DB effect and outbox', async () => { await contract('GET /api/v1/spa/types/:typeId/recurrence/:ruleId/instances'); });
});

export {};


