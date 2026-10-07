/**
 * TrueCRM executable contract test for Booking Pages & Bookings Specification.
 * MUST be wired to the real repository implementation.
 */

const contract = (scenario: string): never => {
  throw new Error(`CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario before declaring the module finished.`);
};

describe('Booking Pages & Bookings Specification contract', () => {
  it('Concurrent same-slot booking.', async () => {
    contract('Concurrent same-slot booking.');
  });
  it('Public token replay.', async () => {
    contract('Public token replay.');
  });
  it('Retry same idempotency key.', async () => {
    contract('Retry same idempotency key.');
  });
  it('Approval vs auto-confirm.', async () => {
    contract('Approval vs auto-confirm.');
  });
});
