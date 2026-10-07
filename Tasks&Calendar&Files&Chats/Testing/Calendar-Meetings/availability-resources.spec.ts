/**
 * TrueCRM executable contract test for Availability & Resources Specification.
 * MUST be wired to the real repository implementation.
 */

const contract = (scenario: string): never => {
  throw new Error(`CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario before declaring the module finished.`);
};

describe('Availability & Resources Specification contract', () => {
  it('Privacy of free/busy.', async () => {
    contract('Privacy of free/busy.');
  });
  it('Concurrent exclusive bookings.', async () => {
    contract('Concurrent exclusive bookings.');
  });
  it('Resource disabled during booking.', async () => {
    contract('Resource disabled during booking.');
  });
});
