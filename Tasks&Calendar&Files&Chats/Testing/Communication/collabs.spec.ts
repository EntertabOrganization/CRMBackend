/**
 * TrueCRM executable contract test for Collabs Specification.
 * MUST be wired to the real repository implementation.
 */

const contract = (scenario: string): never => {
  throw new Error(`CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario before declaring the module finished.`);
};

describe('Collabs Specification contract', () => {
  it('Expired/replayed invite.', async () => {
    contract('Expired/replayed invite.');
  });
  it('Existing account acceptance.', async () => {
    contract('Existing account acceptance.');
  });
  it('Guest attempts non-Collab Workspace access.', async () => {
    contract('Guest attempts non-Collab Workspace access.');
  });
});
