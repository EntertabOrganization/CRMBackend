/** E2E HTTP contracts: replace fail-closed helper with Supertest + real NestJS app + fixtures.
 * For protected routes create owner, insufficient-role actor, and a separate Workspace; test 401/403/404.
 * For PUBLIC_SCOPED/CUSTOMER_SESSION/PROVIDER_SIGNED use invalid/expired token, replay and rate-limit cases.
 * Verify persisted rows and outbox effects for every write; never make fake PASS tests. */
const contract = (scenario: string): never => { throw new Error(`E2E CONTRACT NOT WIRED: ${scenario}`); };

describe('Stock Reservations, Backorders, Expiry and Allocation — REST E2E contract', () => {
  it('POST /api/v1/inventory/reservations verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/inventory/reservations'); });
  it('GET /api/v1/inventory/reservations verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/reservations'); });
  it('GET /api/v1/inventory/reservations/:reservationId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('GET /api/v1/inventory/reservations/:reservationId'); });
  it('PATCH /api/v1/inventory/reservations/:reservationId verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('PATCH /api/v1/inventory/reservations/:reservationId'); });
  it('POST /api/v1/inventory/reservations/:reservationId/release verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/inventory/reservations/:reservationId/release'); });
  it('POST /api/v1/inventory/reservations/:reservationId/fulfill verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/inventory/reservations/:reservationId/fulfill'); });
  it('POST /api/v1/inventory/reservations/:reservationId/extend verifies response, permission/token, tenant scope, DB effect and outbox', async () => { contract('POST /api/v1/inventory/reservations/:reservationId/extend'); });
});
