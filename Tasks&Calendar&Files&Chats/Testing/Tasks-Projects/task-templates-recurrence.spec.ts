/**
 * TrueCRM executable contract test for Task Templates & Recurrence Specification.
 * MUST be wired to the real repository implementation.
 */

const contract = (scenario: string): never => {
  throw new Error(`CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario before declaring the module finished.`);
};

describe('Task Templates & Recurrence Specification contract', () => {
  it('Duplicate scheduler delivery.', async () => {
    contract('Duplicate scheduler delivery.');
  });
  it('DST/local-time recurrence.', async () => {
    contract('DST/local-time recurrence.');
  });
  it('Template update vs existing instances.', async () => {
    contract('Template update vs existing instances.');
  });
  it('Failed run retry.', async () => {
    contract('Failed run retry.');
  });
});
