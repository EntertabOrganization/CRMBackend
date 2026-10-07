/**
 * TrueCRM executable contract test for Task Time Tracking Specification.
 * MUST be wired to the real repository implementation.
 */

const contract = (scenario: string): never => {
  throw new Error(`CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario before declaring the module finished.`);
};

describe('Task Time Tracking Specification contract', () => {
  it('Timer double-start.', async () => {
    contract('Timer double-start.');
  });
  it('Retry stop.', async () => {
    contract('Retry stop.');
  });
  it('Invalid time range.', async () => {
    contract('Invalid time range.');
  });
  it('Own vs all edit permission.', async () => {
    contract('Own vs all edit permission.');
  });
});
