/**
 * TrueCRM executable contract test for Document Editing & Locking Specification.
 * MUST be wired to the real repository implementation.
 */

const contract = (scenario: string): never => {
  throw new Error(`CONTRACT TEST NOT WIRED: ${scenario}. Wire this scenario before declaring the module finished.`);
};

describe('Document Editing & Locking Specification contract', () => {
  it('Atomic lock race.', async () => {
    contract('Atomic lock race.');
  });
  it('Expired lock recovery.', async () => {
    contract('Expired lock recovery.');
  });
  it('Complete callback retry creates one version.', async () => {
    contract('Complete callback retry creates one version.');
  });
});
