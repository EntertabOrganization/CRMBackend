/**
 * TrueCRM executable contract test for Calendar Recurrence & Reminders Specification.
 * MUST be wired to the real repository implementation.
 */

const contract = (scenario: string): never => {
  throw new Error(`CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario before declaring the module finished.`);
};

describe('Calendar Recurrence & Reminders Specification contract', () => {
  it('DST recurrence.', async () => {
    contract('DST recurrence.');
  });
  it('Exception identity.', async () => {
    contract('Exception identity.');
  });
  it('Edit one vs future vs all.', async () => {
    contract('Edit one vs future vs all.');
  });
  it('Retry reminder send.', async () => {
    contract('Retry reminder send.');
  });
});
