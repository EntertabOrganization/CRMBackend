/**
 * TrueCRM executable contract test for Internal Calls Specification.
 * MUST be wired to the real repository implementation.
 */

const contract = (scenario: string): never => {
  throw new Error(`CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario before declaring the module finished.`);
};

describe('Internal Calls Specification contract', () => {
  it('Provider start failure.', async () => {
    contract('Provider start failure.');
  });
  it('End retry.', async () => {
    contract('End retry.');
  });
  it('External token access scope.', async () => {
    contract('External token access scope.');
  });
  it('Recording permission.', async () => {
    contract('Recording permission.');
  });
});
